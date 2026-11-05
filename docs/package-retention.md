# Manage container image retention

## Purpose

Use the package-retention workflow to limit development and release image versions in GitHub Container Registry (GHCR) without deleting provenance or software bill of materials (SBOM) manifests.

The policy keeps:

- the newest five stable versions across the package;
- five development versions for each active semantic version;
- two beta versions for each active semantic version;
- one release-candidate version for each active semantic version.

When a stable version exists, the workflow removes every development, beta, and release-candidate version at or below the newest stable semantic version. It keeps prereleases for versions newer than the latest stable release. Each remaining base version is evaluated separately so parallel release trains do not consume each other's quotas.

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

The scheduled workflow applies the policy every Monday at 04:30 UTC. Every successful image publication also applies the policy after its image and provenance attestation are available. Pull-request runs do not publish images or apply retention.

Cleanup runs can overlap across branches or workflows. If another run already deleted a selected version, a deletion response of HTTP 404 is logged as already absent and succeeds. Other API errors still fail cleanup; a 404 while listing package versions is also fatal.

## Prerelease tags remain after a stable release

A branch that still uses the released `VERSION` can publish new development, beta, or release-candidate tags after the stable release cleanup. Retention removes these tags at the end of each successful publication, even when their creation date is newer than the stable image.

Set `VERSION` to the next intended release on the milestone branch and synchronize its change branches before publishing images for the next milestone. Prereleases must have a semantic version newer than the newest stable image to remain available.

If superseded tags remain after publication, check the **Remove superseded package versions** step in the **Container images** workflow. Run a manual retention preview to inspect existing tags and deletion decisions. Untagged manifests and unknown tags, including `sha256-` attestation tags, remain protected.
