import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { HomeAssistantVerifier } from '../src/auth.mjs'

let key, verifier
const issuer = 'http://auth.localhost/realms/sdlc'
const audience = 'homeassistant-mcp-server'
before(async () => {
  const keys = await generateKeyPair('RS256')
  key = keys.privateKey
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256', use: 'sig' }
  verifier = new HomeAssistantVerifier({ issuer, audience, discoveryClient: 'mcp-gateway-discovery', jwks: createLocalJWKSet({ keys: [jwk] }) })
})
async function token(claims, aud = audience) {
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(issuer).setAudience(aud).setSubject('subject').setExpirationTime('5m').sign(key)
}

test('requires both the MCP role and Home Assistant group for users', async () => {
  const claims = { realm_access: { roles: ['mcp-user'] }, groups: ['home-assistant-users'] }
  assert.equal((await verifier.verify(await token(claims))).discovery, false)
  await assert.rejects(async () => verifier.verify(await token({ ...claims, groups: [] })))
  await assert.rejects(async () => verifier.verify(await token({ ...claims, realm_access: { roles: [] } })))
  await assert.rejects(async () => verifier.verify(await token(claims, 'wikijs-sdlc-mcp-server')))
})

test('discovery client is limited to its dedicated realm role', async () => {
  const claims = { azp: 'mcp-gateway-discovery', realm_access: { roles: ['mcp-discovery'] } }
  assert.equal((await verifier.verify(await token(claims))).discovery, true)
  await assert.rejects(async () => verifier.verify(await token({ ...claims, realm_access: { roles: ['mcp-user'] }, groups: ['home-assistant-users'] })))
})
