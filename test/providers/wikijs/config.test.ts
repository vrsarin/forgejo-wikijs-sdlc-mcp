import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../../../src/providers/wikijs/config.js'

test('HTTP is default and Wiki.js downstream configuration is optional', () => {
  const config = loadConfig({ MCP_CLIENT_TOKENS: '{"vscode":"0123456789abcdef"}' })
  assert.equal(config.transport, 'http')
  assert.equal(config.http.auth.mode, 'static')
  assert.equal(config.wikiJsMcpUrl, undefined)
})

test('OIDC mode does not require static client tokens', () => {
  const config = loadConfig({
    MCP_AUTH_MODE: 'oidc',
    MCP_OIDC_ISSUER: 'https://auth.example/realms/sdlc',
    MCP_OIDC_AUDIENCE: 'https://sdlc.example/mcp',
    MCP_OIDC_RESOURCE: 'https://sdlc.example/mcp',
    MCP_OIDC_ROLE_CLIENT_ID: 'wikijs-mcp-vscode'
  })
  assert.equal(config.http.auth.mode, 'oidc')
})

test('ENABLE_OIDC explicitly selects OIDC or unauthenticated development mode', () => {
  assert.equal(loadConfig({ ENABLE_OIDC: 'false' }).http.auth.mode, 'none')
  assert.throws(() => loadConfig({ ENABLE_OIDC: 'invalid' }), /ENABLE_OIDC/)
  assert.equal(loadConfig({
    ENABLE_OIDC: 'true',
    MCP_OIDC_ISSUER: 'https://auth.example/realms/sdlc',
    MCP_OIDC_AUDIENCE: 'https://sdlc.example/mcp',
    MCP_OIDC_RESOURCE: 'https://sdlc.example/mcp',
    MCP_OIDC_REQUIRED_REALM_ROLE: 'mcp-user'
  }).http.auth.mode, 'oidc')
})

test('Wiki.js MCP URL must be the official endpoint path', () => {
  assert.throws(() => loadConfig({ MCP_CLIENT_TOKENS: '{"vscode":"0123456789abcdef"}', WIKIJS_MCP_URL: 'https://wiki.example/api' }), /\/_mcp/)
  assert.equal(loadConfig({ MCP_CLIENT_TOKENS: '{"vscode":"0123456789abcdef"}', WIKIJS_MCP_URL: 'https://wiki.example/_mcp' }).wikiJsMcpUrl?.pathname, '/_mcp')
})

test('stdio uses an explicit Wiki.js token without enabling a shared HTTP credential', () => {
  const stdio = loadConfig({ MCP_TRANSPORT: 'stdio', WIKIJS_MCP_URL: 'https://wiki.example/_mcp', WIKIJS_ACCESS_TOKEN: 'user-token' })
  assert.equal(stdio.transport, 'stdio')
  assert.equal(stdio.wikiJsToken, 'user-token')
  assert.throws(() => loadConfig({ MCP_TRANSPORT: 'stdio', WIKIJS_MCP_URL: 'https://wiki.example/_mcp' }), /WIKIJS_ACCESS_TOKEN/)
  const http = loadConfig({ MCP_CLIENT_TOKENS: '{"vscode":"0123456789abcdef"}', WIKIJS_MCP_URL: 'https://wiki.example/_mcp', WIKIJS_ACCESS_TOKEN: 'must-not-be-shared' })
  assert.equal(http.wikiJsToken, undefined)
})
