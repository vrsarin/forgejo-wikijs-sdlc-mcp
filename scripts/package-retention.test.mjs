import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import {
  applyRetentionPlan,
  parseImageTag,
  planManifestRetention,
  planPackageRetention,
  registryManifestReader
} from './package-retention.mjs'

function version(id, tag, createdAt) {
  return {
    id,
    created_at: createdAt ?? new Date(Date.UTC(2026, 0, id)).toISOString(),
    metadata: { container: { tags: tag === undefined ? [] : [tag] } }
  }
}

test('parses stable and staged image tags', () => {
  assert.deepEqual(parseImageTag('1.2.3'), {
    tag: '1.2.3',
    base: '1.2.3',
    stage: 'stable',
    semanticVersion: [1, 2, 3]
  })
  assert.deepEqual(parseImageTag('1.2.3-rc.42.2'), {
    tag: '1.2.3-rc.42.2',
    base: '1.2.3',
    stage: 'rc',
    semanticVersion: [1, 2, 3],
    runNumber: 42,
    runAttempt: 2
  })
  assert.equal(parseImageTag('latest'), undefined)
})

test('keeps five stable releases and purges prereleases after their stable release exists', () => {
  const versions = [
    version(1, '1.0.0'),
    version(2, '1.1.0'),
    version(3, '1.2.0'),
    version(4, '1.3.0'),
    version(5, '1.4.0'),
    version(6, '1.10.0'),
    version(7, '1.10.0-dev.10.1'),
    version(8, '1.10.0-beta.11.1'),
    version(9, '1.10.0-rc.12.1')
  ]
  const plan = planPackageRetention(versions)
  const deletedTags = new Set(plan.delete.flatMap((item) => item.tags))

  assert.equal(deletedTags.has('1.0.0'), true)
  assert.equal(deletedTags.has('1.10.0-dev.10.1'), true)
  assert.equal(deletedTags.has('1.10.0-beta.11.1'), true)
  assert.equal(deletedTags.has('1.10.0-rc.12.1'), true)
  assert.equal(plan.keep.some((item) => item.tags.includes('1.10.0')), true)
})

test('purges older prerelease trains after a newer stable release', () => {
  const versions = [
    version(1, '1.0.3'),
    version(2, '1.0.1-dev.13.1'),
    version(3, '1.0.2-beta.42.1'),
    version(4, '1.0.2-rc.46.1'),
    version(5, '1.0.4-dev.47.1')
  ]
  const plan = planPackageRetention(versions)
  const deletedTags = new Set(plan.delete.flatMap((item) => item.tags))

  assert.equal(deletedTags.has('1.0.1-dev.13.1'), true)
  assert.equal(deletedTags.has('1.0.2-beta.42.1'), true)
  assert.equal(deletedTags.has('1.0.2-rc.46.1'), true)
  assert.equal(plan.keep.some((item) => item.tags.includes('1.0.4-dev.47.1')), true)
})

test('purges superseded prereleases even when they were published after the stable release', () => {
  const versions = [
    version(1, '1.0.4'),
    version(2, '1.0.4-dev.57.1'),
    version(3, '1.0.4-rc.59.1'),
    version(4, '1.0.3-beta.60.1'),
    version(5, '1.0.5-dev.61.1'),
    version(6, '1.0.5-beta.62.1'),
    version(7, '1.0.5-rc.63.1')
  ]
  const plan = planPackageRetention(versions)

  assert.deepEqual(plan.delete.map((item) => item.id).sort(), [2, 3, 4])
  assert.deepEqual(plan.keep.map((item) => item.id).sort(), [1, 5, 6, 7])
  assert.equal(plan.protected.length, 0)
})

test('applies retention after every successful image publication, not just releases', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/container-images.yml', import.meta.url),
    'utf8'
  )
  const steps = workflow.split(/^ {6}- /m)
  const retentionIndex = steps.findIndex((step) => step.startsWith('name: Remove superseded package versions\n'))
  assert.ok(retentionIndex > 0, 'publication must include a retention step')
  const retentionStep = steps[retentionIndex]

  assert.doesNotMatch(retentionStep, /^\s+if:/m, 'retention must not be restricted to release events')
  assert.match(retentionStep, /run: node scripts\/package-retention\.mjs --apply/)
  assert.match(steps[retentionIndex - 1], /^name: Attest image provenance\n/)
})

