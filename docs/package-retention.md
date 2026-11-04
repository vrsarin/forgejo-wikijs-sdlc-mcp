# Manage container image retention

## Purpose

Use the package-retention workflow to limit development and release image versions in GitHub Container Registry (GHCR) without deleting provenance or software bill of materials (SBOM) manifests.

The policy keeps:

- the newest five stable versions across the package;
- five development versions for each active semantic version;
- two beta versions for each active semantic version;
- one release-candidate version for each active semantic version.

When a stable version exists, the workflow removes every development, beta, and release-candidate version with the same semantic-version base. Each base version is evaluated separately so parallel release trains do not consume each other's quotas.

The workflow protects untagged versions, unknown tags, and versions that contain multiple release identities.

## Prerequisite

> **Important:** In the `sdlc-mcp-server` package settings, grant this repository **Admin** under **Manage Actions access**. The workflow token cannot list or delete package versions without package-admin access.

## Preview the retention plan

1. Open **Actions** and select **Package retention**.
2. Select **Run workflow**.
3. Leave **Delete versions selected by the retention plan** disabled.
4. Run the workflow.
5. Review the keep, delete, and protected tables in the workflow summary.

The preview is complete when the workflow succeeds without deleting a package version.

## Apply the retention plan manually

> **Warning:** Applying the plan deletes the package versions listed in the preview. Confirm that no deployment uses those tags before you continue.

1. Run a preview and review every proposed deletion.
2. Open **Run workflow** again.
3. Enable **Delete versions selected by the retention plan**.
4. Run the workflow.
5. Confirm that the workflow summary reports no deletion failure.

The scheduled workflow applies the policy every Monday at 04:30 UTC. A successfully published stable release also applies the policy after its image and provenance attestation are available.
