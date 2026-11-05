# Publish to GitHub Wiki

The Markdown files in the repository's `wiki/` directory are the source of truth. The `Publish GitHub Wiki` workflow converts them to GitHub Wiki page names and publishes updates after matching changes merge to `main`.

## One-time setup

Prerequisites:

- GitHub Wiki is enabled for the repository.
- You can create GitHub Wiki pages and repository Actions secrets.
- You have a token that can push to this repository's Wiki.

1. Open the repository's **Wiki** tab and create the first page. GitHub does not provide the Wiki Git repository until an initial page exists. The first successful workflow run replaces the `Home` page with content from `wiki/README.md`.

2. Add a repository Actions secret named `WIKI_PUBLISH_TOKEN`. Set its value to a token that can push to this repository's Wiki. Do not put the token in a workflow file or repository variable.

3. Merge a change to `wiki/` or `.github/workflows/publish-wiki.yml` into `main`.

The workflow runs only on `main`. It uses a read-only `GITHUB_TOKEN` for checkout and `WIKI_PUBLISH_TOKEN` only for the Git push to the separate Wiki repository. Keep the token scoped to the minimum repository access supported by your GitHub token type and organization policy.

## Sync behavior

- `wiki/README.md` becomes the GitHub Wiki `Home` page.
- Other Markdown files become flat page names with the `MCP-` prefix. For example, `wiki/users/forgejo.md` becomes `MCP-Users-Forgejo`.
- Relative links between Markdown pages are rewritten to GitHub Wiki page links. Links to other repository files point to their `main` branch paths.
- The workflow generates `_Sidebar.md` from the source pages.
- The workflow records its generated pages in `.sdlc-mcp-managed-pages`. It updates and removes only pages recorded in that manifest. It preserves unrelated Wiki pages.
- Do not edit generated pages in GitHub Wiki. Edit the matching file under `wiki/` and publish again.

If a generated page name already exists but is not in the manifest, the workflow stops rather than adopting or overwriting it, even if its content matches. This also protects a custom `_Sidebar.md`. The only exception is `Home.md`, which the first sync replaces as described above. Rename or move conflicting Wiki pages before retrying.

## Troubleshoot a failed publication

| Symptom | Corrective action |
| --- | --- |
| `WIKI_PUBLISH_TOKEN` is missing | Add the repository Actions secret with that exact name, then rerun the failed workflow. |
| The Wiki Git repository cannot be cloned | Create the first page in the GitHub Wiki, then rerun the failed workflow. Confirm the secret can push to the Wiki. |
| Publication reports an unmanaged page conflict | Move or rename the conflicting Wiki page, or review its content before removing it. Do not delete the managed-page manifest. |
| A local Markdown link cannot be resolved | Correct the source link under `wiki/`; run `node scripts/sync-wiki.mjs build /tmp/generated-wiki` to verify it. |
| The output directory is not empty | Use a fresh, empty output directory for each build. Existing generated pages are not reused. |
