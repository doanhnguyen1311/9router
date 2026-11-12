const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile: nodeExecFile, spawn: nodeSpawn } = require("node:child_process");
const { promisify } = require("node:util");

const defaultExecFile = promisify(nodeExecFile);
const MAX_LOG_CHARS = 120000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_FILES = 500;
const MAX_UNTRACKED_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 50000;
const CODEX_ENV_ALLOWLIST = Object.freeze([
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "SHELL", "SystemRoot", "ComSpec", "PATHEXT", "CODEX_HOME",
  "TERM", "COLORTERM", "NO_COLOR", "SSL_CERT_FILE", "SSL_CERT_DIR",
]);
const SCAN_IGNORE_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "build", "coverage", "vendor", "cache",
  ".cache", ".next", ".next-cli-build", "__pycache__", ".venv", "target",
]);
const SAFE_ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

function safeCodexEnvironment(source = process.env) {
  return Object.fromEntries(CODEX_ENV_ALLOWLIST.flatMap((name) => {
    const value = source?.[name];
    return typeof value === "string" && value ? [[name, value]] : [];
  }));
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

function usage() {
  return `Usage: 9router execute-plan --server <url> --plan <id> --workspace <absolute-path> [options]

Required environment:
  NINEROUTER_API_KEY                  API Key that owns the approved Plan
  NINEROUTER_EXECUTION_WORKER_SECRET  Secret configured on the 9Router worker API
  EXECUTION_WORKSPACE_ROOTS           ${path.delimiter === ":" ? "Colon-separated" : "Semicolon-separated"} local workspace allowlist

Options:
  --worker-id <id>                    Stable local worker id (default: local-codex-worker)
  --timeout-ms <ms>                   Codex timeout (${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS})
  --ticket-expiration-minutes <min>   Ticket lifetime (1-60, default: 15)
  --codex-bin <path>                  Codex executable (default: codex)
  -h, --help                          Show this help

Secrets are intentionally not accepted as command-line flags.`;
}

function parseArgs(argv) {
  const options = {
    workerId: "local-codex-worker",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    expirationMinutes: 15,
    codexBin: "codex",
  };
  const valueFlags = new Map([
    ["--server", "serverUrl"], ["--plan", "planId"], ["--workspace", "workspaceRoot"],
    ["--worker-id", "workerId"], ["--timeout-ms", "timeoutMs"],
    ["--ticket-expiration-minutes", "expirationMinutes"], ["--codex-bin", "codexBin"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["-h", "--help"].includes(arg)) return { help: true };
    if (["--api-key", "--worker-secret"].includes(arg)) {
      throw new Error(`${arg} is forbidden; provide secrets through the documented environment variables`);
    }
    const field = valueFlags.get(arg);
    if (!field) throw new Error(`Unknown execute-plan argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[field] = value;
    index += 1;
  }
  options.timeoutMs = Number(options.timeoutMs);
  options.expirationMinutes = Number(options.expirationMinutes);
  if (!options.serverUrl || !options.planId || !options.workspaceRoot) {
    throw new Error("--server, --plan, and --workspace are required");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < MIN_TIMEOUT_MS || options.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`--timeout-ms must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  }
  if (!Number.isSafeInteger(options.expirationMinutes) || options.expirationMinutes < 1 || options.expirationMinutes > 60) {
    throw new Error("--ticket-expiration-minutes must be an integer from 1 to 60");
  }
  if (!options.workerId.trim() || options.workerId.length > 160) throw new Error("--worker-id is invalid");
  return options;
}

function isWithin(root, allowed) {
  return root === allowed || root.startsWith(`${allowed}${path.sep}`);
}

function resolveAllowedRoots(value) {
  return String(value || "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean).map((entry) => path.resolve(entry));
}

function canonicalWorkspace(root, allowedValue) {
  if (!path.isAbsolute(root)) throw new Error("Workspace must be an absolute path");
  const resolved = path.resolve(root);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace must be a real directory, not a symlink");
  const real = fs.realpathSync(resolved);
  if (real !== resolved) throw new Error("Workspace path must be canonical");
  const allowed = resolveAllowedRoots(allowedValue);
  if (!allowed.length) throw new Error("EXECUTION_WORKSPACE_ROOTS is required");
  if (!allowed.some((entry) => isWithin(real, entry))) throw new Error("Workspace is outside EXECUTION_WORKSPACE_ROOTS");
  return real;
}

async function git(root, args, execFile = defaultExecFile, { trim = true } = {}) {
  const result = await execFile(
    "git",
    ["-C", root, "-c", "core.fsmonitor=false", "-c", "diff.external=", ...args],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, env: safeCodexEnvironment() },
  );
  const output = String(result.stdout || "");
  return trim ? output.trim() : output;
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 1000 || value.includes("\0")) return null;
  const normalized = value.replaceAll("\\", "/").trim();
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) return null;
  return normalized;
}

function relevantPaths(session) {
  const selected = session.options?.find((option) => option.id === session.selectedOptionId);
  return [...new Set([...(session.affectedModules || []), ...(selected?.filesAffected || [])]
    .map(safeRelativePath).filter(Boolean))].slice(0, 500);
}

async function workspaceSnapshot(root, session, { execFile = defaultExecFile, fsPromises = fsp } = {}) {
  const gitRoot = path.resolve(await git(root, ["rev-parse", "--show-toplevel"], execFile));
  if (gitRoot !== root) throw new Error("Workspace is not the expected Git repository root");
  await assertWorkspaceSecretSafe(root, { fsPromises });
  const [branch, commitSha] = await Promise.all([
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], execFile).catch(() => "DETACHED"),
    git(root, ["rev-parse", "HEAD"], execFile),
  ]);
  const fileHashes = {};
  for (const relativePath of relevantPaths(session)) {
    const absolute = path.resolve(root, relativePath);
    if (!absolute.startsWith(`${root}${path.sep}`)) continue;
    const stat = await fsPromises.lstat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    fileHashes[relativePath] = crypto.createHash("sha256").update(await fsPromises.readFile(absolute)).digest("hex");
  }
  return {
    root,
    branch,
    commitSha,
    workingTreeHash: await workspaceStateHash(root, { execFile, fsPromises }),
    fileHashes,
  };
}

