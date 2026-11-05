import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { buildWikiPages, syncWikiPages } from './sync-wiki.mjs'

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(resolve(tmpdir(), 'sdlc-wiki-test-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('builds flat GitHub Wiki pages and rewrites internal and repository links', async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = resolve(directory, 'repo')
    const source = resolve(repository, 'wiki')
    const generated = resolve(directory, 'generated')
    await mkdir(resolve(source, 'users'), { recursive: true })
    await mkdir(resolve(source, 'developers'), { recursive: true })
    await writeFile(resolve(source, 'README.md'), '# Wiki\n\n[Get started](users/getting-started.md)\n')
    await writeFile(resolve(source, 'users/getting-started.md'), '# Get started\n\n[Developer guide](../developers/overview.md)\n')
    await writeFile(resolve(source, 'developers/overview.md'), '# Overview\n\n[Contributing](../../CONTRIBUTING.md)\n')
    await writeFile(resolve(repository, 'CONTRIBUTING.md'), '# Contributions\n')

    await buildWikiPages(source, generated, { repository: 'owner/repo' })

    assert.match(await readFile(resolve(generated, 'Home.md'), 'utf8'), /]\(MCP-Users-Getting-Started\)/)
    assert.match(await readFile(resolve(generated, 'MCP-Users-Getting-Started.md'), 'utf8'), /]\(MCP-Developers-Overview\)/)
    assert.equal(
      await readFile(resolve(generated, 'MCP-Developers-Overview.md'), 'utf8'),
      '# Overview\n\n[Contributing](https://github.com/owner/repo/blob/main/CONTRIBUTING.md)\n'
    )
    assert.match(await readFile(resolve(generated, '_Sidebar.md'), 'utf8'), /]\(MCP-Users-Getting-Started\)/)
  })
})

test('escapes backslashes and brackets in sidebar link labels', async () => {
  await withTemporaryDirectory(async (directory) => {
    const source = resolve(directory, 'wiki')
    const generated = resolve(directory, 'generated')
    await mkdir(resolve(source, 'users'), { recursive: true })
    await writeFile(resolve(source, 'README.md'), '# Wiki\n')
    await writeFile(resolve(source, 'users/guide.md'), '# Paths \\ [setup] & permissions\n')

    await buildWikiPages(source, generated, { repository: 'owner/repo' })

    assert.equal(
      await readFile(resolve(generated, '_Sidebar.md'), 'utf8'),
      '### For users\n\n- [Paths \\\\ \\[setup\\] &amp; permissions](MCP-Users-Guide)\n'
    )
  })
})

test('rejects broken internal wiki links', async () => {
  await withTemporaryDirectory(async (directory) => {
    const source = resolve(directory, 'wiki')
    await mkdir(source)
    await writeFile(resolve(source, 'README.md'), '# Wiki\n\n[Missing](users/missing.md)\n')
    await assert.rejects(buildWikiPages(source, resolve(directory, 'generated'), { repository: 'owner/repo' }), /Wiki page link does not exist/)
  })
})

