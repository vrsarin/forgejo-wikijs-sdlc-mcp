#!/usr/bin/env node

import { constants } from 'node:fs'
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const managedManifest = '.sdlc-mcp-managed-pages'
const managedPagePattern = /^(?:Home|_Sidebar|MCP-(?:Users|Developers|Reference|Troubleshooting)-[A-Za-z0-9-]+)\.md$/

async function markdownFiles(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await markdownFiles(path, root))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative(root, path).split(sep).join('/'))
  }
  return files
}

function pageName(sourcePath) {
  if (sourcePath === 'README.md') return 'Home.md'
  const words = sourcePath.slice(0, -3).split('/').flatMap((segment) => segment.split(/[-_ ]+/))
  const title = words.map((word) => word ? `${word[0].toUpperCase()}${word.slice(1)}` : '').join('-')
  return `MCP-${title}.md`
}

function safeRepositoryPath(path, root) {
  const resolved = resolve(path)
  const relativePath = relative(root, resolved)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Wiki link is outside the repository: ${path}`)
  }
  return relativePath.split(sep).join('/')
}

function rewriteLinks(content, sourcePath, sourceRoot, repository, branch, pageNames) {
  return content.replace(/(\]\()([^\s)]+)((?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?\s*\))/g, (match, prefix, target, suffix) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return match
    const parsed = target.match(/^([^?#]+)(\?[^#]*)?(#.*)?$/)
    if (!parsed || !parsed[1].endsWith('.md')) return match

    const sourceFile = resolve(sourceRoot, sourcePath)
    const targetPath = resolve(dirname(sourceFile), decodeURIComponent(parsed[1]))
    const relativeToWiki = relative(sourceRoot, targetPath)
    const suffixText = `${parsed[2] ?? ''}${parsed[3] ?? ''}`
    if (relativeToWiki && !relativeToWiki.startsWith(`..${sep}`) && !isAbsolute(relativeToWiki)) {
      const targetSourcePath = relativeToWiki.split(sep).join('/')
      const targetPage = pageNames.get(targetSourcePath)
      if (!targetPage) throw new Error(`Wiki page link does not exist: ${sourcePath} -> ${target}`)
      return `${prefix}${targetPage.slice(0, -3)}${suffixText}${suffix}`
    }

    const repositoryPath = safeRepositoryPath(targetPath, resolve(sourceRoot, '..'))
    return `${prefix}https://github.com/${repository}/blob/${branch}/${repositoryPath}${suffixText}${suffix}`
  })
}

function sidebarLink(sourcePath, heading, page) {
  const title = heading ?? page.replace(/^MCP-/, '').replace(/\.md$/, '').replaceAll('-', ' ')
  const label = title.replace(/&/g, '&amp;').replace(/[\\[\]]/g, '\\$&')
  return `- [${label}](${page.slice(0, -3)})`
}

