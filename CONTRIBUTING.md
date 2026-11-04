# Contributing

Thank you for helping improve the standalone SDLC MCP servers.

## Development workflow

The development workflow starts with a planned release milestone and ends with an immutable stable release.

Use these branch terms consistently:

- **Milestone branch:** The `release/<milestone-name>` branch that owns the milestone scope and integrated result. Its name does not contain the release version.
- **Milestone change branch:** A `feature/*`, `bug/*`, or `hotfix/*` branch that delivers one change to the milestone branch.

Use lowercase letters, numbers, periods, underscores, or hyphens for `<milestone-name>`. Start it with a letter or number. Do not include a SemVer version anywhere in the name.

Create every milestone change branch from its milestone branch, not from `main`. The `main` branch accepts only a milestone branch that completed the required integration and release-candidate checks.

| Source state | Published maturity | Recommended validation |
| --- | --- | --- |
| Milestone change branch: `feature/*`, `bug/*`, or `hotfix/*` | Development | DEV, then change-level SIT |
| Milestone branch: `release/<milestone-name>` | Beta | Shared SIT, then TEST |
| Merge into `main` | Release candidate | Release-candidate certification |
| Published git server release | Stable | TEST, UAT, then PROD |

### Plan the release

Classify the milestone before development starts:

| Milestone type | Typical scope | Typical SemVer change |
| --- | --- | --- |
| Feature release | New compatible capabilities or an intentional breaking change | Minor or major |
| Bug-fix release | A planned set of compatible corrections | Patch |
| Hotfix release | An urgent correction for a released production version | Patch |

1. Select the milestone type, scope, and descriptive milestone name.
2. Define the entry and exit criteria for DEV, system integration testing (SIT), TEST, user acceptance testing (UAT), and production.
3. Create `release/<milestone-name>` from a healthy `main` branch. For a hotfix, use the source commit for the affected production release.
4. Set `VERSION` to the current intended stable SemVer version without a `v` prefix.
5. Commit the version change on the milestone branch.
6. Protect the milestone branch with the required reviews and CI checks.

The milestone branch owns `VERSION`. A maintainer can update `VERSION` when the approved milestone scope requires a different SemVer increment. Do not rename the milestone branch when `VERSION` changes. Synchronize active milestone change branches after the version update. Milestone change branches must not change `VERSION` independently.

If you are not a milestone maintainer, ask a maintainer which milestone branch must receive your change.

A hotfix can use an accelerated schedule, but it must retain required reviews, security checks, immutable image provenance, environment testing, production approval, and rollback evidence. Merge the completed correction into applicable active milestone branches to prevent regression.

### Develop a milestone change

1. Create a `feature/*`, `bug/*`, or `hotfix/*` branch from the applicable milestone branch:
   - Use `feature/*` for a new capability.
   - Use `bug/*` for a defect correction that is not an urgent production hotfix.
   - Use `hotfix/*` for an urgent correction to a released production version.
2. Keep the branch focused on one milestone feature or correction.
3. Keep credentials and generated runtime files out of the repository.
4. Install the locked dependencies and activate the Git hooks.

   ```sh
   make install
   ```

5. Implement the change and its allowed-path, denied-path, and regression tests.
6. Commit the change to run the complete local pre-commit verification.
7. Push the milestone change branch to publish its unique development image.
8. Test the immutable development image in DEV and change-level SIT.
9. Open the pull request against the milestone branch after the change exit criteria pass.
10. Add the local verification check table to the pull request description, or attach the Markdown evidence file.
11. Describe the changelog entry, security impact, configuration changes, and rollback considerations.
12. Merge only after the required reviews and CI checks pass.

### Integrate the milestone

1. Use the beta image produced after the milestone change merges into the milestone branch.
2. Deploy the beta digest to shared SIT.
3. Run the integration and negative-access suites.
4. Promote the same digest to TEST after SIT approval.
5. Run the complete regression, security, compatibility, and rollback suites.
6. Repeat the beta cycle after each correction.
7. Freeze the milestone branch when the milestone scope and exit criteria are complete.
8. Open a pull request from the milestone branch to `main`.

