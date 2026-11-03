# Contributing

Thank you for helping improve the standalone SDLC MCP servers.

## Development workflow

1. Create a focused branch from `main`.
2. Keep credentials and generated runtime files out of the repository.
3. Run `make install` to install the locked dependencies and activate the Git pre-commit hook.
4. Commit the staged change. The hook runs lint, dependency audits, checks, tests, Compose validation, container builds, vulnerability and configuration scans, dedicated secret scans, and CycloneDX software bill of materials (SBOM) generation.
5. Open `.artifacts/pre-commit/latest.md` after the commit completes. The post-commit hook binds the report to the commit SHA.
6. Add the check table to the pull request description, or attach the Markdown file to the pull request.
7. Describe security implications and configuration changes in the pull request.

Run `make pre-commit` to create verification evidence without creating a commit. Detailed logs and the latest Markdown and JSON summaries are under `.artifacts/pre-commit/`. Generated SBOM files are under `.artifacts/sbom/`. Git ignores these directories. Do not commit point-in-time scan evidence.

This repository does not contain a provider or platform deployment stack. Its Compose files test only the MCP servers. Test package behavior with the unit suites and a direct VS Code or Claude connection. Test full-system changes with an external integration harness.

Changes to authentication, authorization, TLS, token storage, tool write behavior, or release workflows require tests for both the allowed and denied paths. New write tools must remain disabled by default, validate their scope, require explicit confirmation, and verify the provider result.

## Pull requests

Keep each pull request focused. Do not include unrelated formatting changes. Update the documentation when behavior or environment variables change. Continuous integration (CI) must pass before merge. Local pre-commit evidence supports review, but it does not replace CI or GitHub security results.

Use a Conventional Commit pull request title. Add a `## Changelog` section with at least one release-ready bullet. Start each bullet with `Added:`, `Changed:`, `Fixed:`, `Security:`, `Deprecated:`, `Removed:`, or `Internal:`. Use `Internal:` for a change that has no user-visible effect. The **PR changelog / Validate changelog** check rejects missing sections, placeholders, uncategorized entries, and invalid titles.

Do not weaken a security gate. A scanner exception must have a narrow scope, a written rationale, an owner, and an expiration date.

Follow the [documentation policy and style guide](docs/documentation.md) for user and developer documentation. Do not add architecture decisions, handover notes, point-in-time security reports, or copies of information that GitHub already maintains.

## Releases

Use a semantic version tag such as `v1.2.3`. Publish the tag as a GitHub Release. The release-evidence workflow checks out the exact tag and repeats the local pre-commit verification suite. If all checks pass, the workflow attaches the generated changelog, verification reports, SBOMs, detailed logs, and checksums to the release. If a check fails, the workflow does not attach passing evidence.

Do not upload locally generated evidence to a release. Use the assets from the release-evidence workflow so that reviewers can trace them to the GitHub Actions run.

## Security reports

Do not open public issues for suspected vulnerabilities. Follow [SECURITY.md](SECURITY.md) instead.

By contributing, you agree that your contribution is licensed under the repository's AGPL-3.0-only license.
