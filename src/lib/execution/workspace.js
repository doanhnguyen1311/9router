import { createHash } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { boundedTimeout, EXECUTION_LIMITS, executionError, safeExecutionEnvironment } from "./constants.js";

const defaultExecFile = promisify(nodeExecFile);
const SCAN_IGNORE_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "build", "coverage", "vendor", "cache",
  ".cache", ".next", ".next-cli-build", "__pycache__", ".venv", "target",
]);
const SAFE_ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

export function configuredWorkspaceRoots(value = process.env.EXECUTION_WORKSPACE_ROOTS) {
  if (typeof value !== "string" || !value.trim()) return [];
  return [...new Set(value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean).map((entry) => path.resolve(entry)))];
}

function isWithinAllowedRoot(root, allowedRoot) {
  return root === allowedRoot || root.startsWith(`${allowedRoot}${path.sep}`);
}

function isSensitiveWorkspaceFile(name) {
  const value = String(name || "").toLowerCase();
  if (SAFE_ENV_TEMPLATES.has(value)) return false;
  return value === ".env"
    || value.startsWith(".env.")
    || [".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json", "secrets.json", "service-account.json"].includes(value)
    || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(value)
    || /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(value);
}

function cleanRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > EXECUTION_LIMITS.maxFilePathChars || value.includes("\u0000")) {
    throw executionError("WORKSPACE_PATH_INVALID", "Workspace file path is invalid", 409);
  }
  const normalized = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw executionError("WORKSPACE_PATH_INVALID", "Workspace path traversal is not allowed", 409);
  }
  return normalized;
}

export function normalizeWorkspaceDescriptor(input = {}) {
  if (typeof input.root !== "string" || !input.root.trim() || input.root.length > EXECUTION_LIMITS.workspaceRootChars) {
    throw executionError("WORKSPACE_ROOT_INVALID", "workspace.root is required", 400);
  }
  if (!path.isAbsolute(input.root)) {
    throw executionError("WORKSPACE_ROOT_INVALID", "workspace.root must be an absolute path", 400);
  }
  const files = input.fileHashes && typeof input.fileHashes === "object" && !Array.isArray(input.fileHashes) ? input.fileHashes : {};
  const entries = Object.entries(files).slice(0, EXECUTION_LIMITS.maxFiles).map(([relativePath, hash]) => {
    const cleanPath = cleanRelativePath(relativePath);
    if (typeof hash !== "string" || !/^[a-f0-9]{32,128}$/i.test(hash)) throw executionError("WORKSPACE_HASH_INVALID", "Workspace file hash is invalid", 400);
    return [cleanPath, hash.toLowerCase()];
  });
  const workingTreeHash = input.workingTreeHash == null || input.workingTreeHash === ""
    ? null
    : String(input.workingTreeHash).toLowerCase();
  if (workingTreeHash && !/^[a-f0-9]{64}$/.test(workingTreeHash)) {
    throw executionError("WORKSPACE_HASH_INVALID", "Workspace working-tree hash is invalid", 400);
  }
  return {
    root: path.resolve(input.root),
    branch: typeof input.branch === "string" ? input.branch.slice(0, 240) : null,
    commitSha: typeof input.commitSha === "string" ? input.commitSha.slice(0, 128) : null,
    workingTreeHash,
    fileHashes: Object.fromEntries(entries),
    timeoutMs: boundedTimeout(input.timeoutMs),
  };
}

async function git(root, args, execFile = defaultExecFile, { trim = true } = {}) {
  try {
    const result = await execFile(
      "git",
      ["-C", root, "-c", "core.fsmonitor=false", "-c", "diff.external=", ...args],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, env: safeExecutionEnvironment() },
    );
    const output = String(result.stdout || "");
    return trim ? output.trim() : output;
  } catch (error) {
    throw executionError("WORKSPACE_GIT_INVALID", `Workspace git validation failed: ${String(error.stderr || error.message || "git error").slice(0, 500)}`, 409);
  }
}

