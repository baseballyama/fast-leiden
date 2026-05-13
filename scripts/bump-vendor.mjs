#!/usr/bin/env node
// Bump the vendored upstream submodules (igraph + libleidenalg) to their
// latest GitHub release tag, and keep the in-repo source-of-truth files in
// sync.
//
// Touches:
//   - vendor/<sub>      checked out to the latest tag
//   - scripts/build-deps.mjs  *_VERSION_FALLBACK constants
//   - README.md         the "Vendored upstream" version block, between the
//                       <!-- vendor-versions:start --> ... :end --> markers
//
// Designed to run from CI (.github/workflows/vendor-update.yml) on a cron,
// but works locally too:
//
//   pnpm run bump-vendor
//
// Prints a one-line JSON summary on stdout describing what changed, so the
// CI workflow can decide whether to open / update / skip the PR.
//
// We process submodules sequentially on purpose — `git -C <sub> checkout`
// mutates the working tree and we don't want two of those racing each
// other across submodule boundaries. The lint rule about await-in-loop
// would push toward Promise.all, which is the wrong thing here.
/* oxlint-disable no-await-in-loop */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");

const SUBMODULES = [
  {
    name: "igraph",
    path: "vendor/igraph",
    repo: "igraph/igraph",
    fallbackConst: "IGRAPH_VERSION_FALLBACK",
    // The igraph project tags releases as `0.10.16` (no leading "v"). The
    // GitHub API returns the raw tag name; we accept both forms below.
  },
  {
    name: "libleidenalg",
    path: "vendor/libleidenalg",
    repo: "vtraag/libleidenalg",
    fallbackConst: "LIBLEIDENALG_VERSION_FALLBACK",
  },
];

const die = (msg) => {
  process.stderr.write(`bump-vendor: ${msg}\n`);
  process.exit(1);
};

const run = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, { encoding: "utf8", cwd: ROOT, ...opts });
  if (res.error) die(`${cmd} failed to launch: ${res.error.message}`);
  if (res.status !== 0) {
    die(`${cmd} ${args.join(" ")} exited with status ${res.status}\n${res.stderr ?? ""}`);
  }
  return res.stdout;
};

// Fetch the latest release tag from GitHub. We use the /releases/latest
// endpoint which returns the most recent *non-draft, non-prerelease*
// release — this is exactly the upstream signal we want. Falls back to
// /tags if no release is set (some upstreams only tag).
const fetchLatestTag = async (repo) => {
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const releaseResp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers,
  });
  if (releaseResp.ok) {
    const data = await releaseResp.json();
    if (typeof data.tag_name === "string") return data.tag_name;
  }
  // Fallback: tags listing, take the first (most-recent) entry.
  const tagsResp = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=1`, {
    headers,
  });
  if (!tagsResp.ok) {
    die(`GitHub API failed for ${repo}: ${tagsResp.status} ${await tagsResp.text()}`);
  }
  const tags = await tagsResp.json();
  if (!Array.isArray(tags) || tags.length === 0) {
    die(`no tags found for ${repo}`);
  }
  return tags[0].name;
};

const currentSubmoduleSha = (subPath) => run("git", ["-C", subPath, "rev-parse", "HEAD"]).trim();

// Some upstreams tag with a leading "v", some without. Normalize to the
// "no v" form for display so the README and the VERSION fallback constants
// match what each upstream's CMake produces (their CMakeLists treats "0.10.16"
// as the version, not "v0.10.16").
const stripVPrefix = (tag) => (tag.startsWith("v") ? tag.slice(1) : tag);

const checkoutTag = (subPath, tag) => {
  run("git", ["-C", subPath, "fetch", "--tags", "--depth=1", "origin", tag]);
  run("git", ["-C", subPath, "checkout", "--detach", tag]);
};

const readFallbackConstant = (constName) => {
  const buildDepsPath = resolve(ROOT, "scripts/build-deps.mjs");
  const src = readFileSync(buildDepsPath, "utf8");
  const re = new RegExp(`const ${constName} = "([^"]+)";`);
  const m = src.match(re);
  if (!m) die(`could not find ${constName} in scripts/build-deps.mjs`);
  return m[1];
};

