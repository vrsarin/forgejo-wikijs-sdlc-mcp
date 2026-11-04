import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { after, before } from 'node:test'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { OidcJwtVerifier, type OidcAuthConfig } from '../../src/core/auth.js'

let server: Server, issuer: string, privateKey: CryptoKey
before(async () => {
  const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/sdlc`
})
after(() => { server.close() })

const config = (): OidcAuthConfig => ({ mode: 'oidc', issuer: new URL(issuer), audience: 'https://forgejo-mcp.example/mcp', resource: new URL('https://forgejo-mcp.example/mcp'), roleClientId: 'forgejo-mcp', requiredRole: 'mcp-user' })
const sign = (claims: Record<string, unknown>, { aud = 'https://forgejo-mcp.example/mcp', iss = issuer, exp = '5m' } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(iss).setAudience(aud).setSubject('user-1').setExpirationTime(exp).sign(privateKey)
const roles = { resource_access: { 'forgejo-mcp': { roles: ['mcp-user'] } } }

test('a token bound to this MCP resource with the required role is accepted', async () => {
  const info = await new OidcJwtVerifier(config()).verifyAccessToken(await sign({ ...roles, preferred_username: 'vivek', scope: 'openid profile' }))
  assert.equal(info.clientId, 'vivek')
  assert.deepEqual(info.scopes, ['openid', 'profile'])
})

test('a token minted for the other MCP server is rejected', async () => {
  await assert.rejects(async () => new OidcJwtVerifier(config()).verifyAccessToken(await sign(roles, { aud: 'https://sdlc-mcp.example/mcp' })))
})

test('only the configured gateway exchange audience is additionally accepted', async () => {
  const verifier = new OidcJwtVerifier({ ...config(), additionalAudiences: ['forgejo-mcp-server'] })
  assert.equal((await verifier.verifyAccessToken(await sign(roles, { aud: 'forgejo-mcp-server' }))).extra?.subject, 'user-1')
  await assert.rejects(async () => verifier.verifyAccessToken(await sign(roles, { aud: 'wikijs-sdlc-mcp-server' })))
})

test('wrong issuer, missing role, and expired tokens are rejected', async () => {
  const verifier = new OidcJwtVerifier(config())
  await assert.rejects(async () => verifier.verifyAccessToken(await sign(roles, { iss: 'http://evil.example/realms/sdlc' })))
  await assert.rejects(async () => verifier.verifyAccessToken(await sign({ resource_access: { 'forgejo-mcp': { roles: ['other'] } } })), /required MCP role/)
  await assert.rejects(async () => verifier.verifyAccessToken(await sign({})), /required MCP role/)
  await assert.rejects(async () => verifier.verifyAccessToken(await sign(roles, { exp: '-1m' })))
})

test('a realm-role configuration is honored', async () => {
  const verifier = new OidcJwtVerifier({ mode: 'oidc', issuer: new URL(issuer), audience: 'https://forgejo-mcp.example/mcp', resource: new URL('https://forgejo-mcp.example/mcp'), requiredRealmRole: 'mcp-forgejo', requiredRole: 'mcp-user' })
  assert((await verifier.verifyAccessToken(await sign({ realm_access: { roles: ['mcp-forgejo'] } }))).expiresAt)
  await assert.rejects(async () => verifier.verifyAccessToken(await sign(roles)), /required MCP role/)
})

test('discovery access requires both the configured client and discovery role', async () => {
  const verifier = new OidcJwtVerifier({ ...config(), discoveryClientId: 'mcp-gateway-discovery' })
  const discovery = { azp: 'mcp-gateway-discovery', realm_access: { roles: ['mcp-discovery'] } }
  assert.equal((await verifier.verifyAccessToken(await sign(discovery))).extra?.discovery, true)
  await assert.rejects(async () => verifier.verifyAccessToken(await sign({ ...discovery, azp: 'other' })))
  await assert.rejects(async () => verifier.verifyAccessToken(await sign({ azp: 'mcp-gateway-discovery', ...roles })))
  await assert.rejects(async () => new OidcJwtVerifier(config()).verifyAccessToken(await sign(discovery)))
})

test('a configured group is required in addition to the user role', async () => {
  const verifier = new OidcJwtVerifier({ ...config(), requiredGroup: 'home-assistant-users' })
  assert((await verifier.verifyAccessToken(await sign({ ...roles, groups: ['home-assistant-users'] }))).expiresAt)
  await assert.rejects(async () => verifier.verifyAccessToken(await sign({ ...roles, groups: [] })), /required MCP role/)
  await assert.rejects(async () => verifier.verifyAccessToken(await sign(roles)), /required MCP role/)
})

test('the discovery identity is not subject to the interactive user group', async () => {
  const verifier = new OidcJwtVerifier({ ...config(), requiredGroup: 'home-assistant-users', discoveryClientId: 'mcp-gateway-discovery' })
  const discovery = { azp: 'mcp-gateway-discovery', realm_access: { roles: ['mcp-discovery'] } }
  assert.equal((await verifier.verifyAccessToken(await sign(discovery))).extra?.discovery, true)
})
