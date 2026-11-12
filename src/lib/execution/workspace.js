import { createHash } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { boundedTimeout, EXECUTION_LIMITS, executionError } from "./constants.js";

const defaultExecFile = promisify(nodeExecFile);

export function configuredWorkspaceRoots(value = process.env.EXECUTION_WORKSPACE_ROOTS) {
  if (typeof value !== "string" || !value.trim()) return [];
  return [...new Set(value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean).map((entry) => path.resolve(entry)))];
}

function isWithinAllowedRoot(root, allowedRoot) {
  return root === allowedRoot || root.startsWith(`${allowedRoot}${path.sep}`);
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
  return {
    root: path.resolve(input.root),
    branch: typeof input.branch === "string" ? input.branch.slice(0, 240) : null,
    commitSha: typeof input.commitSha === "string" ? input.commitSha.slice(0, 128) : null,
    fileHashes: Object.fromEntries(entries),
    timeoutMs: boundedTimeout(input.timeoutMs),
  };
}

async function git(root, args, execFile = defaultExecFile) {
  try {
    const result = await execFile("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    return String(result.stdout || "").trim();
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
  const [branch, commitSha] = await Promise.all([
    git(expected.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], execFile).catch(() => "DETACHED"),
    git(expected.root, ["rev-parse", "HEAD"], execFile),
  ]);
  const fileHashes = await hashWorkspaceFiles(expected.root, Object.keys(expected.fileHashes), { fsImpl });
  const staleReasons = [];
  if (expected.branch && expected.branch !== branch) staleReasons.push("branch changed");
  if (expected.commitSha && expected.commitSha !== commitSha) staleReasons.push("commit changed");
  for (const [relativePath, hash] of Object.entries(expected.fileHashes)) {
    if (fileHashes[relativePath] !== hash) staleReasons.push(`file changed: ${relativePath}`);
  }
  return {
    root: expected.root,
    branch,
    commitSha,
    fileHashes,
    stale: staleReasons.length > 0,
    staleReasons,
  };
}

export async function collectWorkspaceResult(root, { execFile = defaultExecFile } = {}) {
  const [status, diffSummary, changed, untracked] = await Promise.all([
    git(root, ["status", "--porcelain=v1"], execFile),
    git(root, ["diff", "--stat"], execFile),
    git(root, ["diff", "--name-only"], execFile),
    git(root, ["ls-files", "--others", "--exclude-standard"], execFile),
  ]);
  const modifiedFiles = [...new Set(`${changed}\n${untracked}`.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
    .slice(0, EXECUTION_LIMITS.maxFiles)
    .map(cleanRelativePath);
  return { modifiedFiles, diffSummary: String(diffSummary).slice(0, 20_000), status: String(status).slice(0, 20_000) };
}

export const __test__ = { cleanRelativePath, git, isWithinAllowedRoot };
