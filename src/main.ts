import { actionsPlatform } from './adapters/actions'
import { setPlatform } from './platform'
import { run } from './run'

setPlatform(actionsPlatform())
void run()
