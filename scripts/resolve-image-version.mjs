#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const positiveIntegerPattern = /^[1-9]\d*$/

export function resolveImageVersion({
  stableVersion,
  eventName,
  refName = '',
  releaseTag = '',
  runNumber,
  runAttempt
}) {
  if (!stableVersionPattern.test(stableVersion)) {
    throw new Error(`VERSION must contain a stable semantic version: ${stableVersion}`)
  }
  if (!positiveIntegerPattern.test(String(runNumber))) {
    throw new Error(`Invalid CI/CD run number: ${runNumber}`)
  }
  if (!positiveIntegerPattern.test(String(runAttempt))) {
    throw new Error(`Invalid CI/CD run attempt: ${runAttempt}`)
  }

  if (eventName === 'release') {
    if (releaseTag !== `v${stableVersion}`) {
      throw new Error(`Release tag ${releaseTag} must match VERSION (v${stableVersion})`)
    }
    return { version: stableVersion, stage: 'release' }
  }

  if (eventName === 'push' && refName.startsWith('release/')) {
    const milestoneName = refName.slice('release/'.length)
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(milestoneName) ||
      /\d+\.\d+\.\d+/.test(milestoneName)
    ) {
      throw new Error(
        `Milestone branch must use release/<milestone-name>, not a version: ${refName}`
      )
    }
    return {
      version: `${stableVersion}-beta.${runNumber}.${runAttempt}`,
      stage: 'beta'
    }
  }

  if (eventName === 'push' && refName === 'main') {
    return {
      version: `${stableVersion}-rc.${runNumber}.${runAttempt}`,
      stage: 'rc'
    }
  }

  if (
    eventName === 'push' &&
    /^(?:feature|bug|hotfix)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(refName)
  ) {
    return {
      version: `${stableVersion}-dev.${runNumber}.${runAttempt}`,
      stage: 'dev'
    }
  }

  if (eventName === 'push') {
    throw new Error(
      `Milestone change branch must use feature/*, bug/*, or hotfix/*: ${refName}`
    )
  }

  throw new Error(`Unsupported image publication event: ${eventName}`)
}

function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const stableVersion = readFileSync(resolve(repositoryRoot, 'VERSION'), 'utf8').trim()
  const result = resolveImageVersion({
    stableVersion,
    eventName: process.env.EVENT_NAME ?? '',
    refName: process.env.REF_NAME ?? '',
    releaseTag: process.env.RELEASE_TAG ?? '',
    runNumber: process.env.RUN_NUMBER ?? '',
    runAttempt: process.env.RUN_ATTEMPT ?? ''
  })

  const outputPath = process.env.CI_OUTPUT ?? process.env.GITHUB_OUTPUT
  if (!outputPath) throw new Error('CI_OUTPUT is required')
  appendFileSync(outputPath, `version=${result.version}\nstage=${result.stage}\n`)
  console.log(`Container version: ${result.version} (${result.stage})`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) main()
