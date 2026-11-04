#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const titlePattern = /^(feat|fix|perf|refactor|docs|build|ci|test|chore|revert)(\([a-z0-9][a-z0-9._/-]*\))?!?: .{10,}$/
const entryPattern = /^[-*]\s+(Added|Changed|Fixed|Security|Deprecated|Removed|Internal):\s+(.+)$/
const placeholderPattern = /^(none|n\/?a|not applicable|no changelog|no changes?|no user-visible changes?|tbd|todo|describe\b.*)$/i

function stripHtmlComments(value) {
  let result = ''
  let cursor = 0

  while (cursor < value.length) {
    const start = value.indexOf('<!--', cursor)
    if (start === -1) {
      result += value.slice(cursor)
      break
    }
    result += value.slice(cursor, start)
    const end = value.indexOf('-->', start + 4)
    if (end === -1) return undefined
    cursor = end + 3
  }

  if (result.includes('<!--') || result.includes('-->')) return undefined
  return result
}

export function validatePullRequest({ title = '', body = '' }) {
  const errors = []
  const normalizedTitle = title.trim()

  if (!titlePattern.test(normalizedTitle)) {
    errors.push(
      'Use a Conventional Commit title, for example: feat(forgejo): add workflow discovery support'
    )
  }
  if (normalizedTitle.length > 100) {
    errors.push('Keep the pull request title at 100 characters or fewer')
  }

  const changelogMatch = body.match(/^## Changelog[ \t]*\r?\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m)
  if (!changelogMatch) {
    errors.push('Add a level-two "Changelog" section to the pull request body')
    return errors
  }

  const uncommentedSection = stripHtmlComments(changelogMatch[1])
  if (uncommentedSection === undefined) {
    errors.push('Use complete, non-overlapping HTML comments in the Changelog section')
    return errors
  }
  const section = uncommentedSection.trim()
  const bulletLines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))

  if (bulletLines.length === 0) {
    errors.push('Add at least one categorized bullet to the Changelog section')
    return errors
  }

  for (const line of bulletLines) {
    const match = line.match(entryPattern)
    if (!match) {
      errors.push(
        `Use an allowed category for this changelog entry: ${line}`
      )
      continue
    }
    const detail = match[2].trim().replace(/[.!]$/, '').trim()
    if (detail.length < 12 || placeholderPattern.test(detail)) {
      errors.push(`Replace the placeholder with a specific changelog entry: ${line}`)
    }
  }

  return errors
}

function escapeWorkflowCommand(value) {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

function main() {
  let title = process.env.CI_PR_TITLE
  let body = process.env.CI_PR_BODY

  if (title === undefined || body === undefined) {
    const eventPath = process.env.CI_EVENT_PATH ?? process.env.GITHUB_EVENT_PATH
    if (!eventPath) {
      throw new Error('Set CI_PR_TITLE and CI_PR_BODY, or provide CI_EVENT_PATH')
    }

    const event = JSON.parse(readFileSync(eventPath, 'utf8'))
    const pullRequest = event.pull_request
    if (!pullRequest) throw new Error('The CI event does not contain a pull request')
    title = pullRequest.title ?? ''
    body = pullRequest.body ?? ''
  }

  const errors = validatePullRequest({
    title,
    body
  })
  if (errors.length === 0) {
    console.log('Pull request changelog requirements: PASS')
    return
  }

  for (const error of errors) {
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.error(`::error title=PR changelog requirement::${escapeWorkflowCommand(error)}`)
    }
    console.error(`- ${error}`)
  }
  console.error('\nPull request changelog requirements: FAIL')
  console.error('See the pull request template for the required format.')
  process.exitCode = 1
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) main()
