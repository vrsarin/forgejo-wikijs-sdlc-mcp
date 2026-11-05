import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { buildWikiPages, syncWikiPages } from './sync-wiki.mjs'

const execute = promisify(execFile)

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

  test('preserves optional Markdown link titles when rewriting page and repository links', async () => {
    await withTemporaryDirectory(async (directory) => {
      const source = resolve(directory, 'wiki')
      const generated = resolve(directory, 'generated')
      await mkdir(resolve(source, 'users'), { recursive: true })
      await writeFile(resolve(source, 'README.md'), [
        '# Wiki',
        '[Guide](users/guide.md "Guide title")',
        "[Guide](users/guide.md#setup 'Setup title')",
        '[Guide](users/guide.md (Parenthesized title))',
        '[Contributing](../CONTRIBUTING.md "Contributing title")',
        '[External](https://example.com "External title")',
        ''
      ].join('\n'))
      await writeFile(resolve(source, 'users/guide.md'), '# Guide\n')

      await buildWikiPages(source, generated, { repository: 'owner/repo' })

      assert.equal(await readFile(resolve(generated, 'Home.md'), 'utf8'), [
        '# Wiki',
        '[Guide](MCP-Users-Guide "Guide title")',
        "[Guide](MCP-Users-Guide#setup 'Setup title')",
        '[Guide](MCP-Users-Guide (Parenthesized title))',
        '[Contributing](https://github.com/owner/repo/blob/main/CONTRIBUTING.md "Contributing title")',
        '[External](https://example.com "External title")',
        ''
      ].join('\n'))
    })
  })

  test('rejects reused output directories without retaining stale pages in a new build', async () => {
    await withTemporaryDirectory(async (directory) => {
      const source = resolve(directory, 'wiki')
      const generated = resolve(directory, 'generated')
      await mkdir(resolve(source, 'users'), { recursive: true })
      await writeFile(resolve(source, 'README.md'), '# Wiki\n')
      await writeFile(resolve(source, 'users/old.md'), '# Old guide\n')
      await buildWikiPages(source, generated, { repository: 'owner/repo' })
      await rm(resolve(source, 'users/old.md'))

      await assert.rejects(buildWikiPages(source, generated, { repository: 'owner/repo' }), /Use a fresh directory/)
      const fresh = resolve(directory, 'fresh')
      await buildWikiPages(source, fresh, { repository: 'owner/repo' })
      await assert.rejects(readFile(resolve(fresh, 'MCP-Users-Old.md')), { code: 'ENOENT' })
    })
  })

  test('workflow stages ownership manifest even when Wiki gitignore hides dotfiles', async () => {
    const workflow = await readFile(new URL('../.github/workflows/publish-wiki.yml', import.meta.url), 'utf8')
    const stagingStart = workflow.indexOf('          git add --all\n')
    const stagingEnd = workflow.indexOf('          if git diff --cached --quiet;', stagingStart)
    assert.ok(stagingStart >= 0 && stagingEnd > stagingStart)
    const stagingScript = workflow.slice(stagingStart, stagingEnd)

    await withTemporaryDirectory(async (directory) => {
      await execute('git', ['init', '--quiet', directory])
      await writeFile(resolve(directory, '.gitignore'), '.*\n*.md\n')
      await writeFile(resolve(directory, '.sdlc-mcp-managed-pages'), 'Home.md\n_Sidebar.md\n')
      await writeFile(resolve(directory, 'Home.md'), '# Home\n')
      await writeFile(resolve(directory, '_Sidebar.md'), 'Navigation\n')

      await execute('bash', ['-e', '-c', stagingScript], { cwd: directory })

      const { stdout } = await execute('git', ['diff', '--cached', '--name-only'], { cwd: directory })
      assert.deepEqual(stdout.trim().split('\n').sort(), ['.sdlc-mcp-managed-pages', 'Home.md', '_Sidebar.md'].sort())
    })
  })

  test('rejects unmanaged sidebars and identical pages before changing the Wiki', async () => {
    for (const unmanagedPage of ['_Sidebar.md', 'MCP-Users-Guide.md']) {
      await withTemporaryDirectory(async (directory) => {
        const generated = resolve(directory, 'generated')
        const wiki = resolve(directory, 'wiki-repository')
        await mkdir(generated)
        await mkdir(wiki)
        await writeFile(resolve(generated, 'Home.md'), 'New home\n')
        await writeFile(resolve(generated, '_Sidebar.md'), 'Generated sidebar\n')
        await writeFile(resolve(generated, 'MCP-Users-Guide.md'), 'Identical guide\n')
        await writeFile(resolve(wiki, 'Home.md'), 'Original home\n')
        const content = unmanagedPage === '_Sidebar.md' ? 'Custom navigation\n' : 'Identical guide\n'
        await writeFile(resolve(wiki, unmanagedPage), content)
        await writeFile(resolve(wiki, 'MCP-Users-Old.md'), 'Old managed guide\n')
        await writeFile(resolve(wiki, '.sdlc-mcp-managed-pages'), 'MCP-Users-Old.md\n')

        await assert.rejects(syncWikiPages(generated, wiki), /unmanaged GitHub Wiki page/)

        assert.equal(await readFile(resolve(wiki, unmanagedPage), 'utf8'), content)
        assert.equal(await readFile(resolve(wiki, 'Home.md'), 'utf8'), 'Original home\n')
        assert.equal(await readFile(resolve(wiki, 'MCP-Users-Old.md'), 'utf8'), 'Old managed guide\n')
        assert.equal(await readFile(resolve(wiki, '.sdlc-mcp-managed-pages'), 'utf8'), 'MCP-Users-Old.md\n')
      })
    }
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
