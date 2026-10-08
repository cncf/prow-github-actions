// Preloaded into the bundle child with `NODE_OPTIONS=--require` by the /meow e2e tests.
// Rewrites requests for the cat api origin to the stub server named by CAT_API_URL and
// leaves every other fetch (and every option: headers, redirect, signal) untouched.
// Fails closed: without CAT_API_URL a cat api request throws instead of leaving the test.
'use strict'

const catApiOrigin = 'https://api.thecatapi.com'
const stubUrl = process.env.CAT_API_URL
const realFetch = globalThis.fetch

globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith(catApiOrigin)) {
    if (!stubUrl)
      throw new Error(`catApiPreload: CAT_API_URL is unset, refusing to call ${url}`)
    return realFetch(stubUrl + url.slice(catApiOrigin.length), init)
  }
  return realFetch(input, init)
}
