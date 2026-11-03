import assert from 'node:assert/strict'
import test from 'node:test'
import { ForgejoClient } from '../src/providers/forgejo.js'

test('issue mutation is allowlisted and read back', async () => {
  const requests: Request[] = []
  const client = new ForgejoClient({
    baseUrl: new URL('https://forgejo.example'), token: 'secret',
    allowedRepositories: new Set(['team/project']),
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return Response.json({ id: 1, number: 7, title: 'Updated', body: '', state: 'open', html_url: 'https://forgejo.example/team/project/issues/7', updated_at: '2026-11-01T00:00:00Z' })
    }
  })
  const issue = await client.updateIssue('team', 'project', 7, { title: 'Updated' })
  assert.equal(issue.title, 'Updated')
  assert.deepEqual(requests.map((request) => request.method), ['PATCH', 'GET'])
  assert.equal(requests[0]?.url, 'https://forgejo.example/api/v1/repos/team/project/issues/7')
})

test('issue creation is idempotent when the marker already exists', async () => {
  const requests: Request[] = []
  const existing = { id: 1, number: 9, title: 'Epic', body: '<!-- sdlc-idempotency:epic-9 -->', state: 'open', html_url: 'https://forgejo.example/team/project/issues/9', updated_at: '2026-11-01T00:00:00Z' }
  const client = new ForgejoClient({
    baseUrl: new URL('https://forgejo.example'), token: 'secret', allowedRepositories: new Set(['team/project']),
    fetch: async (input, init) => { requests.push(new Request(input, init)); return Response.json([existing]) }
  })
  const outcome = await client.createIssue('team', 'project', { title: 'Epic', idempotencyKey: 'epic-9' })
  assert.equal(outcome.created, false)
  assert.equal(outcome.issue.number, 9)
  assert.deepEqual(requests.map((request) => request.method), ['GET'])
})

test('comment creation appends an idempotency marker and reads the comment back', async () => {
  const requests: Request[] = []
  const client = new ForgejoClient({
    baseUrl: new URL('https://forgejo.example'), token: 'secret', allowedRepositories: new Set(['team/project']),
    fetch: async (input, init) => {
      const request = new Request(input, init); requests.push(request)
      if (request.method === 'GET' && request.url.endsWith('/comments?page=1&limit=100')) return Response.json([])
      if (request.method === 'POST') {
        assert.match(await request.text(), /sdlc-idempotency:trace-1/)
        return Response.json({ id: 42, body: 'trace' })
      }
      return Response.json({ id: 42, body: 'trace\n\n<!-- sdlc-idempotency:trace-1 -->' })
    }
  })
  const outcome = await client.addIssueComment('team', 'project', 7, 'trace', 'trace-1')
  assert.equal(outcome.created, true)
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'POST', 'GET'])
})

test('dependency writes require both repositories to be allowlisted and are verified', async () => {
  const requests: Request[] = []
  const client = new ForgejoClient({
    baseUrl: new URL('https://forgejo.example'), token: 'secret', allowedRepositories: new Set(['team/project', 'team/base']),
    fetch: async (input, init) => { requests.push(new Request(input, init)); return Response.json([]) }
  })
  await client.addDependency('team', 'project', 7, { owner: 'team', repo: 'base', index: 2 })
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'GET'])
  await assert.rejects(() => client.addDependency('team', 'project', 7, { owner: 'other', repo: 'repo', index: 2 }), /not in SDLC_ALLOWED_REPOSITORIES/)
})

test('attachment uploads enforce media type and size before contacting Forgejo', async () => {
  let contacted = false
  const client = new ForgejoClient({
    baseUrl: new URL('https://forgejo.example'), token: 'secret', allowedRepositories: new Set(['team/project']),
    fetch: async () => { contacted = true; return Response.json([]) }
  })
  await assert.rejects(() => client.uploadAttachment('team', 'project', 7, 'payload.exe', 'application/octet-stream', 'AA=='), /not allowed/)
  await assert.rejects(() => client.uploadAttachment('team', 'project', 7, 'empty.txt', 'text/plain', ''), /between 1 byte/)
  assert.equal(contacted, false)
})

test('read-only workflow methods stay on finite repository API paths', async () => {
  const paths: string[] = []
  const client = new ForgejoClient({
    baseUrl: new URL('https://forgejo.example'), token: 'secret', allowedRepositories: new Set(['team/project']),
    fetch: async (input, init) => {
      const request = new Request(input, init); paths.push(new URL(request.url).pathname)
      if (request.url.endsWith('/logs')) return new Response('bounded log')
      return Response.json(request.url.includes('/actions/runs') ? {} : [])
    }
  })
  await client.listPullRequests('team', 'project')
  await client.listCommits('team', 'project')
  await client.listActionRuns('team', 'project')
  await client.getActionJobLog('team', 'project', 3)
  await client.listReleases('team', 'project')
  await client.listTags('team', 'project')
  await client.listBranchProtections('team', 'project')
  await client.listWebhooks('team', 'project')
  assert.deepEqual(paths, [
    '/api/v1/repos/team/project/pulls',
    '/api/v1/repos/team/project/commits',
    '/api/v1/repos/team/project/actions/runs',
    '/api/v1/repos/team/project/actions/jobs/3/logs',
    '/api/v1/repos/team/project/releases',
    '/api/v1/repos/team/project/tags',
    '/api/v1/repos/team/project/branch_protections',
    '/api/v1/repos/team/project/hooks'
  ])
})
