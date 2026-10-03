// Entry point for `npm run pack:coverage`. ncc reads the nearest tsconfig.json
// above its entry file, so building from here (rather than src/main.ts) picks up
// the sibling tsconfig and its `sourceMap: true` without touching the root
// tsconfig or the committed dist/.
import '../../../src/main'
