# Standalone SDLC MCP servers

[![Container images](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/actions/workflows/container-images.yml/badge.svg)](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/actions/workflows/container-images.yml)
[![CodeQL](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/actions/workflows/codeql.yml)
[![Repository security](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/actions/workflows/repository-security.yml/badge.svg)](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/actions/workflows/repository-security.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/vrsarin/forgejo-wikijs-sdlc-mcp/badge)](https://securityscorecards.dev/viewer/?uri=github.com/vrsarin/forgejo-wikijs-sdlc-mcp)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

This repository provides Model Context Protocol (MCP) servers for Forgejo, Wiki.js, and Home Assistant. You can deploy each server independently. You can connect it directly to VS Code, Claude, Codex, or an MCP gateway.

Deployment platforms, identity providers, gateways, and provider applications are outside this repository. Use the servers independently or connect them to the bot, gateway, or integration harness that meets your requirements.

## Components

| Component                 | Purpose                                                          | Default write posture                      |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| Forgejo MCP server        | Repository, issue, pull-request, review, and workflow operations | Disabled and repository-allowlisted        |
| Wiki.js SDLC MCP server   | Permission-aware Wiki.js discovery and content operations        | Provider permissions apply                 |
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
make test
make images
```

The repository includes a narrow Compose harness for testing the images over Streamable HTTP. It launches only the MCP servers; you supply the provider and identity services. Use the checked-in `.mcp.json` or `.vscode/mcp.json` as direct client examples after starting a server on ports 3010, 3011, or 3012.

See [Deploy and test over Streamable HTTP](docs/streamable-http.md) for local image builds, released GHCR images, VS Code `stdio` testing, client credentials, OIDC, native TLS, the smoke-test helper, and Home Assistant requirements.

Use an external integration harness to test a complete identity-provider, gateway, provider, and bot topology.

## Documentation

- [Run and test an MCP server](docs/streamable-http.md)
- [Secure deployment](docs/deployment-security.md)
- [Documentation policy and style guide](docs/documentation.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Container images

Successful `main` and `v*` release workflows publish multi-architecture images to GitHub Container Registry:

```text
ghcr.io/vrsarin/forgejo-mcp-server
ghcr.io/vrsarin/wikijs-sdlc-mcp-server
ghcr.io/vrsarin/homeassistant-mcp-server
```

Use a released version or immutable digest in shared environments. Development and prerelease tags are intended for integration testing, not production pinning.

## Security and build evidence

GitHub Actions runs CodeQL, Trivy, dependency review, npm audit, and OpenSSF Scorecard checks. GitHub publishes current results in the repository **Actions** and **Security** views. Released images include an SBOM, build provenance, and an artifact attestation.

Each published GitHub Release also includes these generated assets:

- a changelog for the commits since the previous release;
- Markdown and JSON verification reports;
- a CycloneDX SBOM for each container image;
- a compressed evidence bundle with detailed check logs;
- SHA-256 checksums for all release-evidence assets.

The release workflow generates these assets from the release tag. The repository does not store point-in-time reports.

Please report vulnerabilities privately according to [SECURITY.md](SECURITY.md). For normal changes, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under [AGPL-3.0-only](LICENSE).
