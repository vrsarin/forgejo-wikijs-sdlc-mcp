# Troubleshooting

Start with the observable symptom, then apply the corresponding corrective action.

| Symptom                                                        | Corrective action                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup reports `PROVIDER must be one of`                      | Set `PROVIDER` to exactly `forgejo`, `wikijs`, or `homeassistant`.                                                                          |
| Forgejo stdio startup reports a missing access token           | Set `FORGEJO_ACCESS_TOKEN` in the local process environment or use the checked-in VS Code password prompt.                                  |
| Forgejo rejects a repository                                   | Add the exact `owner/repository` value to `SDLC_ALLOWED_REPOSITORIES`. Also verify the caller's Forgejo permissions.                        |
| Forgejo write tools are missing                                | They are not registered unless `SDLC_ENABLE_WRITES=true`. Keep writes disabled unless the deployment has approved and tested them.          |
| Wiki.js rejects its endpoint configuration                     | Set `WIKIJS_MCP_URL` to the official endpoint and confirm its path ends in `/_mcp`.                                                         |
| Wiki.js reports no connection or no capabilities               | Supply a caller credential or configure the OAuth connection, then verify that the Wiki.js account can access its MCP endpoint.             |
| HTTP request returns `Host is not allowed`                     | Add only the expected server hostname to the provider's allowed-hosts configuration. Do not use an unrestricted host list.                  |
| HTTP request returns 401                                       | Check the MCP caller token, OIDC issuer, audience/resource values, and required role or group.                                              |
| HTTP request returns 403                                       | Check the token's authorization claims and, for Forgejo, the repository allowlist and provider permissions.                                 |
| Configuration rejects an HTTP upstream URL                     | Use HTTPS. Permit insecure HTTP only for an isolated local development test.                                                                |
| Home Assistant fails at startup due to authentication settings | Enable OIDC, configure the required group and discovery client ID, and use the HTTP transport. Home Assistant does not support stdio.       |
| Home Assistant rejects its discovery subject                   | Ensure the mounted file is readable and contains a UUID. Check `HOMEASSISTANT_DISCOVERY_SUBJECT_FILE_HOST` and the Compose mount.           |
| Home Assistant cannot connect to its upstream                  | Check that `HOMEASSISTANT_INTERNAL_URL` resolves from the adapter, uses HTTPS, and presents a valid certificate.                            |
| A local MCP server does not start in VS Code                   | Run `make install` and `make build`; then inspect the MCP server output in VS Code.                                                         |
| Local container is not ready                                   | Check the selected Compose profile, environment values, logs, and health status. Confirm the upstream host is reachable from the container. |

For a shared deployment, keep OIDC and TLS enabled while troubleshooting. Do not expose the unauthenticated local defaults to a shared network.