Do not add new features after the release freeze. Accept only corrections, documentation, and release preparation changes.

### Certify and publish the release

1. Merge the approved milestone branch into `main` to publish the unique release-candidate image.
2. Verify the release-candidate source, image digest, SBOM, scans, provenance, and attestation.
3. Complete the release-candidate test plan.
4. Create the release on the git server with a tag that matches `VERSION`, such as `v1.2.3` for version `1.2.3`.
5. Confirm that the release workflow publishes the stable image and attaches its changelog and verification evidence.
6. Promote the stable digest through TEST, UAT, and PROD according to the approved deployment process.
7. Close the milestone after the production observation period passes.

**Warning:** Do not replace a stable image or move its Git tag after publication. If TEST or UAT rejects the stable release, correct the source and create a new patch release.

## Local verification

The pre-commit hook runs lint, dependency audits, checks, tests, Compose validation, container builds, vulnerability and configuration scans, dedicated secret scans, and CycloneDX software bill of materials (SBOM) generation. The post-commit hook binds the evidence to the new commit SHA.

Run `make pre-commit` to create verification evidence without creating a commit. Detailed logs and the latest Markdown and JSON summaries are under `.artifacts/pre-commit/`. Generated SBOM files are under `.artifacts/sbom/`. Git ignores these directories. Do not commit point-in-time scan evidence.

This repository does not contain a provider or platform deployment stack. Its Compose files test only the MCP servers. Test package behavior with the unit suites and a direct VS Code or Claude connection. Test full-system changes with an external integration harness.

Changes to authentication, authorization, TLS, token storage, tool write behavior, or release workflows require tests for both the allowed and denied paths. New write tools must remain disabled by default, validate their scope, require explicit confirmation, and verify the provider result.

## Pull requests

Keep each pull request focused. Do not include unrelated formatting changes. Update the documentation when behavior or environment variables change. Continuous integration (CI) must pass before merge. Local pre-commit evidence supports review, but it does not replace the security results from the git server and CI/CD system.

Use a Conventional Commit pull request title. Add a `## Changelog` section with at least one release-ready bullet. Start each bullet with `Added:`, `Changed:`, `Fixed:`, `Security:`, `Deprecated:`, `Removed:`, or `Internal:`. Use `Internal:` for a change that has no user-visible effect. The **PR changelog / Validate changelog** check rejects missing sections, placeholders, uncategorized entries, and invalid titles.

Do not weaken a security gate. A scanner exception must have a narrow scope, a written rationale, an owner, and an expiration date.

Follow the [documentation policy and style guide](docs/documentation.md) for user and developer documentation. Do not add architecture decisions, handover notes, point-in-time security reports, or copies of information that the git server or CI/CD system already maintains.

## Release controls

Milestone change-branch pushes and merges into the milestone and `main` branches publish unique development, beta, and release-candidate image versions. Pull requests build, test, and scan without publishing another image version. These stages do not create Git tags.

Do not create a prerelease in the git server. The automated development, beta, and release-candidate stages provide the prerelease versions. The container pipeline publishes a stable image only from a published stable release whose tag matches `VERSION`.

The release-evidence workflow checks out the exact release tag and repeats the local pre-commit verification suite. If all checks pass, it attaches the generated changelog, verification reports, SBOMs, detailed logs, and checksums. If a check fails, it does not attach passing evidence.

Do not upload locally generated evidence to a release. Use the assets from the release-evidence pipeline so that reviewers can trace them to the CI/CD run.

## Security reports

Do not open public issues for suspected vulnerabilities. Follow [SECURITY.md](SECURITY.md) instead.

By contributing, you agree that your contribution is licensed under the repository's AGPL-3.0-only license.
