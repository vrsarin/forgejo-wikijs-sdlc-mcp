# Secure deployment

## Purpose

Use this guide to configure authentication, Transport Layer Security (TLS), and container controls for the MCP servers.

Forgejo Workflow MCP and Wiki.js SDLC MCP can disable OpenID Connect (OIDC) and TLS for an isolated development test. The Home Assistant adapter always requires OIDC because it binds each Home Assistant grant to a verified user.

> **Warning:** Do not connect an unauthenticated MCP server to a shared or untrusted network. A host allowlist and an origin allowlist do not authenticate a caller.

The Home Assistant MCP endpoint is a gateway-to-server raw proxy and intentionally rejects every request carrying an `Origin` header. Its browser-based OAuth routes remain available separately. Forgejo and Wiki.js use `MCP_ALLOWED_ORIGINS` because their native MCP endpoints may be called by explicitly allowlisted browser origins.

## Select a deployment mode

| Environment          | OIDC     | TLS      | Certificate source                        |
| -------------------- | -------- | -------- | ----------------------------------------- |
| Isolated workstation | Disabled | Disabled | None                                      |
| Shared test          | Enabled  | Enabled  | Static files or Let's Encrypt             |
| Production           | Enabled  | Enabled  | Organization-approved certificate service |

Use an immutable image digest in shared test and production environments. Do not use a moving development or prerelease tag for production.

## Configure OIDC

Set these values for each Forgejo or Wiki.js MCP server:

```env
ENABLE_OIDC=true
MCP_OIDC_ISSUER=https://login.example.com/realms/sdlc
MCP_OIDC_RESOURCE=https://mcp.example.com/mcp
MCP_OIDC_AUDIENCE=https://mcp.example.com/mcp
MCP_OIDC_REQUIRED_REALM_ROLE=mcp-user
```

The resource value must be the public MCP endpoint. Configure one role source:

- Set `MCP_OIDC_REQUIRED_REALM_ROLE` for a realm role.
- Set `MCP_OIDC_ROLE_CLIENT_ID` for a client role.

Do not set both variables. The server stops during startup if the OIDC configuration is missing or contradictory.

`MCP_AUTH_MODE=oidc` and static client tokens are compatibility settings. Use `ENABLE_OIDC` for new deployments.

## Configure TLS with static files

Use static mode when a platform or certificate service supplies the certificate:

```env
ENABLE_TLS=true
TLS_MODE=static
TLS_CERT_PATH=/run/tls/tls.crt
TLS_KEY_PATH=/run/tls/tls.key
```

Before you start the server:

1. Mount the certificate and private key as read-only files.
2. Confirm that the runtime user can read both files.
3. Confirm that the certificate covers the public server name.
4. Confirm that the certificate and private key match.

The server monitors both files. It loads a valid renewed pair without a restart. If a renewed pair is invalid or incomplete, the server keeps the last valid pair and writes an error to the log.

## Configure TLS with Let's Encrypt

Use this mode only when the MCP server has a public Domain Name System (DNS) name and can receive an HTTP-01 challenge on TCP port 80.

```env
ENABLE_TLS=true
TLS_MODE=letsencrypt
TLS_DOMAIN=mcp.example.com
TLS_EMAIL=ops@example.com
TLS_ACME_HTTP_PORT=8080
```

Map public port 80 to `TLS_ACME_HTTP_PORT`. Map the public TLS port to MCP port 3000.

```yaml
services:
  forgejo-mcp:
    ports:
      - "80:8080"
      - "443:3000"
    volumes:
      - forgejo-mcp-data:/data
```

Certbot stores certificates under `/data/letsencrypt` by default. The application serves those files directly and reloads a valid renewal.

One host address cannot map public ports 80 and 443 to multiple MCP containers. Assign a different address to each public server, or use an approved ingress design.

## Apply container controls

The published images run as a non-root user. Application files are not writable by that user. The intended persistent write location is `/data`.

Apply these runtime controls:

- Set the root filesystem to read-only.
- Drop all Linux capabilities.
- Set `no-new-privileges`.
- Set a process identifier limit.
- Mount `/tmp` as a small `tmpfs` with `noexec`, `nosuid`, and `nodev`.
- Do not mount a container-engine socket.
- Do not run the container as privileged.

The repository Compose files apply these controls. Preserve them in another deployment platform.

## Promote a release image

Promote one immutable image digest through TEST, user acceptance testing (UAT), and production. Do not rebuild or replace the image between environments.

1. Verify the image digest, source commit, software bill of materials (SBOM), vulnerability results, provenance, and attestation.
2. Deploy the digest to TEST.
3. Run the required functional, security, compatibility, performance, and rollback tests.
4. Obtain the required approval before UAT deployment.
5. Deploy the same digest to UAT.
6. Run the approved acceptance scenarios.
7. Obtain the production approval after the UAT owner signs off.
8. Deploy the same digest to production.
9. Run production smoke tests and observe the defined health indicators.

Apply these controls to shared environments:

- prevent self-approval when separation of duties is required;
- restrict deployments to approved source branches and tags;
- keep credentials and workload identities scoped to one environment;
- allow only one deployment to a shared target at a time;
- record the digest, tests, approval, deployment result, and rollback digest;
- make the next promotion available only after the current environment passes.

If TEST or UAT rejects a stable release, do not replace the image or move its Git tag. Correct the source and create a new patch release. Restore the previously verified digest when a failed deployment affects service health.

## Verify the deployment

1. Request `/healthz` with the expected scheme and server name.
2. Confirm that an invalid host receives HTTP 403.
3. If OIDC is enabled, confirm that a missing or invalid token receives HTTP 401.
4. Confirm that a valid token for a different MCP audience is rejected.
5. Complete an MCP `initialize` request and a `tools/list` request.
6. Confirm that the container has no unexpected writable path or Linux capability.

The deployment is ready when all checks give the expected result.

## Build evidence

The release pipeline tests and scans each image for the supported architectures. The git server, CI/CD system, and registry publish current pipeline results, code-scanning results, software bills of materials, provenance, and attestations. Review that live evidence before deployment. Rebuild an image when a relevant dependency or base-image update becomes available.
