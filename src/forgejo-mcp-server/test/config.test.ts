import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../src/config.js'

const base = {
  FORGEJO_URL: 'https://forgejo.example',
  FORGEJO_ACCESS_TOKEN: 'provider-secret',
  MCP_CLIENT_TOKENS: '{"vscode":"0123456789abcdef"}'
}

test('HTTP is the default and requires client authentication', () => {
  const config = loadConfig(base)
  assert.equal(config.transport, 'http')
  assert.equal(config.http.auth.mode, 'static')
  assert.equal(config.http.auth.mode === 'static' && config.http.auth.clientTokens.get('vscode'), '0123456789abcdef')
  assert.equal(config.writesEnabled, false)
})

test('OIDC mode requires an issuer, audience, resource, and role client', () => {
  const config = loadConfig({
    ...base,
    MCP_AUTH_MODE: 'oidc',
    MCP_CLIENT_TOKENS: undefined,
    MCP_OIDC_ISSUER: 'https://auth.example/realms/sdlc',
    MCP_OIDC_AUDIENCE: 'https://mcp.example/mcp',
    MCP_OIDC_RESOURCE: 'https://mcp.example/mcp',
    MCP_OIDC_ROLE_CLIENT_ID: 'forgejo-mcp-vscode'
  })
  assert.equal(config.http.auth.mode, 'oidc')
})

test('ENABLE_OIDC explicitly selects OIDC or unauthenticated development mode', () => {
  assert.equal(loadConfig({ ...base, ENABLE_OIDC: 'false', MCP_CLIENT_TOKENS: undefined }).http.auth.mode, 'none')
  assert.throws(() => loadConfig({ ...base, ENABLE_OIDC: 'invalid' }), /ENABLE_OIDC/)
  assert.throws(() => loadConfig({ ...base, ENABLE_OIDC: 'true', MCP_AUTH_MODE: 'static' }), /conflicts/)
  assert.equal(loadConfig({
    ...base,
    ENABLE_OIDC: 'true',
    MCP_CLIENT_TOKENS: undefined,
    MCP_OIDC_ISSUER: 'https://auth.example/realms/sdlc',
    MCP_OIDC_AUDIENCE: 'https://mcp.example/mcp',
    MCP_OIDC_RESOURCE: 'https://mcp.example/mcp',
    MCP_OIDC_REQUIRED_REALM_ROLE: 'mcp-user'
  }).http.auth.mode, 'oidc')
})

test('OIDC mode can authorize a realm role for dynamically identified clients', () => {
  const config = loadConfig({
    ...base,
    MCP_AUTH_MODE: 'oidc',
    MCP_CLIENT_TOKENS: undefined,
    MCP_OIDC_ISSUER: 'https://auth.example/realms/sdlc',
    MCP_OIDC_AUDIENCE: 'https://mcp.example/mcp',
    MCP_OIDC_RESOURCE: 'https://mcp.example/mcp',
    MCP_OIDC_REQUIRED_REALM_ROLE: 'forgejo-mcp-user'
  })
  assert.equal(config.http.auth.mode === 'oidc' && config.http.auth.requiredRealmRole, 'forgejo-mcp-user')
})

test('stdio remains an explicit development fallback', () => {
  const config = loadConfig({ ...base, MCP_TRANSPORT: 'stdio', MCP_CLIENT_TOKENS: undefined })
  assert.equal(config.transport, 'stdio')
})

test('non-local provider HTTP requires an explicit opt-in', () => {
  assert.throws(() => loadConfig({ ...base, FORGEJO_URL: 'http://forgejo:3000' }), /HTTPS/)
  assert.equal(loadConfig({ ...base, FORGEJO_URL: 'http://forgejo:3000', FORGEJO_ALLOW_INSECURE_HTTP: 'true' }).forgejo.baseUrl.hostname, 'forgejo')
})

test('the shared Forgejo token is only used for stdio; HTTP callers bring their own', () => {
  const base = { FORGEJO_URL: 'https://forgejo.example', MCP_CLIENT_TOKENS: '{"vscode":"0123456789abcdef"}', FORGEJO_ACCESS_TOKEN: 'shared' }
  assert.equal(loadConfig(base).forgejo.token, undefined)
  assert.equal(loadConfig({ ...base, MCP_TRANSPORT: 'stdio' }).forgejo.token, 'shared')
  const { FORGEJO_ACCESS_TOKEN: _omitted, ...withoutToken } = base
  assert.doesNotThrow(() => loadConfig(withoutToken))
  assert.throws(() => loadConfig({ ...withoutToken, MCP_TRANSPORT: 'stdio' }), /FORGEJO_ACCESS_TOKEN/)
})