const updateFallbackConstant = (constName, version) => {
  const buildDepsPath = resolve(ROOT, "scripts/build-deps.mjs");
  const before = readFileSync(buildDepsPath, "utf8");
  const re = new RegExp(`(const ${constName} = ")([^"]+)(";)`);
  if (!re.test(before)) die(`could not find ${constName} in scripts/build-deps.mjs`);
  const after = before.replace(re, `$1${version}$3`);
  if (after !== before) writeFileSync(buildDepsPath, after);
};

const writeChangeset = (changed) => {
  // Vendor bumps are user-visible (community ids may shift) and the project
  // is post-1.0, so by policy they go out as a minor release. The changesets
  // CLI consumes any .md in .changeset/ with the right frontmatter, so we
  // just drop a file. Filename is stable so re-runs on the same PR branch
  // update the file in place instead of accumulating one per workflow run.
  const changesetPath = resolve(ROOT, ".changeset/vendor-update.md");
  const lines = changed.map((c) => `- \`${c.name}\` → \`${c.version}\``).join("\n");
  const body = [
    "---",
    '"fast-leiden": minor',
    "---",
    "",
    "Bump vendored upstream:",
    "",
    lines,
    "",
  ].join("\n");
  writeFileSync(changesetPath, body);
};

const updateReadme = (versions) => {
  const readmePath = resolve(ROOT, "README.md");
  const before = readFileSync(readmePath, "utf8");
  const startMarker = "<!-- vendor-versions:start -->";
  const endMarker = "<!-- vendor-versions:end -->";
  const startIdx = before.indexOf(startMarker);
  const endIdx = before.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    die("README is missing the vendor-versions markers");
  }
  const rows = versions
    .map((v) => `| [\`${v.name}\`](https://github.com/${v.repo}) | \`${v.version}\` |`)
    .join("\n");
  const block = [
    startMarker,
    "",
    "| Upstream      | Pinned version |",
    "| ------------- | -------------- |",
    rows,
    "",
    "_Auto-updated by_ `.github/workflows/vendor-update.yml` _on the daily schedule._",
    "",
    endMarker,
  ].join("\n");
  const after = before.slice(0, startIdx) + block + before.slice(endIdx + endMarker.length);
  if (after !== before) writeFileSync(readmePath, after);
};

const main = async () => {
  const summary = { changed: [], unchanged: [], targetTags: {} };

  for (const sub of SUBMODULES) {
    const latestTag = await fetchLatestTag(sub.repo);
    const targetVersion = stripVPrefix(latestTag);
    summary.targetTags[sub.name] = latestTag;

    // The fallback constant is the project's declared upstream version.
    // Compare against that (not the submodule SHA): a submodule can be
    // parked on a post-release dev commit, in which case the SHA differs
    // from the latest tag even though we haven't actually shipped a new
    // upstream version. We only want to ship a PR on a real version bump.
    const currentVersion = readFallbackConstant(sub.fallbackConst);

    if (targetVersion === currentVersion) {
      summary.unchanged.push({ name: sub.name, version: targetVersion });
      continue;
    }

    const previousSha = currentSubmoduleSha(sub.path);
    checkoutTag(sub.path, latestTag);
    const newSha = currentSubmoduleSha(sub.path);

    updateFallbackConstant(sub.fallbackConst, targetVersion);

    summary.changed.push({
      name: sub.name,
      version: targetVersion,
      previousVersion: currentVersion,
      previousSha,
      newSha,
    });
  }

  // Only rewrite README / drop a changeset when something actually moved.
  // Otherwise a no-op run would touch README whitespace and create a PR.
  if (summary.changed.length > 0) {
    updateReadme(
      SUBMODULES.map((sub) => ({
        name: sub.name,
        repo: sub.repo,
        version: stripVPrefix(summary.targetTags[sub.name]),
      })),
    );
    writeChangeset(summary.changed);
  }

  process.stdout.write(`${JSON.stringify(summary)}\n`);
};

main().catch((err) => {
  process.stderr.write(`bump-vendor: ${err?.stack ?? err}\n`);
  process.exit(1);
});