test('applies stage quotas independently to parallel release trains', () => {
  const versions = []
  let id = 1
  for (const base of ['1.5.0', '2.0.0']) {
    for (let run = 1; run <= 7; run += 1) versions.push(version(id++, `${base}-dev.${run}.1`))
    for (let run = 1; run <= 4; run += 1) versions.push(version(id++, `${base}-beta.${run}.1`))
    for (let run = 1; run <= 3; run += 1) versions.push(version(id++, `${base}-rc.${run}.1`))
  }
  const plan = planPackageRetention(versions)

  for (const base of ['1.5.0', '2.0.0']) {
    assert.equal(plan.keep.filter((item) => item.tags[0].startsWith(`${base}-dev.`)).length, 5)
    assert.equal(plan.keep.filter((item) => item.tags[0].startsWith(`${base}-beta.`)).length, 2)
    assert.equal(plan.keep.filter((item) => item.tags[0].startsWith(`${base}-rc.`)).length, 1)
  }
})

test('protects untagged, unknown, and multi-identity versions', () => {
  const unknown = version(1, 'latest')
  const untagged = version(2, undefined)
  const mixed = version(3, '1.2.3')
  mixed.metadata.container.tags.push('1.2.4')
  const plan = planPackageRetention([unknown, untagged, mixed])

  assert.equal(plan.delete.length, 0)
  assert.equal(plan.protected.length, 3)
})

function digest(id) {
  return `sha256:${id.toString(16).padStart(64, '0')}`
}

function imageManifest(subject) {
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: digest(1000) },
    layers: [],
    ...(subject ? { subject: { digest: subject } } : {})
  }
}

function manifestFixture() {
  const versions = [
    version(1, '1.0.4'),
    version(2, '1.0.3-dev.42.1'),
    version(3),
    version(4),
    version(5, digest(1).replace(':', '-')),
    version(6, digest(2).replace(':', '-')),
    version(7),
    version(8),
    version(9),
    version(10),
    version(11)
  ].map((item) => ({ ...item, name: digest(item.id) }))
  const index = (...ids) => ({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: ids.map((id) => ({ digest: digest(id) }))
  })
  const manifests = new Map([
    [digest(1), index(3, 10)],
    [digest(2), index(3, 4)],
    [digest(3), imageManifest()],
    [digest(4), imageManifest()],
    [digest(5), index(7)],
    [digest(6), index(8)],
    [digest(7), imageManifest()],
    [digest(8), imageManifest()],
    [digest(9), imageManifest()],
    [digest(10), index(11)],
    [digest(11), imageManifest()]
  ])
  return {
    versions,
    manifests,
    read: async (name) => {
      assert.ok(manifests.has(name), `unexpected manifest read: ${name}`)
      return manifests.get(name)
    },
    now: Date.parse('2026-11-06T00:00:00Z')
  }
}

test('deletes orphaned SHA and untagged versions but preserves the complete retained image graph', async () => {
  const { versions, read, now } = manifestFixture()
  const plan = await planManifestRetention(versions, planPackageRetention(versions), read, now)

  assert.deepEqual(plan.keep.map((item) => item.id), [1])
  assert.deepEqual(plan.delete.map((item) => item.id).sort((a, b) => a - b), [2, 4, 6, 8, 9])
  assert.deepEqual(plan.protected.map((item) => item.id).sort((a, b) => a - b), [3, 5, 7, 10, 11])
})

test('preserves dependencies of unknown tags and multi-identity versions', async () => {
  const { versions, manifests, read, now } = manifestFixture()
  versions[8].metadata.container.tags = ['custom']
  manifests.set(digest(9), {
    ...manifests.get(digest(1)),
    manifests: [{ digest: digest(4) }]
  })
  versions[9].metadata.container.tags = ['2.0.0', '2.0.1']
  const plan = await planManifestRetention(versions, planPackageRetention(versions), read, now)

  for (const id of [4, 9, 10, 11]) {
    assert.ok(plan.protected.some((item) => item.id === id))
    assert.equal(plan.delete.some((item) => item.id === id), false)
  }
})

test('resolves nested manifests even when a child is absent from the package API snapshot', async () => {
  const { versions, read, now } = manifestFixture()
  const snapshot = versions.filter((item) => item.id !== 10)
  const plan = await planManifestRetention(snapshot, planPackageRetention(snapshot), read, now)

  assert.ok(plan.protected.some((item) => item.id === 11))
  assert.equal(plan.delete.some((item) => item.id === 11), false)
})

test('follows OCI subject links and digest-tagged signature attachments', async () => {
  const { versions, manifests, read, now } = manifestFixture()
  manifests.set(digest(9), imageManifest(digest(1)))
  versions[5].metadata.container.tags = [`${digest(1).replace(':', '-')}.sig`]
  const plan = await planManifestRetention(versions, planPackageRetention(versions), read, now)

  for (const id of [6, 8, 9]) assert.ok(plan.protected.some((item) => item.id === id))
})

test('can remove an orphaned OCI attestation whose subject has already been deleted', async () => {
  const { versions, manifests, read, now } = manifestFixture()
  manifests.set(digest(9), imageManifest(digest(999)))
  const plan = await planManifestRetention(versions, planPackageRetention(versions), read, now)

  assert.ok(plan.delete.some((item) => item.id === 9))
})