test('syncs managed pages, preserves unrelated pages, and prunes only stale managed pages', async () => {
  await withTemporaryDirectory(async (directory) => {
    const generated = resolve(directory, 'generated')
    const wiki = resolve(directory, 'wiki-repository')
    await mkdir(generated)
    await mkdir(wiki)
    await writeFile(resolve(generated, 'Home.md'), 'Generated home\n')
    await writeFile(resolve(generated, '_Sidebar.md'), 'Generated sidebar\n')
    await writeFile(resolve(generated, 'MCP-Users-New-Guide.md'), 'New guide\n')
    await writeFile(resolve(wiki, 'Home.md'), 'Previous home content that is longer than the new home\n')
    await writeFile(resolve(wiki, 'MCP-Users-Old-Guide.md'), 'Old managed page\n')
    await writeFile(resolve(wiki, 'Custom-Page.md'), 'Keep this page\n')
    await writeFile(resolve(wiki, '.sdlc-mcp-managed-pages'), 'MCP-Users-Old-Guide.md\n')

    await syncWikiPages(generated, wiki)

    assert.equal(await readFile(resolve(wiki, 'Home.md'), 'utf8'), 'Generated home\n')
    assert.equal(await readFile(resolve(wiki, 'Custom-Page.md'), 'utf8'), 'Keep this page\n')
    await assert.rejects(readFile(resolve(wiki, 'MCP-Users-Old-Guide.md')), { code: 'ENOENT' })
    assert.match(await readFile(resolve(wiki, '.sdlc-mcp-managed-pages'), 'utf8'), /MCP-Users-New-Guide\.md/)

    await syncWikiPages(generated, wiki)
    assert.equal(await readFile(resolve(wiki, 'Home.md'), 'utf8'), 'Generated home\n')
  })
})

test('refuses to overwrite an unmanaged provider page', async () => {
  await withTemporaryDirectory(async (directory) => {
    const generated = resolve(directory, 'generated')
    const wiki = resolve(directory, 'wiki-repository')
    await mkdir(generated)
    await mkdir(wiki)
    await writeFile(resolve(generated, 'Home.md'), 'Generated home\n')
    await writeFile(resolve(generated, '_Sidebar.md'), 'Generated sidebar\n')
    await writeFile(resolve(generated, 'MCP-Users-Guide.md'), 'Generated guide\n')
    await writeFile(resolve(wiki, 'MCP-Users-Guide.md'), 'Manually maintained page\n')

    await assert.rejects(syncWikiPages(generated, wiki), /Refusing to overwrite an unmanaged GitHub Wiki page/)
    assert.equal(await readFile(resolve(wiki, 'MCP-Users-Guide.md'), 'utf8'), 'Manually maintained page\n')
  })
})

test('refuses to follow a symlink from the GitHub Wiki repository', async () => {
  await withTemporaryDirectory(async (directory) => {
    const generated = resolve(directory, 'generated')
    const wiki = resolve(directory, 'wiki-repository')
    const protectedFile = resolve(directory, 'protected.md')
    await mkdir(generated)
    await mkdir(wiki)
    await writeFile(resolve(generated, 'Home.md'), 'Generated home\n')
    await writeFile(resolve(generated, '_Sidebar.md'), 'Generated sidebar\n')
    await writeFile(resolve(generated, 'MCP-Users-Guide.md'), 'Generated guide\n')
    await writeFile(protectedFile, 'Keep this file unchanged\n')
    await symlink(protectedFile, resolve(wiki, 'Home.md'))

    await assert.rejects(syncWikiPages(generated, wiki), /Refusing to use a non-file GitHub Wiki entry/)
    assert.equal(await readFile(protectedFile, 'utf8'), 'Keep this file unchanged\n')
  })
})

test('refuses a symlinked managed-page manifest', async () => {
  await withTemporaryDirectory(async (directory) => {
    const generated = resolve(directory, 'generated')
    const wiki = resolve(directory, 'wiki-repository')
    const protectedFile = resolve(directory, 'protected-manifest')
    await mkdir(generated)
    await mkdir(wiki)
    await writeFile(resolve(generated, 'Home.md'), 'Generated home\n')
    await writeFile(resolve(generated, '_Sidebar.md'), 'Generated sidebar\n')
    await writeFile(protectedFile, 'Home.md\n_Sidebar.md\n')
    await symlink(protectedFile, resolve(wiki, '.sdlc-mcp-managed-pages'))

    await assert.rejects(syncWikiPages(generated, wiki), /Refusing to use a non-file GitHub Wiki entry/)
    assert.equal(await readFile(protectedFile, 'utf8'), 'Home.md\n_Sidebar.md\n')
    await assert.rejects(readFile(resolve(wiki, 'Home.md')), { code: 'ENOENT' })
  })
})
