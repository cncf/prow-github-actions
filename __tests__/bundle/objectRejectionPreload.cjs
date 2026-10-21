// Preloaded into the bundle child with `NODE_OPTIONS=--require` by the object-rejection e2e test.
// The first request whose `METHOD /path` equals OBJECT_REJECT still reaches the fake GitHub (so it is
// recorded and answered) but the bundle is handed a Response whose `status` getter throws the plain object
// parsed from OBJECT_REJECT_VALUE. `status` is the first thing @octokit/request reads after its fetch
// try/catch, so the object rejects the `octokit.*` call as-is instead of being wrapped in a RequestError:
// the only way an Error-less object (a `status`-less or `message`-less rejection) reaches the bundle's
// `getErrorDetails` folds through the real client. Every other request, and the matching request's second
// occurrence, is untouched. Fails closed: without both variables the preload throws instead of silently
// running the test against the real client.
'use strict'

const target = process.env.OBJECT_REJECT
if (!target)
  throw new Error('objectRejectionPreload: OBJECT_REJECT is unset')
const rawValue = process.env.OBJECT_REJECT_VALUE
if (!rawValue)
  throw new Error('objectRejectionPreload: OBJECT_REJECT_VALUE is unset')
const rejection = JSON.parse(rawValue)
if (typeof rejection !== 'object' || rejection === null)
  throw new Error('objectRejectionPreload: OBJECT_REJECT_VALUE must be a JSON object')

const realFetch = globalThis.fetch
let armed = true

globalThis.fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
  const response = await realFetch(input, init)
  if (!armed || `${method} ${new URL(href).pathname}` !== target)
    return response
  armed = false
  await response.body?.cancel()
  return new Proxy(response, {
    get(resp, prop) {
      if (prop === 'status')
        // a non-Error object is the point: the bundle's status-less / message-less folds are what this preload exists to reach
        throw rejection
      const value = Reflect.get(resp, prop, resp)
      return typeof value === 'function' ? value.bind(resp) : value
    },
  })
}
