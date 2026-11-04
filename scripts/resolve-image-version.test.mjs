import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveImageVersion } from './resolve-image-version.mjs'

const common = {
  stableVersion: '1.4.0',
  runNumber: '42',
  runAttempt: '2'
}

test('creates a unique development version for a feature push', () => {
  assert.deepEqual(resolveImageVersion({
    ...common,
    eventName: 'push',
    refName: 'feature/oauth'
  }), { version: '1.4.0-dev.42.2', stage: 'dev' })
})

test('creates a unique development version for a bug branch', () => {
  assert.deepEqual(resolveImageVersion({
    ...common,
    eventName: 'push',
    refName: 'bug/token-refresh'
  }), { version: '1.4.0-dev.42.2', stage: 'dev' })
})

test('rejects fix as a milestone change branch prefix', () => {
  assert.throws(() => resolveImageVersion({
    ...common,
    eventName: 'push',
    refName: 'fix/token-refresh'
  }), /feature\/\*, bug\/\*, or hotfix\/\*/)
})

test('creates a unique beta version for a milestone branch', () => {
  assert.deepEqual(resolveImageVersion({
    ...common,
    eventName: 'push',
    refName: 'release/identity-hardening'
  }), { version: '1.4.0-beta.42.2', stage: 'beta' })
})

test('rejects a version as the milestone branch name', () => {
  assert.throws(() => resolveImageVersion({
    ...common,
    eventName: 'push',
    refName: 'release/1.4.0'
  }), /milestone-name>.*not a version/)
  assert.throws(() => resolveImageVersion({
    ...common,
    eventName: 'push',
    refName: 'release/identity-hardening-1.4.0'
  }), /milestone-name>.*not a version/)
})

test('creates a unique release-candidate version for main', () => {
  assert.deepEqual(resolveImageVersion({
    ...common,
    eventName: 'push',
    refName: 'main'
  }), { version: '1.4.0-rc.42.2', stage: 'rc' })
})

test('uses the stable version only for the matching release tag', () => {
  assert.deepEqual(resolveImageVersion({
    ...common,
    eventName: 'release',
    releaseTag: 'v1.4.0'
  }), { version: '1.4.0', stage: 'release' })
})

test('rejects a release tag that does not match VERSION', () => {
  assert.throws(() => resolveImageVersion({
    ...common,
    eventName: 'release',
    releaseTag: 'v1.5.0'
  }), /must match VERSION/)
})

test('rejects invalid stable versions and counters', () => {
  assert.throws(() => resolveImageVersion({
    ...common,
    stableVersion: 'v1.4.0',
    eventName: 'push'
  }), /stable semantic version/)
  assert.throws(() => resolveImageVersion({
    ...common,
    runNumber: '0',
    eventName: 'push'
  }), /run number/)
})

test('does not assign a published version to a pull request', () => {
  assert.throws(() => resolveImageVersion({
    ...common,
    eventName: 'pull_request',
    refName: '17/merge'
  }), /Unsupported image publication event/)
})
