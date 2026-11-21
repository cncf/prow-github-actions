import type { ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire, isBuiltin } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { sign } from '@octokit/webhooks-methods'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The Dockerfile ships `ncc build src/server/main.ts -o dist-server` and runs it on an image
// that never installs node_modules. dist-server/ is not committed, so this builds the same
// bundle into a directory outside the repository (where nothing resolves a leaked require)
// and boots it there, the way the container does.
const ncc = createRequire(import.meta.url).resolve('@vercel/ncc/dist/ncc/cli.js')
const root = path.resolve(__dirname, '../..')
const secret = 'bundle-secret'
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })

let out: string
let child: ChildProcess | undefined
let port: number
const stdout: string[] = []

async function signedPost(eventName: string, body: string, signature?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': 'delivery-1',
      'x-github-event': eventName,
      ...(signature === undefined ? {} : { 'x-hub-signature-256': signature }),
    },
    body,
  })
}

describe('dist-server/index.js, built and run outside the repository', () => {
  beforeAll(async () => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'prow-server-bundle-'))
    execFileSync(process.execPath, [ncc, 'build', 'src/server/main.ts', '-o', out, '--quiet'], { cwd: root, stdio: 'inherit' })

    port = 18000 + Math.floor(Math.random() * 1000)
    child = spawn(process.execPath, ['index.js'], {
      cwd: out,
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_APP_ID: '4242',
        GITHUB_APP_PRIVATE_KEY: privateKey,
        GITHUB_WEBHOOK_SECRET: secret,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stderr: string[] = []
    child.stderr!.on('data', chunk => stderr.push(String(chunk)))
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.on('data', (chunk) => {
        stdout.push(String(chunk))
        if (stdout.join('').includes(`listening on :${port}`)) {
          resolve()
        }
      })
      child!.on('exit', code => reject(new Error(`bundle exited with ${code} before listening\n${stderr.join('')}`)))
    })
  }, 120_000)

  afterAll(() => {
    child?.kill()
    fs.rmSync(out, { recursive: true, force: true })
  })

  it('requires only node built-in modules', () => {
    const source = fs.readFileSync(path.join(out, 'index.js'), 'utf8')
    const specifiers = [...source.matchAll(/\brequire\((["'])([^"']+)\1\)/g)].map(match => match[2])

    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter(specifier => !isBuiltin(specifier))).toEqual([])
  })

  it('announces the port as a json line on stdout', () => {
    const lines = stdout.join('').trim().split('\n').map(line => JSON.parse(line))

    expect(lines).toContainEqual(expect.objectContaining({ level: 'info', message: `listening on :${port}` }))
    expect(lines.every(line => typeof line.time === 'string')).toBe(true)
  })

  it('serves /healthz', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })

  it('answers a signed ping with pong', async () => {
    const body = JSON.stringify({ zen: 'bundled' })

    const response = await signedPost('ping', body, await sign(secret, body))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('pong')
  })

  it('rejects an unsigned delivery with 401 and logs the rejection', async () => {
    const response = await signedPost('ping', JSON.stringify({ zen: 'unsigned' }))

    expect(response.status).toBe(401)
    expect(await response.text()).toBe('bad signature')
    await expect.poll(() => stdout.join('')).toContain('"message":"rejected: bad signature"')
  })

  // The Dockerfile's HEALTHCHECK is the only probe a `docker run` of the image has (the chart
  // brings its own httpGet probes), and the release workflow builds and pushes the image
  // without ever running it. Run the exact exec-form command the Dockerfile ships against the
  // bundle booted above, the way the Docker daemon does, with PORT pointing where the server is.
  describe('the Dockerfile runs this bundle and probes it', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').split('\n')
    const instruction = (name: string): string => {
      const lines = dockerfile.filter(line => line.startsWith(`${name} `))
      expect(lines, `exactly one ${name} instruction`).toHaveLength(1)
      return lines[0]
    }
    // `CMD ["node", "-e", "..."]` — the JSON array is the exec form Docker runs without a shell
    const execForm = (line: string): string[] => JSON.parse(line.slice(line.indexOf('['))) as string[]
    const healthcheck = execForm(instruction('HEALTHCHECK'))

    // async so the in-process fake servers below can answer while the probe runs
    const probe = (env: Record<string, string>): Promise<{ status: number | null, stderr: string }> => {
      expect(healthcheck[0]).toBe('node')
      const child = spawn(process.execPath, healthcheck.slice(1), { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
      const stderr: string[] = []
      child.stderr.on('data', chunk => stderr.push(String(chunk)))
      return new Promise(resolve => child.on('exit', status => resolve({ status, stderr: stderr.join('') })))
    }
    const serve = async (handler: http.RequestListener): Promise<{ port: number, close: () => Promise<void> }> => {
      const server = http.createServer(handler)
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      return {
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
      }
    }

    it('the HEALTHCHECK exits 0 against the listening bundle', async () => {
      const result = await probe({ PORT: String(port) })

      expect([result.status, result.stderr]).toEqual([0, ''])
    })

    it('the HEALTHCHECK exits 1 when nothing listens on PORT', async () => {
      const closed = await serve(() => {})
      await closed.close()

      expect((await probe({ PORT: String(closed.port) })).status).toBe(1)
    })

    it('the HEALTHCHECK exits 1 when /healthz answers outside 2xx', async () => {
      const paths: string[] = []
      const failing = await serve((request, response) => {
        paths.push(request.url ?? '')
        response.writeHead(503).end('shutting down')
      })
      try {
        expect((await probe({ PORT: String(failing.port) })).status).toBe(1)
        expect(paths).toEqual(['/healthz'])
      }
      finally {
        await failing.close()
      }
    })

    it('the HEALTHCHECK falls back to the port the image EXPOSEs and sets as PORT', () => {
      const exposed = instruction('EXPOSE').split(' ')[1]
      const env = instruction('ENV')

      expect(exposed).toBe('8080')
      expect(env).toContain(`PORT=${exposed}`)
      expect(healthcheck[2]).toContain(`process.env.PORT||${exposed}`)
    })

    it('the CMD starts the bundle pack:server builds, from where the runtime stage copies it', () => {
      const scripts = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

      expect(scripts['pack:server']).toBe('ncc build src/server/main.ts -o dist-server')
      expect(instruction('COPY --from=build')).toBe('COPY --from=build /app/dist-server ./dist-server')
      expect(execForm(instruction('CMD'))).toEqual(['node', 'dist-server/index.js'])
      expect(fs.existsSync(path.join(out, 'index.js'))).toBe(true)
    })
  })
})
