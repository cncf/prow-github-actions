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
- **No scheduled jobs yet.** The `lgtm` merger and `label-sync` on a schedule
  need the scheduler (a follow-up); `label-sync` still runs on a `push` that
  changes `prow.yaml`.
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
| `GITHUB_APP_PRIVATE_KEY` | yes | the PEM; a single line with literal `\n` is accepted |
| `GITHUB_WEBHOOK_SECRET` | yes | the webhook secret |
| `GITHUB_API_URL` | no | the REST root for GitHub Enterprise Server, e.g. `https://ghes.example/api/v3` |
| `PORT` | no | listening port, default `8080` |
| `PROW_COMMANDS` | no | same as the action's `prow-commands` input |
| `PROW_JOBS` | no | same as `jobs` (only `push`-triggered `label-sync` applies today) |
| `PROW_MERGE_METHOD` | no | same as `merge-method` |
| `PROW_CONFIG` | no | same as `config` |
| `PROW_DRY_RUN` | no | same as `dry-run` |
| `CAT_API_KEY` | no | same as `cat-api-key` |

`prow.yaml` is read exactly as for the action: the organization's `.project` or
`.github` repository, then the repository's own file.

## Run

A container image is built from the repository's `Dockerfile`:

```sh
docker build -t prow-app .
docker run -p 8080:8080 \
  -e GITHUB_APP_ID=... -e GITHUB_WEBHOOK_SECRET=... \
  -e GITHUB_APP_PRIVATE_KEY="$(cat prow.private-key.pem)" \
  prow-app
```

`GET /healthz` answers `ok`. `POST /webhook` verifies `X-Hub-Signature-256`,
answers `202` at once and handles the event afterwards; a redelivered
`X-GitHub-Delivery` id is handled once per process. Run one replica: the
delivery memory and the per-event ordering are in-process. For local testing,
relay deliveries with [smee.io](https://smee.io) or `gh webhook forward`.

A minimal Kubernetes Deployment is one container with the variables above from a
Secret and a Service in front of port 8080; put your usual Ingress/TLS in front.

## How it fits the code

`src/adapters/app/` implements the `Platform` the handlers run against (see
[overview](./overview.md#runtime-adapters)); `src/server/node.ts` is the HTTP
server. `npm run pack:server` builds `dist-server/index.js`, which is not
committed.
