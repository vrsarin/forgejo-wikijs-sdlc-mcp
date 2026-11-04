import assert from 'node:assert/strict'
import test from 'node:test'
import { ForgejoApiError, ForgejoClient } from '../../../src/providers/forgejo/forgejo.js'

interface Call { method: string; path: string; body: string; auth: string | null }
function harness(respond: (call: Call) => Response | Promise<Response>, allowed = ['team/project']) {
  const calls: Call[] = []
  const client = new ForgejoClient({
    baseUrl: new URL('https://forgejo.example/sub/'), token: 'secret', allowedRepositories: new Set(allowed),
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const call = { method: request.method, path: url.pathname + url.search, body: await request.text(), auth: request.headers.get('authorization') }
      calls.push(call)
      return respond(call)
    }
  })
  return { client, calls }
}
const pr = (extra: Record<string, unknown> = {}) => ({ id: 1, number: 5, title: 'PR', body: '', state: 'open', html_url: 'u', head: { ref: 'feature' }, base: { ref: 'main' }, ...extra })

test('requests honor a base path and send the bearer token', async () => {
  const { client, calls } = harness(() => Response.json({}))
  await client.getRepository('team', 'project')
  assert.equal(calls[0]?.path, '/sub/api/v1/repos/team/project')
  assert.equal(calls[0]?.auth, 'Bearer secret')
})

test('pull request creation returns the existing PR for a matching idempotency key', async () => {
  const { client, calls } = harness(() => Response.json([pr({ body: '<!-- sdlc-idempotency:pr-1 -->' })]))
  const outcome = await client.createPullRequest('team', 'project', { title: 'PR', head: 'feature', base: 'main', idempotencyKey: 'pr-1' })
  assert.equal(outcome.created, false)
  assert.deepEqual(calls.map((c) => c.method), ['GET'])
})

test('pull request creation posts a marked draft and reads it back', async () => {
  const { client, calls } = harness((call) => call.method === 'GET' && call.path.includes('/pulls?') ? Response.json([]) : Response.json(pr()))
  const outcome = await client.createPullRequest('team', 'project', { title: 'PR', body: 'text', head: 'feature', base: 'main', draft: true, idempotencyKey: 'pr-2' })
  assert.equal(outcome.created, true)
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'GET'])
  const posted = JSON.parse(calls[1]!.body)
  assert.match(posted.body, /sdlc-idempotency:pr-2/)
  assert.equal(posted.draft, true)
  assert.equal('idempotencyKey' in posted, false)
})

test('a PR with the same marker but a different branch is not treated as a duplicate', async () => {
  const { client } = harness((call) => call.method === 'GET' && call.path.includes('/pulls?') ? Response.json([pr({ body: '<!-- sdlc-idempotency:pr-3 -->', head: { ref: 'other' } })]) : Response.json(pr()))
  assert.equal((await client.createPullRequest('team', 'project', { title: 'PR', head: 'feature', base: 'main', idempotencyKey: 'pr-3' })).created, true)
})

test('issue creation with a new key appends the marker and verifies by re-reading', async () => {
  const issue = { id: 1, number: 12, title: 'Epic', body: '', state: 'open', html_url: 'u', updated_at: 'now' }
  const { client, calls } = harness((call) => call.method === 'GET' && call.path.includes('/issues?') ? Response.json([]) : Response.json(issue))
  const outcome = await client.createIssue('team', 'project', { title: 'Epic', body: 'b', idempotencyKey: 'epic-12' })
  assert.equal(outcome.created, true)
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST', 'GET'])
  assert.match(JSON.parse(calls[1]!.body).body, /^b\n\n<!-- sdlc-idempotency:epic-12 -->$/)
  assert.equal(calls[2]?.path, '/sub/api/v1/repos/team/project/issues/12')
})

test('invalid idempotency keys are rejected before any request', async () => {
  const { client, calls } = harness(() => Response.json([]))
  await assert.rejects(async () => client.createIssue('team', 'project', { title: 'x', idempotencyKey: 'bad key -->' }), /Idempotency key is invalid/)
  assert.equal(calls.length, 0)
})

