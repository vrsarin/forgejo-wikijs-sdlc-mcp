import assert from 'node:assert/strict'
import test from 'node:test'

import { isTrustedDependencyBot, validatePullRequest } from './validate-pr-changelog.mjs'

test('accepts a conventional title and categorized changelog entry', () => {
  const errors = validatePullRequest({
    title: 'feat(forgejo): add workflow discovery support',
    body: '## Changelog\n\n- Added: Workflow discovery for Forgejo repositories.\n\n## Verification\n\nPassed.'
  })
  assert.deepEqual(errors, [])
})

test('accepts internal entries for changes without user-visible behavior', () => {
  const errors = validatePullRequest({
    title: 'ci(release): publish verification evidence',
    body: '## Changelog\n\n- Internal: Automated release evidence generation and upload.'
  })
  assert.deepEqual(errors, [])
})

test('removes complete HTML comments without exposing hidden changelog text', () => {
  const errors = validatePullRequest({
    title: 'fix(repository): validate changelog comments safely',
    body: '## Changelog\n\n<!-- template guidance -->\n- Fixed: Changelog comment parsing rejects ambiguous input.'
  })
  assert.deepEqual(errors, [])
})

test('rejects incomplete or overlapping HTML comment markers', () => {
  for (const body of [
    '## Changelog\n\n<!-- unclosed\n- Fixed: Hidden changelog entry.',
    '## Changelog\n\n<!----><!-- -->-->\n- Fixed: Ambiguous changelog entry.'
  ]) {
    assert.match(validatePullRequest({
      title: 'fix(repository): reject ambiguous changelog comments',
      body
    })[0], /complete, non-overlapping HTML comments/)
  }
})

test('rejects an invalid title and a missing changelog section', () => {
  const errors = validatePullRequest({
    title: 'Update things',
    body: '## Summary\n\nSeveral updates.'
  })
  assert.equal(errors.length, 2)
})

test('rejects uncategorized and placeholder changelog entries', () => {
  const errors = validatePullRequest({
    title: 'fix(wikijs): reject expired access tokens',
    body: '## Changelog\n\n- Fixed token handling.\n- Fixed: N/A'
  })
  assert.equal(errors.length, 2)
})

test('requires a specific explanation for an internal change', () => {
  const errors = validatePullRequest({
    title: 'chore(repository): update contributor guidance',
    body: '## Changelog\n\n- Internal: No user-visible changes.'
  })
  assert.equal(errors.length, 1)
})

test('trusts only same-repository Dependabot pull requests', () => {
  const pullRequest = {
    user: { login: 'dependabot[bot]' },
    head: { ref: 'dependabot/npm_and_yarn/jose-6.2.14', repo: { full_name: 'o/r' } },
    base: { repo: { full_name: 'o/r' } }
  }
  assert.equal(isTrustedDependencyBot(pullRequest), true)
  assert.equal(isTrustedDependencyBot({ ...pullRequest, user: { login: 'someone' } }), false)
  assert.equal(isTrustedDependencyBot({ ...pullRequest, head: { ...pullRequest.head, repo: { full_name: 'fork/r' } } }), false)
  assert.equal(isTrustedDependencyBot({ ...pullRequest, head: { ...pullRequest.head, ref: 'feature/x' } }), false)
  assert.equal(isTrustedDependencyBot(undefined), false)
})
