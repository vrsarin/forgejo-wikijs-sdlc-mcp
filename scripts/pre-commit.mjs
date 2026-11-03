#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generatedAt = new Date()
const runId = generatedAt.toISOString().replaceAll(':', '').replaceAll('.', '-')
const evidenceRoot = resolve(repository, '.artifacts/pre-commit')
const runRoot = resolve(evidenceRoot, 'runs', runId)
mkdirSync(runRoot, { recursive: true })

const scanner = 'aquasec/trivy@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c'
const checks = [
  { name: 'Lint', command: 'npm', args: ['run', 'lint'] },
  { name: 'Dependency audit', command: 'make', args: ['audit'] },
  { name: 'Type and syntax checks', command: 'make', args: ['check'] },
  { name: 'Tests', command: 'make', args: ['test'] },
  { name: 'Compose validation', command: 'make', args: ['compose-check'] },
  { name: 'Container builds', command: 'make', args: ['images'] },
  { name: 'Repository vulnerability and configuration scan', command: 'make', args: ['trivy-fs'] },
  { name: 'Repository and container secret scans', command: 'make', args: ['trivy-secrets'] },
  { name: 'Container vulnerability scans', command: 'make', args: ['trivy-images'] },
  { name: 'CycloneDX SBOM generation', command: 'make', args: ['sbom'] }
]

function output(command, args) {
  const result = spawnSync(command, args, { cwd: repository, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unavailable'
}

const branch = output('git', ['branch', '--show-current']) || '(detached)'
const baseCommit = output('git', ['rev-parse', '--verify', 'HEAD'])
const stagedTree = output('git', ['write-tree'])
const stagedPatch = spawnSync('git', ['diff', '--cached', '--binary', '--no-ext-diff'], { cwd: repository }).stdout ?? Buffer.alloc(0)
const stagedDigest = createHash('sha256').update(stagedPatch).digest('hex')
const stagedFiles = output('git', ['diff', '--cached', '--name-only']).split('\n').filter(Boolean)
const dockerVersion = output('docker', ['version', '--format', '{{.Server.Version}}'])
const results = []

function safeName(name) {
  return name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '')
}

async function runCheck(check) {
  const logPath = resolve(runRoot, `${safeName(check.name)}.log`)
  const chunks = []
  const started = Date.now()
  process.stdout.write(`\n==> ${check.name}\n`)
  const child = spawn(check.command, check.args, { cwd: repository, env: process.env })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      chunks.push(chunk)
      process.stdout.write(chunk)
    })
  }
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolveExit(code ?? 1))
  })
  writeFileSync(logPath, Buffer.concat(chunks))
  return {
    name: check.name,
    command: [check.command, ...check.args].join(' '),
    durationSeconds: ((Date.now() - started) / 1000).toFixed(1),
    exitCode,
    log: relative(repository, logPath)
  }
}

function report(status) {
  const rows = checks.map((check) => {
    const result = results.find((item) => item.name === check.name)
    if (!result) return `| ${check.name} | NOT RUN | - | - |`
    return `| ${result.name} | ${result.exitCode === 0 ? 'PASS' : 'FAIL'} | ${result.durationSeconds} s | \`${result.command}\` |`
  })
  const content = `# Pre-commit verification evidence

Overall result: **${status}**

| Field | Value |
| --- | --- |
| Generated (UTC) | ${generatedAt.toISOString()} |
| Branch | \`${branch}\` |
| Base commit | \`${baseCommit}\` |
| Commit | Pending; finalized by the post-commit hook |
| Staged Git tree | \`${stagedTree}\` |
| Staged content SHA-256 | \`${stagedDigest}\` |
| Node.js | \`${process.version}\` |
| Docker Engine | \`${dockerVersion}\` |
| Trivy image | \`${scanner}\` |

## Checks

| Check | Result | Duration | Command |
| --- | --- | ---: | --- |
${rows.join('\n')}

## Staged files

${stagedFiles.length ? stagedFiles.map((file) => `- \`${file}\``).join('\n') : '- No staged files were detected.'}

The detailed logs are stored locally in \`${relative(repository, runRoot)}\`. Attach this summary to the pull request or paste its check table into the PR description.
`
  const runReport = resolve(runRoot, 'report.md')
  writeFileSync(runReport, content)
  writeFileSync(resolve(evidenceRoot, 'latest.md'), content)
  writeFileSync(resolve(evidenceRoot, 'latest.json'), `${JSON.stringify({
    status,
    generatedAt: generatedAt.toISOString(),
    branch,
    baseCommit,
    stagedTree,
    stagedDigest,
    stagedFiles,
    node: process.version,
    docker: dockerVersion,
    scanner,
    results
  }, null, 2)}\n`)
  return runReport
}

let status = 'PASS'
try {
  for (const check of checks) {
    const result = await runCheck(check)
    results.push(result)
    if (result.exitCode !== 0) {
      status = 'FAIL'
      break
    }
  }
} catch (error) {
  status = 'FAIL'
  results.push({
    name: 'Pre-commit runner',
    command: 'internal',
    durationSeconds: '0.0',
    exitCode: 1,
    log: '',
    error: error instanceof Error ? error.message : String(error)
  })
}

const reportPath = report(status)
console.log(`\nPre-commit evidence: ${reportPath}`)
if (status !== 'PASS') process.exit(1)