export async function buildWikiPages(sourceRoot, outputRoot, { repository, branch = 'main' }) {
  const sourceFiles = await markdownFiles(sourceRoot)
  const pageNames = new Map()
  for (const sourcePath of sourceFiles) {
    const outputName = pageName(sourcePath)
    if ([...pageNames.values()].includes(outputName)) throw new Error(`Wiki page name collision: ${outputName}`)
    pageNames.set(sourcePath, outputName)
  }
  if (!pageNames.has('README.md')) throw new Error('wiki/README.md is required to build the GitHub Wiki home page')

  await mkdir(outputRoot, { recursive: true })
  if ((await readdir(outputRoot)).length !== 0) {
    throw new Error('Wiki output directory must be empty. Use a fresh directory for each build.')
  }
  const sections = new Map()
  for (const sourcePath of sourceFiles) {
    const content = await readFile(resolve(sourceRoot, sourcePath), 'utf8')
    const rewritten = rewriteLinks(content, sourcePath, sourceRoot, repository, branch, pageNames)
    const outputName = pageNames.get(sourcePath)
    await writeFile(resolve(outputRoot, outputName), rewritten)
    if (sourcePath !== 'README.md') {
      const category = sourcePath.split('/')[0]
      const heading = content.match(/^#\s+(.+)$/m)?.[1]
      const pages = sections.get(category) ?? []
      pages.push(sidebarLink(sourcePath, heading, outputName))
      sections.set(category, pages)
    }
  }

  const sectionTitles = { users: 'For users', developers: 'For developers', reference: 'Reference', troubleshooting: 'Troubleshooting' }
  const sidebarOrder = ['users', 'developers', 'reference', 'troubleshooting']
  const sidebar = sidebarOrder
    .filter((category) => sections.has(category))
    .map((category) => `### ${sectionTitles[category]}\n\n${sections.get(category).join('\n')}`)
    .join('\n\n')
  await writeFile(resolve(outputRoot, '_Sidebar.md'), `${sidebar}\n`)
}

async function openRegularFile(path, flags) {
  let handle
  try {
    handle = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error(`Refusing to use a non-file GitHub Wiki entry: ${path}`, { cause: error })
    throw error
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`Refusing to use a non-file GitHub Wiki entry: ${path}`)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readRegularFile(path) {
  const handle = await openRegularFile(path, constants.O_RDONLY)
  try {
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function writeRegularFile(path, content) {
  const handle = await openRegularFile(path, constants.O_WRONLY | constants.O_CREAT)
  try {
    await handle.truncate(0)
    await handle.writeFile(content)
  } finally {
    await handle.close()
  }
}

export async function syncWikiPages(generatedRoot, wikiRoot) {
  const generatedFiles = (await readdir(generatedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()
  for (const file of generatedFiles) {
    if (!managedPagePattern.test(file)) throw new Error(`Generated page has an unexpected name: ${file}`)
  }
  if (!generatedFiles.includes('Home.md') || !generatedFiles.includes('_Sidebar.md')) {
    throw new Error('Generated wiki must include Home.md and _Sidebar.md')
  }

  let previousFiles = []
  try {
    const manifest = (await readRegularFile(resolve(wikiRoot, managedManifest))).toString('utf8')
    previousFiles = manifest.split(/\r?\n/).filter(Boolean)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (new Set(previousFiles).size !== previousFiles.length || previousFiles.some((file) => !managedPagePattern.test(file))) {
    throw new Error(`The ${managedManifest} file contains an invalid managed-page entry`)
  }

  const previousSet = new Set(previousFiles)
  const pages = new Map()
  for (const file of generatedFiles) {
    const destination = resolve(wikiRoot, file)
    let existing
    try {
      existing = await readRegularFile(destination)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const generated = await readRegularFile(resolve(generatedRoot, file))
    if (existing && !previousSet.has(file) && file !== 'Home.md') {
      throw new Error(`Refusing to overwrite an unmanaged GitHub Wiki page: ${file}`)
    }
    pages.set(file, generated)
  }

  const generatedSet = new Set(generatedFiles)
  for (const staleFile of previousFiles.filter((file) => !generatedSet.has(file))) {
    await rm(resolve(wikiRoot, staleFile), { force: true })
  }
  for (const [file, generated] of pages) {
    await writeRegularFile(resolve(wikiRoot, file), generated)
  }

  await writeRegularFile(resolve(wikiRoot, managedManifest), `${generatedFiles.join('\n')}\n`)
}

async function main(args) {
  if (args[0] === 'build' && args.length === 2) {
    const sourceRoot = resolve('wiki')
    await buildWikiPages(sourceRoot, resolve(args[1]), {
      repository: process.env.GITHUB_REPOSITORY ?? 'vrsarin/forgejo-wikijs-sdlc-mcp',
      branch: 'main'
    })
    return
  }
  if (args[0] === 'apply' && args.length === 3) {
    await syncWikiPages(resolve(args[1]), resolve(args[2]))
    return
  }
  throw new Error('Usage: node scripts/sync-wiki.mjs build <output-dir> | apply <generated-dir> <wiki-repository-dir>')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
