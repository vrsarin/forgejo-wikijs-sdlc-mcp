import assert from 'node:assert/strict'
import test from 'node:test'

import { parseImageTag, planPackageRetention } from './package-retention.mjs'

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