export async function hashWorkspaceFiles(root, relativePaths, { fsImpl = fs } = {}) {
  const result = {};
  for (const relativePath of relativePaths) {
    const cleanPath = cleanRelativePath(relativePath);
    const absolute = path.resolve(root, cleanPath);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw executionError("WORKSPACE_PATH_INVALID", "Workspace path escapes root", 409);
    const stat = await fsImpl.lstat(absolute).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw executionError("WORKSPACE_FILE_INVALID", `Workspace file is missing or unsafe: ${cleanPath}`, 409);
    const content = await fsImpl.readFile(absolute);
    result[cleanPath] = createHash("sha256").update(content).digest("hex");
  }
  return result;
}

async function assertSafeSymlink(root, relativePath, fsImpl) {
  const cleanPath = cleanRelativePath(relativePath);
  const absolute = path.resolve(root, cleanPath);
  const stat = await fsImpl.lstat(absolute).catch(() => null);
  if (!stat?.isSymbolicLink()) return stat;
  const target = await fsImpl.realpath(absolute).catch(() => null);
  if (!target || !isWithinAllowedRoot(path.resolve(target), root)) {
    throw executionError("WORKSPACE_SYMLINK_UNSAFE", `Workspace symlink escapes root: ${cleanPath}`, 409);
  }
  return stat;
}

export async function assertWorkspaceSecretSafe(root, { fsImpl = fs } = {}) {
  const queue = [{ absolute: root, relative: "" }];
  let scanned = 0;
  while (queue.length) {
    const current = queue.shift();
    const entries = await fsImpl.readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      scanned += 1;
      if (scanned > EXECUTION_LIMITS.maxWorkspaceScanEntries) {
        throw executionError("WORKSPACE_SCAN_TOO_LARGE", "Workspace security scan exceeds the bounded entry limit", 409);
      }
      const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (isSensitiveWorkspaceFile(entry.name)) {
        throw executionError("WORKSPACE_SECRET_FILE", `Workspace contains a protected secret file: ${relativePath}`, 409);
      }
      if (entry.isSymbolicLink()) {
        await assertSafeSymlink(root, relativePath, fsImpl);
        const target = await fsImpl.realpath(path.join(root, relativePath));
        const targetRelative = path.relative(root, target).replaceAll("\\", "/");
        const targetParts = targetRelative.split("/");
        if (targetParts.some((part) => SCAN_IGNORE_DIRECTORIES.has(part)) || isSensitiveWorkspaceFile(path.basename(target))) {
          throw executionError("WORKSPACE_SYMLINK_UNSAFE", `Workspace symlink targets a protected path: ${relativePath}`, 409);
        }
        continue;
      }
      if (entry.isDirectory() && !SCAN_IGNORE_DIRECTORIES.has(entry.name)) {
        queue.push({ absolute: path.join(current.absolute, entry.name), relative: relativePath });
      }
    }
  }
  return { scannedEntries: scanned };
}

export async function hashWorkspaceState(root, { execFile = defaultExecFile, fsImpl = fs } = {}) {
  const [status, trackedDiff, untrackedRaw, indexRaw] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], execFile, { trim: false }),
    git(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"], execFile, { trim: false }),
    git(root, ["ls-files", "-z", "--others", "--exclude-standard"], execFile, { trim: false }),
    git(root, ["ls-files", "-s", "-z"], execFile, { trim: false }),
  ]);
  const untracked = untrackedRaw.split("\0").filter(Boolean).map(cleanRelativePath).sort();
  if (untracked.length > EXECUTION_LIMITS.maxFiles) {
    throw executionError("WORKSPACE_SNAPSHOT_TOO_LARGE", "Workspace has too many untracked files", 409);
  }
  const trackedSymlinks = indexRaw.split("\0").filter(Boolean).flatMap((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0 || !record.startsWith("120000 ")) return [];
    return [cleanRelativePath(record.slice(tab + 1))];
  });
  await Promise.all(trackedSymlinks.map((relativePath) => assertSafeSymlink(root, relativePath, fsImpl)));

  const hash = createHash("sha256").update("status\0").update(status).update("\0diff\0").update(trackedDiff);
  let totalBytes = 0;
  for (const relativePath of untracked) {
    const stat = await assertSafeSymlink(root, relativePath, fsImpl);
    if (!stat) throw executionError("WORKSPACE_FILE_INVALID", `Workspace file disappeared: ${relativePath}`, 409);
    const absolute = path.resolve(root, relativePath);
    hash.update("\0path\0").update(relativePath);
    if (stat.isSymbolicLink()) {
      hash.update("\0symlink\0").update(await fsImpl.readlink(absolute));
      continue;
    }
    if (!stat.isFile()) throw executionError("WORKSPACE_FILE_INVALID", `Workspace entry is unsafe: ${relativePath}`, 409);
    totalBytes += stat.size;
    if (totalBytes > EXECUTION_LIMITS.maxUntrackedSnapshotBytes) {
      throw executionError("WORKSPACE_SNAPSHOT_TOO_LARGE", "Untracked workspace content exceeds the snapshot limit", 409);
    }
    hash.update("\0content\0").update(await fsImpl.readFile(absolute));
  }
  return hash.digest("hex");
}

