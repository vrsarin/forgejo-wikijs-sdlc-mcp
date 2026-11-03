import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TLSSocket } from 'node:tls'
import test from 'node:test'
import { createMcpHttpServer, tlsFilesFromEnvironment } from '../../shared/tls-http.js'

const opensslAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0

test('MCP TLS configuration requires both certificate and key', () => {
  assert.equal(tlsFilesFromEnvironment({}), undefined)
  assert.throws(() => tlsFilesFromEnvironment({ MCP_TLS_CERT_PATH: '/cert' }), /Both/)
  assert.throws(() => tlsFilesFromEnvironment({ MCP_TLS_CERT_PATH: '', MCP_TLS_KEY_PATH: '/key' }), /Both/)
  assert.deepEqual(tlsFilesFromEnvironment({ MCP_TLS_CERT_PATH: '/cert', MCP_TLS_KEY_PATH: '/key' }), {
    certificate: '/cert', key: '/key', mode: 'static'
  })
})

test('ENABLE_TLS selects disabled, static, or Let\'s Encrypt native TLS', () => {
  assert.equal(tlsFilesFromEnvironment({ ENABLE_TLS: 'false' }), undefined)
  assert.throws(() => tlsFilesFromEnvironment({ ENABLE_TLS: 'false', TLS_MODE: 'static' }), /removed/)
  assert.throws(() => tlsFilesFromEnvironment({ ENABLE_TLS: 'true' }), /TLS_MODE/)
  assert.deepEqual(tlsFilesFromEnvironment({
    ENABLE_TLS: 'true', TLS_MODE: 'static', TLS_CERT_PATH: '/run/cert', TLS_KEY_PATH: '/run/key'
  }), { certificate: '/run/cert', key: '/run/key', mode: 'static' })
  assert.deepEqual(tlsFilesFromEnvironment({
    ENABLE_TLS: 'true', TLS_MODE: 'letsencrypt', TLS_DOMAIN: 'mcp.example.com', TLS_EMAIL: 'ops@example.com'
  }), {
    certificate: '/data/letsencrypt/live/mcp.example.com/fullchain.pem',
    key: '/data/letsencrypt/live/mcp.example.com/privkey.pem',
    mode: 'letsencrypt'
  })
  assert.throws(() => tlsFilesFromEnvironment({
    ENABLE_TLS: 'true', TLS_MODE: 'letsencrypt', TLS_DOMAIN: 'localhost', TLS_EMAIL: 'ops@example.com'
  }), /public DNS/)
})

test('MCP HTTP remains available when TLS is not configured', async () => {
  const server = createMcpHttpServer((_request, response) => response.end('ok'), undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const status = await new Promise<number | undefined>((resolve, reject) => {
      httpGet(`http://127.0.0.1:${address.port}/`, (response) => {
        response.resume()
        resolve(response.statusCode)
      }).on('error', reject)
    })
    assert.equal(status, 200)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('MCP HTTPS verifies trust and reloads a renewed certificate', { skip: !opensslAvailable, timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-mcp-tls-test-'))
  const paths = ['first.crt', 'first.key', 'second.crt', 'second.key', 'current.crt', 'current.key']
    .map((name) => join(directory, name))
  const [firstCert, firstKey, secondCert, secondKey, currentCert, currentKey] = paths
  assert(firstCert && firstKey && secondCert && secondKey && currentCert && currentKey)
  let server: ReturnType<typeof createMcpHttpServer> | undefined
  const originalError = console.error
  const reloadErrors: string[] = []
  try {
    for (const [index, [certificate, key]] of [[firstCert, firstKey], [secondCert, secondKey]].entries()) {
      assert(certificate && key)
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', `/CN=SDLC MCP test ${index + 1}`, '-addext', 'subjectAltName=IP:127.0.0.1',
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment',
        '-keyout', key, '-out', certificate
      ], { stdio: 'ignore' })
    }
    copyFileSync(firstCert, currentCert)
    copyFileSync(firstKey, currentKey)
    server = createMcpHttpServer((_request, response) => response.end('ok'), {
      certificate: currentCert, key: currentKey, mode: 'static'
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const ca = [readFileSync(firstCert), readFileSync(secondCert)]
    const request = (trusted: boolean, servername?: string) => new Promise<string>((resolve, reject) => {
      const req = httpsGet({
        host: '127.0.0.1', port: address.port, path: '/', agent: false, ...(trusted ? { ca } : {}),
        ...(servername ? { servername } : {}),
        rejectUnauthorized: true
      }, (response) => {
        if (!(response.socket instanceof TLSSocket)) {
          response.resume()
          reject(new Error('HTTPS response did not use TLS'))
          return
        }
        const certificate = response.socket.getPeerCertificate()
        response.resume()
        if (response.statusCode !== 200 || !certificate.serialNumber) reject(new Error('Invalid HTTPS response'))
        else resolve(certificate.serialNumber)
      })
      req.on('error', reject)
    })
    const original = await request(true)
    await assert.rejects(request(false))
    await assert.rejects(request(true, 'wrong.localhost'))
    console.error = (...args) => { reloadErrors.push(args.join(' ')) }
    copyFileSync(secondKey, currentKey)
    const errorDeadline = Date.now() + 5000
    while (!reloadErrors.length && Date.now() < errorDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert(reloadErrors.some((error) => error.includes('MCP TLS certificate reload failed')))
    assert.equal(await request(true), original, 'A partial renewal must not replace the valid certificate')
    copyFileSync(secondCert, currentCert)
    let renewed = original
    const deadline = Date.now() + 8000
    while (renewed === original && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      renewed = await request(true)
    }
    assert.notEqual(renewed, original, 'The renewed certificate must be loaded without a restart')
  } finally {
    console.error = originalError
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
    for (const path of paths) {
      try { unlinkSync(path) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    rmdirSync(directory)
  }
})
