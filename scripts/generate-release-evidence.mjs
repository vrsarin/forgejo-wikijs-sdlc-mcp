#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = resolve(repositoryRoot, ".artifacts/release-assets");
const bundleRoot = resolve(repositoryRoot, ".artifacts/release-bundle");
const bundleLogRoot = resolve(bundleRoot, "logs");
const releaseTag = process.env.RELEASE_TAG ?? "";
const repositoryName =
  process.env.CI_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "";
const serverUrl =
  process.env.CI_SERVER_URL ?? process.env.GITHUB_SERVER_URL ?? "";
const githubRunId = process.env.GITHUB_RUN_ID ?? "";
const intendedVersion = readFileSync(
  resolve(repositoryRoot, "VERSION"),
  "utf8",
).trim();

if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(releaseTag)) {
  throw new Error(
    `Release tag is not a supported semantic version: ${releaseTag}`,
  );
}
if (releaseTag !== `v${intendedVersion}`) {
  throw new Error(
    `Release tag ${releaseTag} must match VERSION (v${intendedVersion})`,
  );
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName)) {
  throw new Error(`CI_REPOSITORY is invalid: ${repositoryName}`);
}

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options,
  }).trim();
}

function escapeMarkdown(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("|", "\\|")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findPreviousTag() {
  try {
    return command(
      "git",
      [
        "describe",
        "--tags",
        "--match",
        "v[0-9]*",
        "--abbrev=0",
        `${releaseTag}^`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return "";
  }
}

function readCommits(previousTag) {
  const range = previousTag ? `${previousTag}..${releaseTag}` : releaseTag;
  const output = command("git", [
    "log",
    "--no-merges",
    "--format=%H%x1f%h%x1f%s%x1e",
    range,
  ]);
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, shortSha, ...subjectParts] = record.split("\x1f");
      return { sha, shortSha, subject: subjectParts.join(" ").trim() };
    });
}

function imageDetails(name) {
  const output = command("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}|{{.Size}}",
    name,
  ]);
  const [id, size] = output.split("|");
  return { name, id, sizeBytes: Number(size) };
}

mkdirSync(assetRoot, { recursive: true });
mkdirSync(bundleLogRoot, { recursive: true });

const releaseCommit = command("git", [
  "rev-parse",
  "--verify",
  `${releaseTag}^{commit}`,
]);
const headCommit = command("git", ["rev-parse", "--verify", "HEAD"]);
if (releaseCommit !== headCommit) {
  throw new Error(
    `Checked-out commit ${headCommit} does not match ${releaseTag} (${releaseCommit})`,
  );
}

const evidencePath = resolve(
  repositoryRoot,
  ".artifacts/pre-commit/latest.json",
);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
if (evidence.status !== "PASS") {
  throw new Error("Release verification did not pass");
}

const expectedChecks = 10;
if (
  evidence.results.length !== expectedChecks ||
  evidence.results.some((result) => result.exitCode !== 0)
) {
  throw new Error(`Expected ${expectedChecks} successful release checks`);
}

const previousTag = findPreviousTag();
const commits = readCommits(previousTag);
const repositoryUrl =
  process.env.CI_REPOSITORY_URL ??
  (serverUrl ? `${serverUrl}/${repositoryName}` : "");
if (!repositoryUrl) {
  throw new Error("CI_REPOSITORY_URL or CI_SERVER_URL is required");
}
const commitUrlPrefix =
  process.env.CI_COMMIT_URL_PREFIX ?? `${repositoryUrl}/commit`;
const generatedAt = new Date().toISOString();
const runUrl =
  process.env.CI_RUN_URL ??
  (githubRunId
    ? `${repositoryUrl}/actions/runs/${githubRunId}`
    : repositoryUrl);
const images = [
  imageDetails("sdlc-mcp-server:dev"),
];