async function safeSymlink(root, relativePath, fsPromises) {
  const cleanPath = safeRelativePath(relativePath);
  if (!cleanPath) throw new Error("Workspace contains an invalid path");
  const absolute = path.resolve(root, cleanPath);
  const stat = await fsPromises.lstat(absolute).catch(() => null);
  if (!stat?.isSymbolicLink()) return stat;
  const target = await fsPromises.realpath(absolute).catch(() => null);
  if (!target || !isWithin(path.resolve(target), root)) throw new Error(`Workspace symlink escapes root: ${cleanPath}`);
  return stat;
}

async function assertWorkspaceSecretSafe(root, { fsPromises = fsp } = {}) {
  const queue = [{ absolute: root, relative: "" }];
  let scanned = 0;
  while (queue.length) {
    const current = queue.shift();
    const entries = await fsPromises.readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_SCAN_ENTRIES) throw new Error("Workspace security scan exceeds the bounded entry limit");
      const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (isSensitiveWorkspaceFile(entry.name)) throw new Error(`Workspace contains a protected secret file: ${relativePath}`);
      if (entry.isSymbolicLink()) {
        await safeSymlink(root, relativePath, fsPromises);
        const target = await fsPromises.realpath(path.join(root, relativePath));
        const targetRelative = path.relative(root, target).replaceAll("\\", "/");
        const targetParts = targetRelative.split("/");
        if (targetParts.some((part) => SCAN_IGNORE_DIRECTORIES.has(part)) || isSensitiveWorkspaceFile(path.basename(target))) {
          throw new Error(`Workspace symlink targets a protected path: ${relativePath}`);
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

async function workspaceStateHash(root, { execFile = defaultExecFile, fsPromises = fsp } = {}) {
  const [status, trackedDiff, untrackedRaw, indexRaw] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], execFile, { trim: false }),
    git(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"], execFile, { trim: false }),
    git(root, ["ls-files", "-z", "--others", "--exclude-standard"], execFile, { trim: false }),
    git(root, ["ls-files", "-s", "-z"], execFile, { trim: false }),
  ]);
  const untracked = untrackedRaw.split("\0").filter(Boolean).map(safeRelativePath);
  if (untracked.some((value) => !value)) throw new Error("Workspace contains an invalid untracked path");
  if (untracked.length > MAX_FILES) throw new Error("Workspace has too many untracked files");
  const trackedSymlinks = indexRaw.split("\0").filter(Boolean).flatMap((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0 || !record.startsWith("120000 ")) return [];
    const relativePath = safeRelativePath(record.slice(tab + 1));
    if (!relativePath) throw new Error("Workspace contains an invalid tracked path");
    return [relativePath];
  });
  await Promise.all(trackedSymlinks.map((relativePath) => safeSymlink(root, relativePath, fsPromises)));
  const hash = crypto.createHash("sha256").update("status\0").update(status).update("\0diff\0").update(trackedDiff);
  let totalBytes = 0;
  for (const relativePath of untracked.sort()) {
    const stat = await safeSymlink(root, relativePath, fsPromises);
    if (!stat) throw new Error(`Workspace file disappeared: ${relativePath}`);
    const absolute = path.resolve(root, relativePath);
    hash.update("\0path\0").update(relativePath);
    if (stat.isSymbolicLink()) {
      hash.update("\0symlink\0").update(await fsPromises.readlink(absolute));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Workspace entry is unsafe: ${relativePath}`);
    totalBytes += stat.size;
    if (totalBytes > MAX_UNTRACKED_BYTES) throw new Error("Untracked workspace content exceeds the snapshot limit");
    hash.update("\0content\0").update(await fsPromises.readFile(absolute));
  }
  return hash.digest("hex");
}

async function requestJson(fetchImpl, url, { method = "GET", headers = {}, body, signal } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: { accept: "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || `HTTP ${response.status}`;
    const error = new Error(detail);
    error.code = payload?.error?.code || payload?.code || "EXECUTION_REQUEST_FAILED";
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function parseUsage(output) {
  const usageData = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.usage && typeof event.usage === "object") Object.assign(usageData, event.usage);
      if (event.type === "turn.completed" && event.usage) Object.assign(usageData, event.usage);
    } catch {}
  }
  return usageData;
}

function redactWorkerText(value, max = MAX_LOG_CHARS) {
  return String(value || "").slice(-max)
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, "[REDACTED:private-key]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:jwt]")
    .replace(/\b(?:sk-|gh[pousr]_|AKIA|ASIA)[A-Za-z0-9_-]{16,}\b/g, "[REDACTED:api-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, "Bearer [REDACTED:bearer-token]")
    .replace(/\b(api[_-]?key|secret|password|token)\s*[:=]\s*([^\s,]{8,})/gi, "$1=[REDACTED:sensitive-value]")
    .slice(-max);
}

function promptForSession(session, workspaceRoot) {
  const selected = session.options?.find((option) => option.id === session.selectedOptionId) || null;
  return [
    "You are executing an already human-approved implementation plan.",
    "Work only inside the supplied workspace. Do not access credentials, parent directories, or unrelated repositories.",
    "Implement the approved plan, run the listed tests when safe, and report verified changes and remaining issues.",
    `Workspace: ${workspaceRoot}`,
    "Approved plan (JSON):",
    JSON.stringify({
      objective: session.interpretedObjective,
      originalRequest: session.originalRequest,
      selectedOption: selected,
      constraints: session.constraints,
      affectedModules: session.affectedModules,
      acceptanceCriteria: selected?.acceptanceCriteria || [],
      testStrategy: selected?.testStrategy || [],
    }),
  ].join("\n\n");
}

async function inspectCodex(command, execFile = defaultExecFile, environment = process.env) {
  const safeEnvironment = safeCodexEnvironment(environment);
  const version = await execFile(command, ["--version"], { encoding: "utf8", maxBuffer: 64 * 1024, env: safeEnvironment });
  const help = await execFile(command, ["exec", "--help"], { encoding: "utf8", maxBuffer: 256 * 1024, env: safeEnvironment });
  const helpText = String(help.stdout || "");
  for (const flag of [
    "--sandbox", "--output-last-message", "--json", "-C, --cd",
    "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config",
  ]) {
    if (!helpText.includes(flag)) throw new Error(`Codex CLI is missing required flag: ${flag}`);
  }
  return String(version.stdout || "").trim();
}

async function runCodex({ command, session, workspaceRoot, timeoutMs, signal, spawn = nodeSpawn, execFile = defaultExecFile, fsPromises = fsp, environment = process.env }) {
  await inspectCodex(command, execFile, environment);
  const outputDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "9router-codex-execution-"));
  const outputFile = path.join(outputDir, "last-message.txt");
  const startedAt = Date.now();
  try {
    const args = [
      "exec", "-C", workspaceRoot,
      "--sandbox", "workspace-write",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "-c", 'approval_policy="never"',
      "-c", 'shell_environment_policy.inherit="none"',
      "--json",
      "--output-last-message", outputFile,
      "-",
    ];
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: safeCodexEnvironment(environment),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const terminate = () => {
      if (settled) return;
      child.kill?.("SIGTERM");
      setTimeout(() => { if (!settled) child.kill?.("SIGKILL"); }, 2000).unref?.();
    };
    const onAbort = () => terminate();
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_LOG_CHARS); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_LOG_CHARS); });
    child.stdin?.end(promptForSession(session, workspaceRoot));
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signalName) => resolve({ code, signal: signalName }));
    }).finally(() => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    });
    if (signal?.aborted) throw Object.assign(new Error("Execution was cancelled"), { code: "EXECUTION_CANCELLED" });
    if (timedOut) throw Object.assign(new Error("Codex execution timed out"), { code: "EXECUTION_TIMEOUT" });
    const lastMessage = await fsPromises.readFile(outputFile, "utf8").catch(() => "");
    return {
      exitStatus: Number.isInteger(exit.code) ? exit.code : 1,
      filteredLogs: redactWorkerText(`${stdout}\n${stderr}\n${lastMessage}`),
      testResults: { source: "codex-final-report", summary: redactWorkerText(lastMessage, 40000) },
      tokenUsage: parseUsage(stdout),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await fsPromises.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function collectResult(root, execFile = defaultExecFile) {
  const [diffSummary, changed, untracked] = await Promise.all([
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--stat"], execFile),
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-only"], execFile),
    git(root, ["ls-files", "--others", "--exclude-standard"], execFile),
  ]);
  const modifiedFiles = [...new Set(`${changed}\n${untracked}`.split(/\r?\n/).map(safeRelativePath).filter(Boolean))].slice(0, 500);
  return { diffSummary: diffSummary.slice(0, 20000), modifiedFiles };
}

async function run(argv, dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) return { code: 0, help: usage() };
  const env = dependencies.env || process.env;
  const apiKey = env.NINEROUTER_API_KEY;
  const workerSecret = env.NINEROUTER_EXECUTION_WORKER_SECRET;
  if (!apiKey) throw new Error("NINEROUTER_API_KEY is required");
  if (!workerSecret || workerSecret.length < 32) throw new Error("NINEROUTER_EXECUTION_WORKER_SECRET must contain at least 32 characters");
  const root = canonicalWorkspace(options.workspaceRoot, env.EXECUTION_WORKSPACE_ROOTS);
  const baseUrl = options.serverUrl.replace(/\/$/, "");
  const fetchImpl = dependencies.fetch || fetch;
  const execFile = dependencies.execFile || defaultExecFile;
  const spawn = dependencies.spawn || nodeSpawn;
  const fsPromises = dependencies.fsPromises || fsp;
  const externalSignal = dependencies.signal || null;
  const apiHeaders = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  const workerHeaders = {
    authorization: `Bearer ${workerSecret}`,
    "x-execution-worker-id": options.workerId,
    "content-type": "application/json",
  };
  const sessionUrl = `${baseUrl}/api/v1/planning/sessions/${encodeURIComponent(options.planId)}`;
  const session = await requestJson(fetchImpl, sessionUrl, { headers: apiHeaders, signal: externalSignal });
  if (session.status !== "APPROVED" || !session.selectedOptionId) throw new Error("Plan must be explicitly approved before execution");
  const workspace = await workspaceSnapshot(root, session, { execFile, fsPromises });
  workspace.timeoutMs = options.timeoutMs;
  const prepared = await requestJson(fetchImpl, `${sessionUrl}/actions`, {
    method: "POST",
    headers: apiHeaders,
    body: {
      action: "prepare_execution",
      expectedVersion: session.version,
      workerId: options.workerId,
      workspace,
      timeoutMs: options.timeoutMs,
      expirationMinutes: options.expirationMinutes,
    },
    signal: externalSignal,
  });
  const ticket = prepared.executionHandoff?.ticket;
  if (!ticket) throw new Error("9Router did not return an execution ticket");
  const claimed = await requestJson(fetchImpl, `${baseUrl}/api/v1/executions/claim`, {
    method: "POST", headers: workerHeaders, body: { ticket }, signal: externalSignal,
  });
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  let heartbeatFailures = 0;
  const heartbeat = setInterval(() => {
    void requestJson(fetchImpl, `${baseUrl}/api/v1/executions/heartbeat`, {
      method: "POST", headers: workerHeaders, body: { ticket }, signal: controller.signal,
    }).then((payload) => {
      heartbeatFailures = 0;
      if (payload.execution?.cancelRequestedAt) controller.abort(new Error("Execution cancellation requested"));
    }).catch((error) => {
      heartbeatFailures += 1;
      if (heartbeatFailures >= 2) controller.abort(error);
    });
  }, 15000);
  heartbeat.unref?.();
  try {
    const codexResult = await runCodex({
      command: options.codexBin,
      session: { ...session, ...claimed.plan },
      workspaceRoot: root,
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
      spawn,
      execFile,
      fsPromises,
      environment: env,
    });
    const files = await collectResult(root, execFile);
    const completed = await requestJson(fetchImpl, `${baseUrl}/api/v1/executions/complete`, {
      method: "POST", headers: workerHeaders, body: { ticket, result: { ...codexResult, ...files } },
    });
    return { code: codexResult.exitStatus === 0 ? 0 : 1, execution: completed.execution };
  } catch (error) {
    const cancelled = controller.signal.aborted || error.code === "EXECUTION_CANCELLED";
    await requestJson(fetchImpl, `${baseUrl}/api/v1/executions/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: { ticket, result: {
        exitStatus: null,
        cancelled,
        errorCode: error.code || "CODEX_EXECUTION_FAILED",
        errorMessage: String(error.message || error).slice(0, 2000),
        filteredLogs: "",
        modifiedFiles: [],
        diffSummary: "",
      } },
    }).catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
    externalSignal?.removeEventListener?.("abort", onExternalAbort);
  }
}

module.exports = {
  canonicalWorkspace,
  collectResult,
  inspectCodex,
  parseArgs,
  parseUsage,
  promptForSession,
  relevantPaths,
  requestJson,
  run,
  runCodex,
  usage,
  workspaceSnapshot,
  workspaceStateHash,
  __test__: {
    CODEX_ENV_ALLOWLIST,
    EventEmitter,
    assertWorkspaceSecretSafe,
    isSensitiveWorkspaceFile,
    isWithin,
    safeCodexEnvironment,
    safeRelativePath,
    safeSymlink,
    redactWorkerText,
  },
};
