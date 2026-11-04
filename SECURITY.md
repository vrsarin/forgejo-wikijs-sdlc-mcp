# Security policy

Security is a release requirement for this project. Please report suspected vulnerabilities privately so maintainers have time to investigate and publish a coordinated fix.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/vrsarin/forgejo-wikijs-sdlc-mcp/security/advisories/new). Do not include credentials, tokens, personal data, or exploit details in a public issue.

Include, when possible:

- The affected component and version or commit
- The security impact and realistic attack path
- Minimal reproduction steps or a proof of concept
- Whether the issue is public or is being actively exploited
- A suggested mitigation, if one is available

You should receive an acknowledgement within three business days and an initial assessment within seven business days. Resolution timing depends on severity and release risk. Maintainers will coordinate disclosure and credit with the reporter.

## Supported versions

Security fixes are applied to the latest release and the default branch. Older images and moving development tags are not supported. Production deployments should use an immutable image digest from a supported release.

## Scope

In scope are the MCP servers, authentication and authorization boundaries, token handling, provider integrations, TLS behavior, container images, release workflows, and deployment configuration maintained in this repository.

Third-party services and upstream images are governed by their own security policies. Reports that demonstrate an unsafe integration or exploitable configuration in this project are still welcome.

## Release security controls

Pull requests and releases are checked with CodeQL, Trivy repository and image scanning, dependency review, npm audit, tests, and container configuration scanning. Published images include an SBOM, build provenance, and a GitHub artifact attestation. A clean automated scan means no matching known finding was detected at that time; it is not a permanent guarantee.
