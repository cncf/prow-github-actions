import process from 'node:process'

import { main, runCronOnce } from './node'

if (process.argv[2] === 'cron') {
  runCronOnce().then((code) => {
    process.exitCode = code
  })
}
else {
  main()
}
