#!/usr/bin/env node

import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const stablePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const prereleasePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(dev|beta|rc)\.([1-9]\d*)\.([1-9]\d*)$/
const digestPattern = /^sha256:[a-f0-9]{64}$/
const digestTagPattern = /^sha256-([a-f0-9]{64})(?:\.(?:sig|att))?$/
const manifestGracePeriod = 24 * 60 * 60 * 1000

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

function compareSemanticVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index]
    }
  }
  return 0
}

function compareSemanticVersionDescending(left, right) {
  const semanticDifference = compareSemanticVersions(
    left.release.semanticVersion,
    right.release.semanticVersion
  )
  if (semanticDifference !== 0) return -semanticDifference
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
    digest: entry.version.name,
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
        digest: version.name,
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
  const newestStableVersion = stable[0]?.release.semanticVersion
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
    if (
      newestStableVersion &&
      compareSemanticVersions(newestStableVersion, group[0].release.semanticVersion) >= 0
    ) {
      remove.push(...group.map((entry) => decision(
        entry,
        'delete',
        `stable release ${stable[0].release.base} supersedes ${base}`
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

function isAuxiliaryVersion(version) {
  return isAuxiliaryTags(tagsFor(version))
}

function isAuxiliaryTags(tags) {
  return tags.length === 0 || tags.every((tag) => digestTagPattern.test(tag))
}

class RegistryManifestError extends Error {
  constructor(digest, status) {
    super(`GHCR manifest ${digest} failed (${status})`)
    this.status = status
  }
}

export function registryManifestReader(owner, packageName, token, fetchRegistry = fetch) {
  const repository = `${owner}/${packageName}`.toLowerCase()
  const manifestPath = repository.split('/').map(encodeURIComponent).join('/')
  let registryTokenPromise
  return async function readManifest(digest) {
    if (!digestPattern.test(digest)) throw new Error(`Invalid manifest digest: ${digest}`)
    if (!registryTokenPromise) {
      registryTokenPromise = (async () => {
        const url = new URL('https://ghcr.io/token')
        url.searchParams.set('service', 'ghcr.io')
        url.searchParams.set('scope', `repository:${repository}:pull`)
        const response = await fetchRegistry(url, {
          headers: { Authorization: `Basic ${Buffer.from(`${owner}:${token}`).toString('base64')}` },
          redirect: 'error'
        })
        if (!response.ok) throw new Error(`GHCR token request failed (${response.status})`)
        const body = await response.json()
        if (typeof body.token !== 'string' || !body.token) throw new Error('GHCR returned no registry token')
        return body.token
      })()
    }
    const registryToken = await registryTokenPromise
    const response = await fetchRegistry(`https://ghcr.io/v2/${manifestPath}/manifests/${digest}`, {
      headers: {
        Authorization: `Bearer ${registryToken}`,
        Accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.docker.distribution.manifest.v2+json'
        ].join(', ')
      },
      redirect: 'error'
    })
    if (!response.ok) throw new RegistryManifestError(digest, response.status)
    return response.json()
  }
}

export async function planManifestRetention(versions, plan, readManifest, now = Date.now()) {
  if (!versions.some(isAuxiliaryVersion)) return plan
  const byId = new Map(versions.map((version) => [version.id, version]))
  const versionDigests = new Set(versions.map((version) => version.name))
  const manifests = new Map()
  const attachments = new Map()
  const pending = new Set()
  const requireDigest = (digest) => {
    if (!digestPattern.test(digest)) throw new Error(`Invalid or missing manifest digest: ${digest}`)
    return digest
  }
  const attach = (subject, digest) => {
    const related = attachments.get(subject) ?? new Set()
    related.add(digest)
    attachments.set(subject, related)
  }

  for (const version of versions) {
    pending.add(requireDigest(version.name))
    for (const tag of tagsFor(version)) {
      const match = digestTagPattern.exec(tag)
      if (match) attach(`sha256:${match[1]}`, version.name)
    }
  }
  const loadManifests = async (batch) => {
    const loaded = await Promise.all(batch.map(async (digest) => {
      try {
        return [digest, await readManifest(digest)]
      } catch (error) {
        if (!(error instanceof RegistryManifestError) || error.status !== 404) throw error
        console.log(`Registry manifest is unavailable (404); checking retained references: ${digest}`)
        return [digest, null]
      }
    }))
    for (const [digest, manifest] of loaded) {
      if (manifest === null) {
        manifests.set(digest, null)
        continue
      }
      const isIndex = [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json'
      ].includes(manifest.mediaType)
      const isImage = [
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json'
      ].includes(manifest.mediaType)
      if (manifest.schemaVersion !== 2 || (!isIndex && !isImage) ||
        (isIndex && !Array.isArray(manifest.manifests)) ||
        (isImage && (!manifest.config || !Array.isArray(manifest.layers)))) {
        throw new Error(`Unsupported or malformed registry manifest: ${digest}`)
      }
      const dependencies = (manifest.manifests ?? []).map((item) => requireDigest(item.digest))
      if (manifest.subject) {
        const subject = requireDigest(manifest.subject.digest)
        attach(subject, digest)
        if (versionDigests.has(subject)) dependencies.push(subject)
      }
      manifests.set(digest, dependencies)
    }
  }
  while (pending.size) {
    const batch = [...pending].slice(0, 4)
    for (const digest of batch) pending.delete(digest)
    await loadManifests(batch)
  }

  const recent = new Set()
  for (const version of versions.filter(isAuxiliaryVersion)) {
    const created = Date.parse(version.created_at)
    if (!Number.isFinite(created)) throw new Error(`Invalid creation date for package version ${version.id}`)
    if (now - created < manifestGracePeriod) recent.add(version.id)
  }
  const reachable = new Set()
  const visit = [
    ...plan.keep,
    ...plan.protected.filter((item) => !isAuxiliaryVersion(byId.get(item.id)) || recent.has(item.id))
  ].map((item) => byId.get(item.id).name)
  while (visit.length) {
    const digest = visit.pop()
    if (reachable.has(digest)) continue
    if (!manifests.has(digest)) await loadManifests([digest])
    if (manifests.get(digest) === null) throw new RegistryManifestError(digest, 404)
    reachable.add(digest)
    visit.push(...manifests.get(digest), ...(attachments.get(digest) ?? []))
  }

  const result = { keep: [...plan.keep], delete: [], protected: [] }
  for (const item of [...plan.delete, ...plan.protected]) {
    const version = byId.get(item.id)
    if (reachable.has(version.name) || recent.has(version.id)) {
      result.protected.push({
        ...item,
        disposition: 'protected',
        reason: recent.has(version.id)
          ? 'manifest is within the 24-hour publication grace period'
          : 'referenced by a retained image or protected manifest'
      })
    } else if (isAuxiliaryVersion(version)) {
      result.delete.push({ ...item, disposition: 'delete', reason: 'orphaned SHA or untagged manifest older than 24 hours' })
    } else if (item.disposition === 'delete') {
      result.delete.push(item)
    } else {
      result.protected.push(item)
    }
  }
  return result
}

export async function applyRetentionPlan(plan, deleteVersion) {
  const failures = []
  const releases = plan.delete.filter((item) => !isAuxiliaryTags(item.tags))
  const auxiliary = plan.delete.filter((item) => isAuxiliaryTags(item.tags))
  for (const batch of [releases, auxiliary]) {
    for (const version of batch) {
      try {
        await deleteVersion(version)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (failures.length) throw new Error(`Package retention completed with failures:\n${failures.join('\n')}`)
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
    if (method === 'DELETE' && response.status === 404) {
      console.log(`Package version already absent (404): ${path}`)
      return
    }
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
    '| Decision | Version ID | Digest | Tags | Reason |',
    '| --- | --- | --- | --- | --- |'
  ]
  for (const item of [...plan.delete, ...plan.keep, ...plan.protected]) {
    const tags = item.tags.length ? item.tags.join(', ') : '(untagged)'
    lines.push(`| ${item.disposition} | ${item.id} | \`${item.digest ?? '(unavailable)'}\` | \`${tags}\` | ${item.reason} |`)
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
  const plan = await planManifestRetention(
    versions,
    planPackageRetention(versions),
    registryManifestReader(owner, packageName, token)
  )
  const report = summary(plan, apply)
  process.stdout.write(report)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report)

  if (!apply) return
  await applyRetentionPlan(plan, async (version) => {
    const path = `/${scope}/${encodeURIComponent(owner)}/packages/container/${encodeURIComponent(packageName)}/versions/${version.id}`
    await request(path, { method: 'DELETE' })
    console.log(`Ensured package version ${version.id} is absent: ${version.tags.join(', ')}`)
  })
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
