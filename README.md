# Standalone SDLC MCP servers

[![Container images](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/actions/workflows/container-images.yml/badge.svg?branch=main)](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/actions/workflows/container-images.yml?query=branch%3Amain)
[![CodeQL](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/actions/workflows/codeql.yml?query=branch%3Amain)
[![Repository security](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/actions/workflows/repository-security.yml/badge.svg?branch=main)](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/actions/workflows/repository-security.yml?query=branch%3Amain)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/vrsarin/forgejo-wikijs-sdlc-mcp/badge)](https://securityscorecards.dev/viewer/?uri=github.com/vrsarin/forgejo-wikijs-sdlc-mcp)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

This repository provides one Model Context Protocol (MCP) image for Forgejo, Wiki.js, and Home Assistant. Set `PROVIDER=forgejo`, `PROVIDER=wikijs`, or `PROVIDER=homeassistant` for each deployment. You can connect a deployment directly to VS Code, Claude, Codex, or an MCP gateway.

Deployment platforms, identity providers, gateways, and provider applications are outside this repository. Use the servers independently or connect them to the bot, gateway, or integration harness that meets your requirements.

## Components

| Component                 | Purpose                                                          | Default write posture                      |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| Forgejo MCP server        | Repository, issue, pull-request, review, and workflow operations | Disabled and repository-allowlisted        |
| Wiki.js SDLC MCP server   | Permission-aware Wiki.js capability discovery                    | Discovery only; provider permissions apply |
| Home Assistant MCP server | User-bound Home Assistant discovery and tool execution           | OIDC identity and per-user grants required |

The Forgejo and Wiki.js HTTP servers support optional OIDC authentication and native TLS. Development can disable those features explicitly; test and production deployments should enable both. TLS is terminated by the Node server itself, preserving the path toward gateway-to-backend mTLS. The Home Assistant adapter remains OIDC-only because its grants are bound to a verified user identity.

## Security model

- OIDC tokens are issuer, audience, resource, and role constrained.
- Provider grants are encrypted at rest and bound to verified user identities.
- Forgejo write tools are off by default and require allowlisting, confirmation, a reason, idempotency where applicable, and provider read-back.
- Published containers run as non-root, exclude package-manager tooling, and are intended for read-only root filesystems with all capabilities dropped.
- CI blocks releases on high or critical dependency, image, secret, or container-configuration findings.
- Release images include an SBOM, provenance, and a GitHub artifact attestation.

See [Secure deployment](docs/deployment-security.md) for the OIDC, TLS, and container requirements.

## Development

Requirements:

- Node.js 22 or later
- Docker (only when building container images)
- GNU Make

Install the locked dependencies:

```bash
make install
```

Run the package checks, tests, and image builds:

```bash
make check
make coverage
make images
```

The coverage command fails when aggregate line coverage is below 85%. It writes a Cobertura report to `.coverage/cobertura-coverage.xml`; CI stores that report as a workflow artifact for seven days.

The repository includes a narrow Compose harness for testing the images over Streamable HTTP. It launches only the MCP servers; you supply the provider and identity services. Use the checked-in `.mcp.json` or `.vscode/mcp.json` as direct client examples after starting a server on ports 3010, 3011, or 3012.

See [Deploy and test over Streamable HTTP](docs/streamable-http.md) for local image builds, released GHCR images, VS Code `stdio` testing, client credentials, OIDC, native TLS, the smoke-test helper, and Home Assistant requirements.

Use an external integration harness to test a complete identity-provider, gateway, provider, and bot topology.

## Documentation

- [Project wiki](wiki/README.md)
- [Run and test an MCP server](docs/streamable-http.md)
- [Secure deployment](docs/deployment-security.md)
- [Manage container image retention](docs/package-retention.md)
- [Documentation policy and style guide](docs/documentation.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Container images

Successful image workflows publish one multi-architecture image to GitHub Container Registry:

```text
ghcr.io/vrsarin/sdlc-mcp-server
```

The repository uses the stable version in `VERSION` to create unique Semantic Versioning (SemVer) image versions at each promotion stage:

| Source event | Example image version | Intended use |
| --- | --- | --- |
| Push to `feature/*`, `bug/*`, or `hotfix/*` | `0.1.0-dev.42.1` | Milestone change integration |
| Milestone branch `release/identity-hardening` | `0.1.0-beta.56.1` | Integrated SIT and TEST |
| Merge into `main` | `0.1.0-rc.61.1` | Release-candidate testing |
| Published git server release `v0.1.0` | `0.1.0` | Certified release |

The `release/<milestone-name>` branch is the milestone branch. Its name identifies the planned outcome, not a version. The `VERSION` file records the current intended SemVer version and can change without renaming the milestone branch. A `feature/*`, `bug/*`, or `hotfix/*` branch is a milestone change branch and must start from the applicable milestone branch. The counters make concurrent milestone change and milestone-branch images unique. Pull requests build, test, and scan the proposed merge without publishing another image version. Each published image records its source ref, source commit, CI/CD run, SBOM, maximum build provenance, and artifact attestation. Only a published stable release creates a stable image version. The release tag must match `VERSION`.

Use a certified version or immutable digest in production. Use development, beta, and release-candidate versions only in their designated test stage.

The [package-retention workflow](docs/package-retention.md) keeps five stable versions and applies separate development, beta, and release-candidate quotas to each active semantic-version line.

## Security and build evidence

GitHub Actions runs CodeQL, Trivy, dependency review, npm audit, and OpenSSF Scorecard checks. GitHub publishes current results in the repository **Actions** and **Security** views. Released images include an SBOM, build provenance, and an artifact attestation.

Each published stable release also includes these generated assets:

- a changelog for the commits since the previous release;
- Markdown and JSON verification reports;
- a CycloneDX SBOM for each container image;
- a compressed evidence bundle with detailed check logs;
- SHA-256 checksums for all release-evidence assets.

The release workflow generates these assets from the release tag. The repository does not store point-in-time reports.

Please report vulnerabilities privately according to [SECURITY.md](SECURITY.md). For normal changes, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under [AGPL-3.0-only](LICENSE).