test('does not fetch missing children of an orphaned index but fails for missing retained dependencies', async () => {
  const { versions, manifests, read, now } = manifestFixture()
  manifests.get(digest(6)).manifests = [{ digest: digest(999) }]
  const plan = await planManifestRetention(versions, planPackageRetention(versions), read, now)
  assert.ok(plan.delete.some((item) => item.id === 6))

  manifests.get(digest(1)).manifests.push({ digest: digest(999) })
  await assert.rejects(
    planManifestRetention(versions, planPackageRetention(versions), read, now),
    /unexpected manifest read/
  )
})

test('removes stale orphaned API entries returning registry 404 but never retained or recent entries', async () => {
  const { versions, read, now } = manifestFixture()
  const missing = registryManifestReader('owner', 'package', 'test-token', async (url) =>
    new URL(url).pathname === '/token'
      ? new Response(JSON.stringify({ token: 'registry-token' }))
      : new Response('', { status: 404 }))
  const readWithMissing = async (name) => name === digest(9) ? missing(name) : read(name)
  const plan = await planManifestRetention(versions, planPackageRetention(versions), readWithMissing, now)
  assert.ok(plan.delete.some((item) => item.id === 9))

  versions[8].metadata.container.tags = ['custom']
  await assert.rejects(
    planManifestRetention(versions, planPackageRetention(versions), readWithMissing, now),
    /manifest .* failed \(404\)/
  )
  versions[8].metadata.container.tags = []
  versions[8].created_at = new Date(now).toISOString()
  const recentPlan = await planManifestRetention(versions, planPackageRetention(versions), readWithMissing, now)
  assert.ok(recentPlan.protected.some((item) => item.id === 9))
  assert.equal(recentPlan.delete.some((item) => item.id === 9), false)
})

test('protects recent uploads and their dependencies until the 24-hour grace period ends', async () => {
  const { versions, manifests, read, now } = manifestFixture()
  versions[5].created_at = new Date(now - 60_000).toISOString()
  manifests.set(digest(6), {
    ...manifests.get(digest(1)),
    manifests: [{ digest: digest(8) }]
  })
  const plan = await planManifestRetention(versions, planPackageRetention(versions), read, now)
  assert.match(plan.protected.find((item) => item.id === 6).reason, /24-hour/)
  assert.ok(plan.protected.some((item) => item.id === 8))

  const expired = await planManifestRetention(
    versions, planPackageRetention(versions), read, now + 24 * 60 * 60 * 1000
  )
  for (const id of [6, 8]) assert.ok(expired.delete.some((item) => item.id === id))
})

test('manifest lookup failures abort planning rather than treating unreadable manifests as orphans', async () => {
  const { versions, now } = manifestFixture()
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(planManifestRetention(
      versions,
      planPackageRetention(versions),
      async () => { throw new Error(`GHCR failed (${status})`) },
      now
    ), new RegExp(`GHCR failed \\(${status}\\)`))
  }
})

test('rejects invalid manifest metadata and unsupported manifest formats before deletion', async () => {
  const { versions, manifests, read, now } = manifestFixture()
  manifests.set(digest(9), { schemaVersion: 2, mediaType: 'unknown' })
  await assert.rejects(
    planManifestRetention(versions, planPackageRetention(versions), read, now),
    /Unsupported or malformed/
  )
  manifests.set(digest(9), imageManifest())
  versions[8].created_at = 'invalid'
  await assert.rejects(
    planManifestRetention(versions, planPackageRetention(versions), read, now), /Invalid creation date/
  )
  versions[8].name = 'not-a-digest'
  await assert.rejects(
    planManifestRetention(versions, planPackageRetention(versions), read, now), /Invalid or missing manifest digest/
  )
})

test('registry reader exchanges credentials once and reads manifests with a scoped bearer token', async () => {
  const requests = []
  const read = registryManifestReader('Test-Owner', 'Test-Package', 'test-token', async (url, options) => {
    requests.push({ url: String(url), ...options })
    return new Response(JSON.stringify(requests.length === 1 ? { token: 'registry-token' } : imageManifest()))
  })
  await Promise.all([read(digest(1)), read(digest(2))])

  assert.equal(requests.length, 3)
  assert.equal(new URL(requests[0].url).searchParams.get('scope'), 'repository:test-owner/test-package:pull')
  assert.match(requests[0].headers.Authorization, /^Basic /)
  assert.equal(requests[1].headers.Authorization, 'Bearer registry-token')
  assert.equal(requests[2].url, `https://ghcr.io/v2/test-owner/test-package/manifests/${digest(2)}`)
  assert.ok(requests.every((request) => request.redirect === 'error'))
})

