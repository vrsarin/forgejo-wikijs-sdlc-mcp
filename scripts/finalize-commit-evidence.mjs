#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidenceRoot = resolve(repository, '.artifacts/pre-commit')
const latestJson = resolve(evidenceRoot, 'latest.json')
const latestMarkdown = resolve(evidenceRoot, 'latest.md')

try {
  const evidence = JSON.parse(readFileSync(latestJson, 'utf8'))
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  const committedTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository, encoding: 'utf8' }).trim()
  if (evidence.status !== 'PASS' || evidence.stagedTree !== committedTree) {
    console.warn('Pre-commit evidence was not finalized because it does not match the committed Git tree.')
    process.exit(0)
  }

  evidence.commit = commit
  const markdown = readFileSync(latestMarkdown, 'utf8').replace(
    '| Commit | Pending; finalized by the post-commit hook |',
    `| Commit | \`${commit}\` |`
  )
  writeFileSync(latestMarkdown, markdown)
  writeFileSync(latestJson, `${JSON.stringify(evidence, null, 2)}\n`)

  const commitRoot = resolve(evidenceRoot, 'commits')
  mkdirSync(commitRoot, { recursive: true })
  copyFileSync(latestMarkdown, resolve(commitRoot, `${commit}.md`))
  copyFileSync(latestJson, resolve(commitRoot, `${commit}.json`))
  console.log(`Commit evidence: ${resolve(commitRoot, `${commit}.md`)}`)
} catch (error) {
  console.warn(`Pre-commit evidence was not finalized: ${error instanceof Error ? error.message : String(error)}`)
}