const sboms = [
  ["sdlc-mcp-server.cdx.json", "sdlc-mcp-server.cdx.json"],
].map(([sourceName, assetName]) => {
  const source = resolve(repositoryRoot, ".artifacts/sbom", sourceName);
  const asset = resolve(assetRoot, assetName);
  const bundleAsset = resolve(bundleRoot, assetName);
  const bom = JSON.parse(readFileSync(source, "utf8"));
  if (
    bom.bomFormat !== "CycloneDX" ||
    !Array.isArray(bom.components) ||
    bom.components.length === 0
  ) {
    throw new Error(`Invalid CycloneDX SBOM: ${sourceName}`);
  }
  copyFileSync(source, asset);
  copyFileSync(source, bundleAsset);
  return {
    file: assetName,
    components: bom.components.length,
    sha256: sha256(asset),
  };
});

for (const result of evidence.results) {
  const source = resolve(repositoryRoot, result.log);
  copyFileSync(source, resolve(bundleLogRoot, basename(result.log)));
}

const changeLines = commits.length
  ? commits.map(
      (commit) =>
        `- ${escapeMarkdown(commit.subject)} ([${commit.shortSha}](${commitUrlPrefix}/${commit.sha}))`,
    )
  : ["- No non-merge commits were found."];
const comparison = previousTag
  ? `[${previousTag}...${releaseTag}](${process.env.CI_COMPARE_URL ?? `${repositoryUrl}/compare/${previousTag}...${releaseTag}`})`
  : "Initial release";
const changelog = `# ${releaseTag} changelog

Released from commit [\`${releaseCommit.slice(0, 12)}\`](${commitUrlPrefix}/${releaseCommit}).

Comparison: ${comparison}

## Changes

${changeLines.join("\n")}
`;

const checkRows = evidence.results.map(
  (result) =>
    `| ${escapeMarkdown(result.name)} | PASS | ${result.durationSeconds} s | \`${escapeMarkdown(result.command)}\` |`,
);
const imageRows = images.map(
  (image) => `| \`${image.name}\` | \`${image.id}\` | ${image.sizeBytes} |`,
);
const sbomRows = sboms.map(
  (sbom) => `| \`${sbom.file}\` | ${sbom.components} | \`${sbom.sha256}\` |`,
);
const verification = `# ${releaseTag} release verification

Overall result: **PASS**

| Field | Value |
| --- | --- |
| Generated (UTC) | ${generatedAt} |
| Release tag | \`${releaseTag}\` |
| Release commit | [\`${releaseCommit}\`](${commitUrlPrefix}/${releaseCommit}) |
| CI/CD run | [View the pipeline run](${runUrl}) |
| Node.js | \`${evidence.node}\` |
| Docker Engine | \`${evidence.docker}\` |
| Trivy image | \`${evidence.scanner}\` |

## Verification checks

| Check | Result | Duration | Command |
| --- | --- | ---: | --- |
${checkRows.join("\n")}

The successful Trivy gates confirm zero detected secrets and zero high or critical vulnerabilities in the tested scope. Detailed logs are in \`release-evidence.tar.gz\`.

## Tested container images

These image identifiers refer to the local images built from the release commit for verification. Registry images have separate attestations and digests.

| Image | Local image identifier | Size (bytes) |
| --- | --- | ---: |
${imageRows.join("\n")}

## Software bills of materials

| CycloneDX file | Components | SHA-256 |
| --- | ---: | --- |
${sbomRows.join("\n")}
`;

const verificationJson = {
  schemaVersion: 1,
  status: "PASS",
  generatedAt,
  release: {
    tag: releaseTag,
    commit: releaseCommit,
    previousTag: previousTag || null,
    repository: repositoryName,
    pipelineRun: runUrl,
  },
  environment: {
    node: evidence.node,
    docker: evidence.docker,
    trivyImage: evidence.scanner,
  },
  findings: {
    secrets: 0,
    highOrCriticalVulnerabilities: 0,
  },
  checks: evidence.results,
  images,
  sboms,
  commits,
};

const assets = [
  ["CHANGELOG.md", changelog],
  ["RELEASE-VERIFICATION.md", verification],
  [
    "release-verification.json",
    `${JSON.stringify(verificationJson, null, 2)}\n`,
  ],
];
for (const [name, content] of assets) {
  writeFileSync(resolve(assetRoot, name), content);
  writeFileSync(resolve(bundleRoot, name), content);
}

console.log(`Generated release evidence for ${releaseTag}`);
