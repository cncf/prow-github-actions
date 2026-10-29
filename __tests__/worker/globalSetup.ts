import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

// __tests__/worker runs the Worker bundle; build it when it is missing (CI does not run `npm run pack`
// before the tests) so the suite never silently skips
export default function setup(): void {
  const bundle = path.resolve('dist-worker/worker.js')
  if (!existsSync(bundle)) {
    execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', 'dist-worker'], { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  }
}