test('labels, reviews, reviewers, time, and notifications use the documented endpoints and read back', async () => {
  const { client, calls } = harness((call) => {
    if (call.path.endsWith('/reviews') && call.method === 'POST') return Response.json({ id: 8 })
    if (call.path.includes('/pulls/5') && !call.path.includes('/reviews')) return Response.json(pr())
    return Response.json(call.path.includes('/issues/3') && !call.path.includes('/times') ? { number: 3 } : [])
  })
  await client.setIssueLabels('team', 'project', 3, [1, 2])
  await client.createPullReview('team', 'project', 5, { event: 'APPROVE' })
  await client.requestReviewers('team', 'project', 5, ['alice'], ['qa'])
  await client.addTrackedTime('team', 'project', 3, 90)
  await client.markNotificationRead(77)
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path.replace('/sub/api/v1', '')}`), [
    'PUT /repos/team/project/issues/3/labels', 'GET /repos/team/project/issues/3',
    'POST /repos/team/project/pulls/5/reviews', 'GET /repos/team/project/pulls/5/reviews/8',
    'POST /repos/team/project/pulls/5/requested_reviewers', 'GET /repos/team/project/pulls/5',
    'POST /repos/team/project/issues/3/times', 'GET /repos/team/project/issues/3/times',
    'PATCH /notifications/threads/77', 'GET /notifications/threads/77'
  ])
  assert.deepEqual(JSON.parse(calls[0]!.body), { labels: [1, 2] })
  assert.deepEqual(JSON.parse(calls[4]!.body), { reviewers: ['alice'], team_reviewers: ['qa'] })
  assert.deepEqual(JSON.parse(calls[6]!.body), { time: 90 })
})

test('webhook test deliveries are verified without touching webhook configuration', async () => {
  const { client, calls } = harness(() => Response.json({ id: 4 }))
  await client.testWebhook('team', 'project', 4)
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path.replace('/sub/api/v1', '')}`), ['POST /repos/team/project/hooks/4/tests', 'GET /repos/team/project/hooks/4'])
})

test('global lookups still reject unsafe path segments', async () => {
  const { client, calls } = harness(() => Response.json([]))
  await assert.rejects(async () => client.listOrganizationTeams('org/../admin'), /Invalid Forgejo path segment/)
  await assert.rejects(async () => client.getCommit('team', 'project', '../x'), /Invalid Forgejo path segment/)
  assert.equal(calls.length, 0)
})

test('attachment upload sends multipart data and verifies the list', async () => {
  const { client, calls } = harness(() => Response.json([{ name: 'a.txt' }]))
  const list = await client.uploadAttachment('team', 'project', 3, 'a.txt', 'text/plain', Buffer.from('hello').toString('base64'))
  assert.equal(list.length, 1)
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'GET'])
  await assert.rejects(async () => client.uploadAttachment('team', 'project', 3, '../evil.txt', 'text/plain', 'aGk='), /filename is invalid/)
  await assert.rejects(async () => client.uploadAttachment('team', 'project', 3, 'big.txt', 'text/plain', Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')), /between 1 byte and 2 MiB/)
})

test('oversized, failed, and malformed responses raise ForgejoApiError without leaking the token', async () => {
  const oversized = harness(() => new Response('x', { headers: { 'content-length': String(3 * 1024 * 1024) } }))
  await assert.rejects(async () => oversized.client.getRepository('team', 'project'), /exceeded the configured limit/)
  const failed = harness(() => new Response('secret detail', { status: 403 }))
  await assert.rejects(async () => failed.client.getRepository('team', 'project'), (error: unknown) => error instanceof ForgejoApiError && error.status === 403 && !error.message.includes('secret'))
  const malformed = harness(() => new Response('not json'))
  await assert.rejects(async () => malformed.client.getRepository('team', 'project'), /invalid JSON/)
})

test('repositories outside the allowlist are never contacted', async () => {
  const { client, calls } = harness(() => Response.json([]))
  await assert.rejects(async () => client.listActionRuns('other', 'repo'), /not in SDLC_ALLOWED_REPOSITORIES/)
  await assert.rejects(async () => client.uploadAttachment('other', 'repo', 1, 'a.txt', 'text/plain', 'aGk='), /not in SDLC_ALLOWED_REPOSITORIES/)
  assert.equal(calls.length, 0)
})

test('issue idempotency finds a marker beyond the first page and does not depend on text search', async () => {
  const filler = (n: number) => Array.from({ length: 50 }, (_, i) => ({ id: n * 100 + i, number: n * 100 + i, title: `other ${n}-${i}`, body: '', state: 'open', html_url: 'u', updated_at: 'now' }))
  const target = { id: 999, number: 999, title: 'Epic', body: 'b\n\n<!-- sdlc-idempotency:epic-p2 -->', state: 'open', html_url: 'u', updated_at: 'now' }
  const { client, calls } = harness((call) => {
    const page = Number(new URL(call.path, 'http://x').searchParams.get('page'))
    return Response.json(page === 1 ? filler(1) : [target])
  })
  const outcome = await client.createIssue('team', 'project', { title: 'Epic', idempotencyKey: 'epic-p2' })
  assert.equal(outcome.created, false)
  assert.equal(outcome.issue.number, 999)
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET'])
  assert(calls.every((c) => !c.path.includes('q=')), 'the lookup must not use text search')
})
