import assert from 'node:assert/strict'
import test from 'node:test'
import { ForgejoClient } from '../../../src/providers/forgejo/forgejo.js'
import { createForgejoServer } from '../../../src/providers/forgejo/server.js'

interface Registered { inputSchema: any; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; handler: (input: any) => Promise<any> }
const WRITE_TOOLS = ['create_issue', 'update_issue', 'add_issue_comment', 'add_issue_dependency', 'remove_issue_dependency', 'set_issue_labels', 'add_time_entry', 'upload_issue_attachment', 'create_pull_request', 'update_pull_request', 'create_pull_review', 'request_pull_reviewers', 'mark_notification_read', 'test_webhook']

function tools(writesEnabled: boolean, fetch: typeof globalThis.fetch = async () => Response.json({})): Record<string, Registered> {
  const client = new ForgejoClient({ baseUrl: new URL('https://forgejo.example'), token: 'secret', allowedRepositories: new Set(['team/project']), fetch })
  return (createForgejoServer(client, writesEnabled) as unknown as { _registeredTools: Record<string, Registered> })._registeredTools
}
const validate = (tool: Registered, input: unknown) => tool.inputSchema['~standard'].validate(input) as Promise<{ issues?: unknown[] }>

test('mutation tools are omitted unless writes are enabled', () => {
  const disabled = tools(false)
  const enabled = tools(true)
  for (const name of WRITE_TOOLS) {
    assert.equal(disabled[name], undefined, `${name} must be hidden when writes are disabled`)
    assert(enabled[name], `${name} must be registered when writes are enabled`)
  }
  assert(disabled.get_issue && disabled.get_repository)
  assert.equal(Object.keys(disabled).length + WRITE_TOOLS.length, Object.keys(enabled).length)
})

test('read tools are read-only and write tools are not', () => {
  const all = tools(true)
  for (const [name, tool] of Object.entries(all)) {
    assert.equal(tool.annotations?.readOnlyHint, !WRITE_TOOLS.includes(name), name)
    assert.notEqual(tool.annotations?.destructiveHint, true, name)
  }
})

test('every write tool requires confirmation and a reason', async () => {
  const all = tools(true)
  for (const name of WRITE_TOOLS) {
    const tool = all[name]!
    const base = { owner: 'team', repo: 'project', index: 1, id: 1, title: 'x', head: 'a', base: 'b', event: 'COMMENT', body: 'x', labels: [], seconds: 1, filename: 'a.txt', mediaType: 'text/plain', base64: 'AA==', dependencyOwner: 'team', dependencyRepo: 'project', dependencyIndex: 2, idempotencyKey: 'key-1' }
    assert.equal((await validate(tool, { ...base, confirmed: true, reason: 'because' })).issues, undefined, `${name} accepts a confirmed call`)
    assert((await validate(tool, { ...base, reason: 'because' })).issues, `${name} rejects a missing confirmation`)
    assert((await validate(tool, { ...base, confirmed: false, reason: 'because' })).issues, `${name} rejects confirmed=false`)
    assert((await validate(tool, { ...base, confirmed: true })).issues, `${name} rejects a missing reason`)
  }
})

test('create tools require an idempotency key', async () => {
  const all = tools(true)
  for (const name of ['create_issue', 'add_issue_comment', 'create_pull_request']) {
    const input = { owner: 'team', repo: 'project', index: 1, title: 'x', body: 'x', head: 'a', base: 'b', confirmed: true, reason: 'because' }
    assert((await validate(all[name]!, input)).issues, `${name} requires idempotencyKey`)
  }
})

test('owner and repo reject path-traversal input', async () => {
  const issues = (await validate(tools(false).get_issue!, { owner: '../etc', repo: 'project', index: 1 })).issues
  assert(issues)
})

test('tool handlers reject repositories outside the allowlist', async () => {
  await assert.rejects(() => tools(false).get_issue!.handler({ owner: 'other', repo: 'repo', index: 1 }), /not in SDLC_ALLOWED_REPOSITORIES/)
})

test('update_issue refuses an empty change', async () => {
  await assert.rejects(() => tools(true).update_issue!.handler({ owner: 'team', repo: 'project', index: 1, reason: 'noop', confirmed: true }), /At least one issue field/)
})

test('mutation results report verified read-back with the reason', async () => {
  const result = await tools(true).set_issue_labels!.handler({ owner: 'team', repo: 'project', index: 1, labels: [3], reason: 'triage', confirmed: true })
  const body = JSON.parse(result.content[0].text)
  assert.equal(body.outcome, 'verified')
  assert.equal(body.reason, 'triage')
})

test('list_notifications requires owner and repo together', async () => {
  await assert.rejects(() => tools(false).list_notifications!.handler({ owner: 'team', all: false }), /supplied together/)
})

test('with per-user tokens required, calls without a token are refused and calls with one use it', async () => {
  const seen: Array<string | null> = []
  const client = new ForgejoClient({ baseUrl: new URL('https://forgejo.example'), token: undefined, allowedRepositories: new Set(['team/project']), fetch: async (input, init) => { seen.push(new Headers(init?.headers).get('authorization')); return Response.json({}) } })
  const registered = (createForgejoServer(client, false, true) as unknown as { _registeredTools: Record<string, { handler: (input: unknown, context: unknown) => Promise<unknown> }> })._registeredTools
  const input = { owner: 'team', repo: 'project' }
  await assert.rejects(async () => registered.get_repository!.handler(input, { http: { req: new Request('https://x/mcp') } }), /X-Forgejo-Token|x-forgejo-token/)
  assert.deepEqual(seen, [])
  const as = (token: string) => registered.get_repository!.handler(input, { http: { req: new Request('https://x/mcp', { headers: { 'x-forgejo-token': token } }) } })
  await Promise.all([as('alice-token'), as('bob-token')])
  assert.deepEqual(seen.sort(), ['Bearer alice-token', 'Bearer bob-token'])
})

test('a client without any credential refuses to call Forgejo', async () => {
  const client = new ForgejoClient({ baseUrl: new URL('https://forgejo.example'), token: undefined, allowedRepositories: new Set(['team/project']), fetch: async () => Response.json({}) })
  await assert.rejects(() => client.getRepository('team', 'project'), /No Forgejo credential/)
})
