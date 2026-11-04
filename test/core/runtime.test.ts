import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { htmlPage } from '../../src/core/http-util.js'
import { oauthPaths, type ProviderDefinition } from '../../src/core/provider.js'
import { buildBrowserRoutes } from '../../src/core/runtime.js'
import { installShutdown } from '../../src/core/tls-http.js'
import { serveWebHandler } from '../../src/core/web-runtime.js'
import type { CoreConfig } from '../../src/core/config.js'

const provider: ProviderDefinition = { id: 'forgejo', displayName: 'Forgejo', resourceName: 'r', runtimeName: 'rt' }
const config = { transport: 'http', http: { auth: { mode: 'none' } } } as unknown as CoreConfig

test('htmlPage escapes title and message', async () => {
  const body = await htmlPage(502, '<b>t</b>', '<script>alert(1)</script>').text()
  assert(!body.includes('<script>') && !body.includes('<b>'))
  assert(body.includes('&#60;script&#62;'))
})

test('buildBrowserRoutes serves oauth legs for GET only and ignores other paths', async () => {
  const paths = oauthPaths(provider)
  const calls: string[] = []
  const routes = buildBrowserRoutes({
    provider, config,
    oauth: {
      handleStart: () => { calls.push('start'); return new Response('s') },
      handleCallback: async () => { calls.push('callback'); return new Response('c') }
    },
    extra: async (request) => new URL(request.url).pathname === '/extra' ? new Response('x') : undefined
  })
  assert.equal(await (await routes(new Request(`http://localhost${paths.start}`)))?.text(), 's')
  assert.equal(await (await routes(new Request(`http://localhost${paths.callback}`)))?.text(), 'c')
  assert.equal(await (await routes(new Request('http://localhost/extra')))?.text(), 'x')
  assert.equal(await routes(new Request('http://localhost/other')), undefined)
  assert.equal(await routes(new Request(`http://localhost${paths.start}`, { method: 'POST' })), undefined)
  assert.deepEqual(calls, ['start', 'callback'])
})

test('serveWebHandler forwards every Set-Cookie header and the request body', async () => {
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as AddressInfo).port
  probe.close()
  await serveWebHandler(async (request) => {
    const headers = new Headers({ 'content-type': 'text/plain' })
    headers.append('set-cookie', 'a=1; Path=/')
    headers.append('set-cookie', 'b=2; Path=/')
    return new Response(await request.text(), { headers })
  }, { host: '127.0.0.1', port, name: 'test', env: {} })
  const result = await new Promise<{ cookies: string[]; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST' }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ cookies: res.headers['set-cookie'] ?? [], body }))
    })
    req.on('error', reject)
    req.end('ping')
  })
  assert.deepEqual(result.cookies, ['a=1; Path=/', 'b=2; Path=/'])
  assert.equal(result.body, 'ping')
  process.emit('SIGTERM')
})

test('installShutdown runs cleanup once, closes the server, and removes its signal listeners', async () => {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const before = process.listenerCount('SIGTERM')
  let cleanups = 0
  installShutdown(server, () => { cleanups += 1 })
  assert.equal(process.listenerCount('SIGTERM'), before + 1)
  const closed = once(server, 'close')
  process.emit('SIGTERM')
  process.emit('SIGTERM')
  await closed
  assert.equal(cleanups, 1)
  assert.equal(process.listenerCount('SIGTERM'), before)
})