export async function validateWorkspace(descriptor, { execFile = defaultExecFile, fsImpl = fs, allowedRoots = configuredWorkspaceRoots() } = {}) {
  const expected = normalizeWorkspaceDescriptor(descriptor);
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw executionError("WORKSPACE_POLICY_UNAVAILABLE", "Execution workspace allowlist is not configured", 503);
  }
  const stat = await fsImpl.lstat(expected.root).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw executionError("WORKSPACE_ROOT_INVALID", "Workspace root is missing or a symlink", 409);
  const realRoot = await fsImpl.realpath(expected.root);
  if (realRoot !== expected.root) throw executionError("WORKSPACE_ROOT_INVALID", "Workspace root must be canonical and may not resolve through a symlink", 409);
  const normalizedAllowedRoots = allowedRoots.map((entry) => path.resolve(entry));
  if (!normalizedAllowedRoots.some((allowedRoot) => isWithinAllowedRoot(realRoot, allowedRoot))) {
    throw executionError("WORKSPACE_NOT_ALLOWED", "Workspace root is outside the worker allowlist", 403);
  }
  const gitRoot = await git(expected.root, ["rev-parse", "--show-toplevel"], execFile);
  if (path.resolve(gitRoot) !== expected.root) throw executionError("WORKSPACE_REPOSITORY_INVALID", "Workspace root is not the expected Git repository", 409);
  await assertWorkspaceSecretSafe(expected.root, { fsImpl });
  const [branch, commitSha] = await Promise.all([
    git(expected.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], execFile).catch(() => "DETACHED"),
    git(expected.root, ["rev-parse", "HEAD"], execFile),
  ]);
  const workingTreeHash = expected.workingTreeHash
    ? await hashWorkspaceState(expected.root, { execFile, fsImpl })
    : null;
  const fileHashes = await hashWorkspaceFiles(expected.root, Object.keys(expected.fileHashes), { fsImpl });
  const staleReasons = [];
  if (expected.branch && expected.branch !== branch) staleReasons.push("branch changed");
  if (expected.commitSha && expected.commitSha !== commitSha) staleReasons.push("commit changed");
  if (expected.workingTreeHash && expected.workingTreeHash !== workingTreeHash) staleReasons.push("working tree changed");
  for (const [relativePath, hash] of Object.entries(expected.fileHashes)) {
    if (fileHashes[relativePath] !== hash) staleReasons.push(`file changed: ${relativePath}`);
  }
  return {
    root: expected.root,
    branch,
    commitSha,
    workingTreeHash,
    fileHashes,
    stale: staleReasons.length > 0,
    staleReasons,
  };
}

export async function collectWorkspaceResult(root, { execFile = defaultExecFile } = {}) {
  const [status, diffSummary, changed, untracked] = await Promise.all([
    git(root, ["status", "--porcelain=v1"], execFile),
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--stat"], execFile),
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-only"], execFile),
    git(root, ["ls-files", "--others", "--exclude-standard"], execFile),
  ]);
  const modifiedFiles = [...new Set(`${changed}\n${untracked}`.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
    .slice(0, EXECUTION_LIMITS.maxFiles)
    .map(cleanRelativePath);
  return { modifiedFiles, diffSummary: String(diffSummary).slice(0, 20_000), status: String(status).slice(0, 20_000) };
}

export const __test__ = { assertSafeSymlink, cleanRelativePath, git, isSensitiveWorkspaceFile, isWithinAllowedRoot };