test('registry reader preserves token and manifest failures', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const tokenFailure = registryManifestReader('owner', 'package', 'test-token',
      async () => new Response('', { status }))
    await assert.rejects(tokenFailure(digest(1)), new RegExp(`token request failed \\(${status}\\)`))
    const manifestFailure = registryManifestReader('owner', 'package', 'test-token',
      async (url) => new URL(url).pathname === '/token'
        ? new Response(JSON.stringify({ token: 'registry-token' }))
        : new Response('', { status }))
    await assert.rejects(manifestFailure(digest(1)), new RegExp(`manifest .* failed \\(${status}\\)`))
  }
  const missingToken = registryManifestReader('owner', 'package', 'test-token',
    async () => new Response('{}'))
  await assert.rejects(missingToken(digest(1)), /no registry token/)
})

test('deletes release versions before their orphaned manifests', async () => {
  const { versions, read, now } = manifestFixture()
  const plan = await planManifestRetention(versions, planPackageRetention(versions), read, now)
  plan.delete.reverse()
  const deleted = []
  await applyRetentionPlan(plan, async (item) => { deleted.push(item.id) })

  assert.equal(deleted[0], 2)
  assert.deepEqual(deleted.slice(1).sort((a, b) => a - b), [4, 6, 8, 9])
})

test('does not delete orphan candidates when deleting a release version fails', async () => {
  const { versions, read, now } = manifestFixture()
  const plan = await planManifestRetention(versions, planPackageRetention(versions), read, now)
  const attempted = []
  await assert.rejects(applyRetentionPlan(plan, async (item) => {
    attempted.push(item.id)
    throw new Error('Deletion denied')
  }), /Package retention completed with failures:\nDeletion denied/)

  assert.deepEqual(attempted, [2])
})

async function retentionApi(t, { deleteStatus = () => 204, getStatus = 200 } = {}) {
  const requests = []
  const versionsPath = '/users/test-owner/packages/container/test-package/versions'
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url === '/users/test-owner') {
      response.end(JSON.stringify({ type: 'User' }))
    } else if (request.method === 'GET' && request.url === `${versionsPath}?per_page=100&page=1`) {
      response.statusCode = getStatus
      response.end(JSON.stringify(getStatus === 200
        ? [version(1, '1.0.4'), version(2, '1.0.4-dev.57.1'), version(3, '1.0.4-rc.59.1')]
        : { message: 'Cannot list package versions' }))
    } else if (request.method === 'DELETE' && [`${versionsPath}/2`, `${versionsPath}/3`].includes(request.url)) {
      response.statusCode = deleteStatus(request.url)
      response.end(response.statusCode === 204 ? undefined : JSON.stringify({ message: 'Delete response' }))
    } else {
      response.statusCode = 500
      response.end(JSON.stringify({ message: 'Unexpected request' }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))

  return {
    requests,
    run: () => promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('./package-retention.mjs', import.meta.url)),
      '--apply'
    ], {
      timeout: 10_000,
      env: {
        ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_TOKEN: 'test-token',
        PACKAGE_OWNER: 'test-owner',
        PACKAGE_NAME: 'test-package',
        GITHUB_STEP_SUMMARY: ''
      }
    })
  }
}

test('overlapping cleanup runs succeed when a version has already been deleted', async (t) => {
  const removed = new Set()
  const api = await retentionApi(t, {
    deleteStatus: (path) => {
      if (removed.has(path)) return 404
      removed.add(path)
      return 204
    }
  })
  const results = await Promise.all([api.run(), api.run()])

  assert.equal(removed.size, 2)
  assert.equal(api.requests.filter((request) => request.startsWith('DELETE ')).length, 4)
  assert.equal(results.every(({ stderr }) => stderr === ''), true)
  const output = results.map(({ stdout }) => stdout).join('\n')
  assert.equal(output.match(/Package version already absent \(404\)/g)?.length, 2)
  assert.equal(output.match(/Ensured package version \d+ is absent/g)?.length, 4)
})

for (const status of [401, 403, 429, 500]) {
  test(`deletion errors (${status}) still fail cleanup and do not stop remaining deletions`, async (t) => {
    const api = await retentionApi(t, {
      deleteStatus: (path) => path.endsWith('/2') ? status : 204
    })

    await assert.rejects(api.run(), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /Package retention completed with failures/)
      assert.ok(error.stderr.includes(`failed (${status})`))
      assert.match(error.stdout, /Ensured package version 3 is absent/)
      return true
    })
    assert.equal(api.requests.filter((request) => request.startsWith('DELETE ')).length, 2)
  })
}

test('a 404 while listing package versions remains fatal', async (t) => {
  const api = await retentionApi(t, { getStatus: 404 })

  await assert.rejects(api.run(), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /GitHub Packages API GET .*failed \(404\)/)
    return true
  })
  assert.equal(api.requests.some((request) => request.startsWith('DELETE ')), false)
})
