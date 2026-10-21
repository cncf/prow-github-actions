// Preloaded into the bundle child with `NODE_OPTIONS=--require` by the non-Error rejection e2e test.
// The first request whose `METHOD /path` equals NON_ERROR_REJECT still reaches the fake GitHub (so it is
// recorded and answered) but the bundle is handed a Response whose `status` getter throws a plain string.
// `status` is the first thing @octokit/request reads after its fetch try/catch, so the string rejects the
// `octokit.*` call as-is instead of being wrapped in a RequestError: the only way a non-Error reaches the
// bundle's `e instanceof Error ? e.message : String(e)` arms through the real client. Every other request,
// and the matching request's second occurrence, is untouched. Fails closed: without NON_ERROR_REJECT the
// preload throws instead of silently running the test against the real client.
'use strict'

const target = process.env.NON_ERROR_REJECT
if (!target)
  throw new Error('nonErrorRejectionPreload: NON_ERROR_REJECT is unset')

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
        // a non-Error is the point: the bundle's String(e) arms are what this preload exists to reach
        // eslint-disable-next-line no-throw-literal
        throw `${target} rejected with a string, not an Error`
      const value = Reflect.get(resp, prop, resp)
      return typeof value === 'function' ? value.bind(resp) : value
    },
  })
}
