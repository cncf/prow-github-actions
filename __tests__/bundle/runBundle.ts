import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const bundlePath = path.resolve(__dirname, '../../dist/index.js')

export interface RunBundleOptions {
  eventName: string
  payload: unknown
  inputs?: Record<string, string>
  apiUrl: string
  repository?: string
}

export interface RunBundleResult {
  status: number | null
  stdout: string
  stderr: string
  errors: string[]
}

// the fake api server runs on this same event loop, so the child must be awaited, not spawnSync'd
export async function runBundle(options: RunBundleOptions): Promise<RunBundleResult> {
  const {
    eventName,
    payload,
    inputs = {},
    apiUrl,
    repository = 'Codertocat/Hello-World',
  } = options

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prow-bundle-'))
  const eventPath = path.join(tmp, 'event.json')
  fs.writeFileSync(eventPath, JSON.stringify(payload))

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: tmp,
    RUNNER_TEMP: tmp,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: repository,
    GITHUB_API_URL: apiUrl,
    GITHUB_SERVER_URL: apiUrl,
    GITHUB_GRAPHQL_URL: `${apiUrl}/graphql`,
    GITHUB_SHA: '0000000000000000000000000000000000000000',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'Codertocat',
  }
  for (const [name, value] of Object.entries(inputs))
    env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value

  try {
    const { status, stdout, stderr } = await new Promise<Omit<RunBundleResult, 'errors'>>((resolve, reject) => {
      const child = spawn(process.execPath, [bundlePath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`dist/index.js did not exit within 20s\nstdout:\n${out}\nstderr:\n${err}`))
      }, 20_000)

      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ status: code, stdout: out, stderr: err })
      })
    })

    const errors = stdout
      .split(/\r?\n/)
      .filter(line => line.startsWith('::error::'))
      .map(line => line.slice('::error::'.length))

    return { status, stdout, stderr, errors }
  }
  finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
