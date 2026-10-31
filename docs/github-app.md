# Running Prow as a GitHub App

> **Beta.** The App receives the same events and runs the same handlers as the
> action; it is new, and its deployment story is still settling. The action
> remains the recommended install.

The action runs inside each repository's own workflow. The App instead receives
webhooks for every repository an organization installs it on, mints an
installation token per event, and runs the same `/commands`, labelling, OWNERS
and automatic-merging code. Differences that matter:

- **One install, no workflow file.** Nothing to copy into each repository.
- **Fork pull requests are first class.** The installation token can write on a
  fork's `pull_request` and `pull_request_review` events, so the `sweep` job the
  action needs for them is unnecessary.
- **Events the App creates trigger your workflows.** Actions taken with
  `GITHUB_TOKEN` do not; an App's do, so a label the App applies can start CI.
- **Scheduled jobs run for every installation at once.** `node dist-server/index.js cron`
  runs the `PROW_JOBS` jobs once for each repository the App is installed on and
  exits; or set `PROW_CRON_INTERVAL` to run them inside the server. See
  [Scheduled jobs](#scheduled-jobs).
- **`/label-sync` replaces the *Run workflow* button.** A collaborator comments
  it on any issue or pull request; list it in `PROW_COMMANDS` to enable it.
- **No run log.** Each event logs JSON lines to stdout; there is no Actions UI.

## Register the App

*Settings → Developer settings → GitHub Apps → New GitHub App*.

| Setting | Value |
|---|---|
| Webhook URL | `https://<your host>/webhook` |
| Webhook secret | a long random string; keep it for `GITHUB_WEBHOOK_SECRET` |
| Repository permissions | Contents **write**, Issues **write**, Pull requests **write**, Commit statuses **write**, Actions **write**, Checks **read**, Metadata **read** |
| Organization permissions | Members **read** (for `@org/team` entries in OWNERS) |
| Subscribe to events | Issues, Issue comment, Pull request, Pull request review, Check suite, Status, Push |

Generate a private key and download it. Note the App ID. Install the App on
the organization (all repositories, or the ones Prow should manage).

## Configure

| Variable | Required | Meaning |
|---|---|---|
| `GITHUB_APP_ID` | yes | the App ID |
| `GITHUB_APP_PRIVATE_KEY` | yes | the PEM; a single line with literal `\n` is accepted. PKCS#1 as GitHub serves it works on Node; Workers need PKCS#8 (see below) |
| `GITHUB_WEBHOOK_SECRET` | yes | the webhook secret |
| `GITHUB_API_URL` | no | the REST root for GitHub Enterprise Server, e.g. `https://ghes.example/api/v3` |
| `PORT` | no | listening port, default `8080` |
| `REDIS_URL` | for several replicas | shared dedupe and locks, see [One replica or several](#one-replica-or-several) |
| `PROW_SHUTDOWN_GRACE_MS` | no | how long `SIGTERM` waits for in-flight events, default `25000` |
| `PROW_COMMANDS` | no | same as the action's `prow-commands` input |
| `PROW_JOBS` | no | same as `jobs`; what the scheduler runs. Default `lgtm` |
| `PROW_CRON_INTERVAL` | no | minutes between scheduled runs inside the server; unset means none (use the `cron` command) |
| `PROW_MERGE_METHOD` | no | same as `merge-method` |
| `PROW_CONFIG` | no | same as `config` |
| `PROW_DRY_RUN` | no | same as `dry-run` |
| `CAT_API_KEY` | no | same as `cat-api-key` |

`prow.yaml` is read exactly as for the action: the organization's `.project` or
`.github` repository, then the repository's own file.

## Run

### Kubernetes

The chart and the image are published with every release, signed with cosign and
carrying SLSA provenance:

```sh
kubectl create secret generic prow-github \
  --from-literal=appId=123456 \
  --from-literal=webhookSecret="$(openssl rand -hex 32)" \
  --from-file=privateKey=prow.private-key.pem

helm install prow oci://ghcr.io/cncf/prow-github-actions/charts/prow-github-app \
  --version 3.4.0 \
  --set github.existingSecret=prow-github \
  --set ingress.enabled=true --set ingress.className=nginx \
  --set 'ingress.hosts[0].host=prow.example.com' \
  --set 'ingress.hosts[0].paths[0].path=/webhook' --set 'ingress.hosts[0].paths[0].pathType=Exact'
```

The webhook URL for the App is `https://prow.example.com/webhook`. The chart
creates a Deployment (liveness `/healthz`, readiness `/readyz`), a Service, the
Ingress above, a ServiceAccount, and a CronJob that runs the scheduled jobs
hourly (`cronjob.schedule`, `prow.jobs`). The `prow.*` values are the action's
inputs under other names; `github.apiUrl` points at a GitHub Enterprise Server.
`helm show values oci://ghcr.io/cncf/prow-github-actions/charts/prow-github-app --version 3.4.0`
lists everything.

Two topologies:

```yaml
# one replica: nothing shared, Recreate strategy; the default
replicaCount: 1
```

```yaml
# several replicas: a Redis every replica shares; the chart refuses replicaCount > 1 without one
replicaCount: 3
redis:
  url: rediss://my-redis:6380 # or existingSecret / existingSecretKey
```

The chart ships no Redis: any Redis 6+ or Valkey will do, and for development
`kubectl create deployment redis --image=redis:7-alpine --port=6379 && kubectl expose deployment redis`
gives one at `redis://redis:6379`. Upgrade with `helm upgrade prow … --version X.Y.Z`;
the pods roll when configuration or inline credentials change.

Verify what you install:

```sh
cosign verify ghcr.io/cncf/prow-github-actions:3.4.0 \
  --certificate-identity-regexp="https://github.com/cncf/prow-github-actions" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com"
gh attestation verify oci://ghcr.io/cncf/prow-github-actions:3.4.0 --repo cncf/prow-github-actions
gh attestation verify oci://ghcr.io/cncf/prow-github-actions/charts/prow-github-app:3.4.0 --repo cncf/prow-github-actions
```

### A container anywhere else

```sh
docker run -p 8080:8080 \
  -e GITHUB_APP_ID=... -e GITHUB_WEBHOOK_SECRET=... \
  -e GITHUB_APP_PRIVATE_KEY="$(cat prow.private-key.pem)" \
  ghcr.io/cncf/prow-github-actions:3.4.0
```

(or `docker build -t prow-app .` from the repository.) `GET /healthz` answers
`ok` (liveness); `GET /readyz` answers `ok` once the stores below are reachable
(readiness). `POST /webhook` verifies `X-Hub-Signature-256`, answers `202` at
once and handles the event afterwards. A pull request's events run one at a
time, in order, as the action's `concurrency:` group arranges; a redelivered
`X-GitHub-Delivery` id is handled once. On `SIGTERM` the server stops accepting,
lets in-flight events finish (`PROW_SHUTDOWN_GRACE_MS`, default 25 000) and
exits. For local testing, relay deliveries with [smee.io](https://smee.io) or
`gh webhook forward`.

### One replica or several

| | one replica | several replicas |
|---|---|---|
| delivery dedupe and the per-pull-request lock | in process | in a Redis every replica shares |
| configuration | nothing | `REDIS_URL=redis://host:6379` (or `rediss://`) |

Without `REDIS_URL`, two replicas would each handle a redelivery and could race
on one pull request; the server warns at startup when `PROW_REPLICAS` is above
1 and `REDIS_URL` is unset. Any Redis 6+ or Valkey works; the server uses two
keys per event (`prow:delivery:<id>`, a day; `prow:lock:<owner/repo#n>`, a
minute at most) and nothing else.

## Scheduled jobs

The action's `schedule:` trigger has no webhook equivalent, so the App runs the
jobs itself:

```sh
# once, for every installation and repository, then exit 0 (1 if any repository failed)
node dist-server/index.js cron
```

The chart's CronJob does exactly this (`cronjob.schedule`, hourly by default).
For a single container with no scheduler, `PROW_CRON_INTERVAL=60` runs the jobs
inside the server every hour instead.

Each repository runs under its own installation token and state, four at a time;
a repository that fails is logged and reported, and never stops the others.
Suspended installations and archived repositories are skipped. An installation whose token
cannot be minted or whose repositories cannot be listed is logged (`installationId` and the
error) and skipped; the other installations still run.

`PROW_JOBS` defaults to `lgtm`, the merger. The action also offers `sweep`, which
exists because `GITHUB_TOKEN` cannot write on a fork's `pull_request` events; the
App's token can, so the App handles those events directly and does not need
`sweep`. `label-sync` on a schedule works but is usually better run on a `push`
to `prow.yaml` (automatic) or with the `/label-sync` command.

## Cloudflare Workers

The same adapter runs as a Worker, with the platform's services standing in
for what a container does in memory:

| Concern | Container | Worker |
|---|---|---|
| Delivery dedupe | process memory | KV (`DELIVERIES`, 24 h) |
| Ordering a pull request's events | one replica | a Durable Object per pull request (`PULL_REQUEST_LOCK`) |
| Scheduled jobs | `cron` command / interval | Cron Trigger → one Queue message per installation |
| The `require_matching_label` grace period | waits in place | a delayed Queue message resumes the check |

Set up once, from the repository (`wrangler.toml` is committed):

```sh
npx wrangler kv namespace create DELIVERIES     # paste the id into wrangler.toml
npx wrangler queues create prow-jobs
openssl pkcs8 -topk8 -nocrypt -in prow.private-key.pem -out prow.pkcs8.pem   # Workers sign with WebCrypto, which needs PKCS#8
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < prow.pkcs8.pem
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler deploy
```

The webhook URL is `https://<worker>.<account>.workers.dev/webhook`. `PROW_*`
variables go under `[vars]`. Logs are JSON lines in Workers Logs. The Worker
answers `202` and finishes the event in the background; an event that needs
longer than the platform allows after the response is not a concern today
(tide's mergeability retries total seven seconds).

## How it fits the code

`src/adapters/app/` implements the `Platform` the handlers run against (see
[overview](./overview.md#runtime-adapters)); `src/server/node.ts` is the HTTP
server and `src/server/worker.ts` the Worker. `npm run pack:server` builds
`dist-server/index.js` and `npm run pack:worker` `dist-worker/worker.js`; neither
is committed. `__tests__/worker/` runs the Worker bundle in miniflare;
`wranglerConfig.test.ts` there also runs it under the bindings `wrangler.toml`
declares and keeps the file in step with what `src/server/worker.ts` reads and
with the setup commands above.
