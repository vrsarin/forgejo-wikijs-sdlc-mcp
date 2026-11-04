#!/usr/bin/env node

import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const stablePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const prereleasePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(dev|beta|rc)\.([1-9]\d*)\.([1-9]\d*)$/

export const defaultRetention = Object.freeze({
  stable: 5,
  dev: 5,
  beta: 2,
  rc: 1
})

export function parseImageTag(tag) {
  const stable = stablePattern.exec(tag)
  if (stable) {
    return {
      tag,
      base: tag,
      stage: 'stable',
      semanticVersion: stable.slice(1).map(Number)
    }
  }

  const prerelease = prereleasePattern.exec(tag)
  if (!prerelease) return undefined
  return {
    tag,
    base: `${prerelease[1]}.${prerelease[2]}.${prerelease[3]}`,
    stage: prerelease[4],
    semanticVersion: prerelease.slice(1, 4).map(Number),
    runNumber: Number(prerelease[5]),
    runAttempt: Number(prerelease[6])
  }
}

function tagsFor(version) {
  const tags = version?.metadata?.container?.tags
  return Array.isArray(tags) ? tags : []
}

function classifyVersion(version) {
  const tags = tagsFor(version)
  if (tags.length === 0) return { protectedReason: 'untagged provenance, SBOM, or manifest' }

  const parsed = tags.map(parseImageTag)
  if (parsed.some((tag) => tag === undefined)) {
    return { protectedReason: 'contains an unknown or protected tag' }
  }

  const identities = new Set(parsed.map((tag) => `${tag.base}:${tag.stage}:${tag.tag}`))
  if (identities.size !== 1) {
    return { protectedReason: 'contains multiple release identities' }
  }

  return { release: parsed[0] }
}

function compareSemanticVersionDescending(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.release.semanticVersion[index] !== right.release.semanticVersion[index]) {
      return right.release.semanticVersion[index] - left.release.semanticVersion[index]
    }
  }
  return compareRecencyDescending(left, right)
}

function compareRecencyDescending(left, right) {
  const dateDifference = Date.parse(right.version.created_at) - Date.parse(left.version.created_at)
  if (Number.isFinite(dateDifference) && dateDifference !== 0) return dateDifference
  const runDifference = (right.release.runNumber ?? 0) - (left.release.runNumber ?? 0)
  if (runDifference !== 0) return runDifference
  const attemptDifference = (right.release.runAttempt ?? 0) - (left.release.runAttempt ?? 0)
  if (attemptDifference !== 0) return attemptDifference
  return Number(right.version.id) - Number(left.version.id)
}

function decision(entry, disposition, reason) {
  return {
    id: entry.version.id,
    tags: tagsFor(entry.version),
    createdAt: entry.version.created_at,
    disposition,
    reason
  }
}

export function planPackageRetention(versions, retention = defaultRetention) {
  const protectedVersions = []
  const classified = []

  for (const version of versions) {
    const classification = classifyVersion(version)
    if (classification.protectedReason) {
      protectedVersions.push({
        id: version.id,
        tags: tagsFor(version),
        createdAt: version.created_at,
        disposition: 'protected',
        reason: classification.protectedReason
      })
      continue
    }
    classified.push({ version, release: classification.release })
  }

  const stable = classified
    .filter((entry) => entry.release.stage === 'stable')
    .sort(compareSemanticVersionDescending)
  const stableBases = new Set(stable.map((entry) => entry.release.base))
  const keep = stable
    .slice(0, retention.stable)
    .map((entry) => decision(entry, 'keep', `one of the newest ${retention.stable} stable releases`))
  const remove = stable
    .slice(retention.stable)
    .map((entry) => decision(entry, 'delete', `older than the newest ${retention.stable} stable releases`))

  const prereleaseGroups = new Map()
  for (const entry of classified.filter((item) => item.release.stage !== 'stable')) {
    const key = `${entry.release.base}:${entry.release.stage}`
    const group = prereleaseGroups.get(key) ?? []
    group.push(entry)
    prereleaseGroups.set(key, group)
  }

  for (const group of prereleaseGroups.values()) {
    group.sort(compareRecencyDescending)
    const { base, stage } = group[0].release
    if (stableBases.has(base)) {
      remove.push(...group.map((entry) => decision(
        entry,
        'delete',
        `stable release ${base} is available`
      )))
      continue
    }

    const limit = retention[stage]
    keep.push(...group.slice(0, limit).map((entry) => decision(
      entry,
      'keep',
      `one of the newest ${limit} ${stage} versions for ${base}`
    )))
    remove.push(...group.slice(limit).map((entry) => decision(
      entry,
      'delete',
      `older than the newest ${limit} ${stage} versions for ${base}`
    )))
  }

  return {
    keep,
    delete: remove,
    protected: protectedVersions
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function apiClient(token) {
  const baseUrl = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '')
  return async function request(path, options = {}) {
    const method = options.method ?? 'GET'
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      throw new Error(`GitHub Packages API ${method} ${path} failed (${response.status}): ${detail}`)
    }
    return response.status === 204 ? undefined : response.json()
  }
}

async function packageScope(request, owner) {
  const account = await request(`/users/${encodeURIComponent(owner)}`)
  return account.type === 'Organization' ? 'orgs' : 'users'
}

async function listPackageVersions(request, scope, owner, packageName) {
  const versions = []
  for (let page = 1; ; page += 1) {
    const path = `/${scope}/${encodeURIComponent(owner)}/packages/container/${encodeURIComponent(packageName)}/versions?per_page=100&page=${page}`
    const batch = await request(path)
    versions.push(...batch)
    if (batch.length < 100) return versions
  }
}

function summary(plan, apply) {
  const lines = [
    '# GHCR package retention',
    '',
    `Mode: **${apply ? 'APPLY' : 'DRY RUN'}**`,
    '',
    `- Keep: ${plan.keep.length}`,
    `- Delete: ${plan.delete.length}`,
    `- Protected: ${plan.protected.length}`,
    '',
    '| Decision | Tags | Reason |',
    '| --- | --- | --- |'
  ]
  for (const item of [...plan.delete, ...plan.keep, ...plan.protected]) {
    const tags = item.tags.length ? item.tags.join(', ') : '(untagged)'
    lines.push(`| ${item.disposition} | \`${tags}\` | ${item.reason} |`)
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  const token = requiredEnvironment('GITHUB_TOKEN')
  const owner = requiredEnvironment('PACKAGE_OWNER')
  const packageName = process.env.PACKAGE_NAME?.trim() || 'sdlc-mcp-server'
  const apply = process.argv.includes('--apply') || process.env.RETENTION_APPLY === 'true'
  const request = apiClient(token)
  const scope = await packageScope(request, owner)
  const versions = await listPackageVersions(request, scope, owner, packageName)
  const plan = planPackageRetention(versions)
  const report = summary(plan, apply)
  process.stdout.write(report)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report)

  if (!apply) return
  const failures = []
  for (const version of plan.delete) {
    const path = `/${scope}/${encodeURIComponent(owner)}/packages/container/${encodeURIComponent(packageName)}/versions/${version.id}`
    try {
      await request(path, { method: 'DELETE' })
      console.log(`Deleted package version ${version.id}: ${version.tags.join(', ')}`)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (failures.length) throw new Error(`Package retention completed with failures:\n${failures.join('\n')}`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
