import { spawn as nodeSpawn } from "node:child_process";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactProjectText } from "@/lib/projectMemory/privacy.js";
import { EXECUTION_LIMITS, boundedTimeout, executionError } from "./constants.js";

const defaultExecFile = promisify(nodeExecFile);

function safeText(value, max = EXECUTION_LIMITS.maxLogsChars) {
  return redactProjectText(String(value || "").slice(-max)).text.slice(-max);
}

export async function inspectCodexCli({ command = "codex", execFile = defaultExecFile } = {}) {
  try {
    const version = await execFile(command, ["--version"], { encoding: "utf8", maxBuffer: 64 * 1024 });
    const help = await execFile(command, ["exec", "--help"], { encoding: "utf8", maxBuffer: 256 * 1024 });
    const helpText = String(help.stdout || "");
    const requiredFlags = ["--sandbox", "--output-last-message", "--json", "-C, --cd"];
    const missingFlags = requiredFlags.filter((flag) => !helpText.includes(flag));
    if (missingFlags.length) throw executionError("CODEX_CLI_UNSUPPORTED", `Codex CLI is missing required flags: ${missingFlags.join(", ")}`, 503);
    return { command, version: String(version.stdout || "").trim().slice(0, 200), requiredFlags };
  } catch (error) {
    if (error?.code?.startsWith?.("CODEX_CLI_")) throw error;
    throw executionError("CODEX_CLI_UNAVAILABLE", `Codex CLI is unavailable: ${String(error.message || error).slice(0, 500)}`, 503);
  }
}

function promptForPlan(plan, workspaceRoot) {
  const selected = plan.options?.find((option) => option.id === plan.selectedOptionId) || null;
  const payload = {
    objective: plan.interpretedObjective,
    originalRequest: plan.originalRequest,
    selectedOption: selected,
    constraints: plan.constraints,
    affectedModules: plan.affectedModules,
    acceptanceCriteria: selected?.acceptanceCriteria || [],
    testStrategy: selected?.testStrategy || [],
  };
  return [
    "You are executing an already human-approved implementation plan.",
    "Work only inside the supplied workspace. Do not access credentials, parent directories, or unrelated repositories.",
    "Implement the approved plan, run the listed tests when safe, and report verified changes and remaining issues.",
    `Workspace: ${workspaceRoot}`,
    "Approved plan (JSON):",
    JSON.stringify(payload),
  ].join("\n\n");
}

export class CodexCliExecutor {
  constructor({ command = "codex", spawn = nodeSpawn, execFile = defaultExecFile, fsImpl = fs, tempDir = os.tmpdir } = {}) {
    this.command = command;
    this.spawn = spawn;
    this.execFile = execFile;
    this.fs = fsImpl;
    this.tempDir = tempDir;
  }

  inspect() {
    return inspectCodexCli({ command: this.command, execFile: this.execFile });
  }

  async run({ plan, workspaceRoot, timeoutMs = EXECUTION_LIMITS.defaultTimeoutMs, signal = null }) {
    await this.inspect();
    const bounded = boundedTimeout(timeoutMs);
    const outputDir = await this.fs.mkdtemp(path.join(this.tempDir(), "9router-codex-execution-"));
    const outputFile = path.join(outputDir, "last-message.txt");
    try {
      const args = [
        "exec", "-C", workspaceRoot,
        "--sandbox", "workspace-write",
        "--json",
        "--output-last-message", outputFile,
        "-",
      ];
      const child = this.spawn(this.command, args, { cwd: workspaceRoot, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const startedAt = Date.now();
      const terminate = () => {
        if (settled) return;
        child.kill?.("SIGTERM");
        setTimeout(() => { if (!settled) child.kill?.("SIGKILL"); }, 2_000).unref?.();
      };
      const onAbort = () => terminate();
      const timer = setTimeout(() => terminate(), bounded);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-EXECUTION_LIMITS.maxLogsChars); });
      child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-EXECUTION_LIMITS.maxLogsChars); });
      child.stdin?.end(promptForPlan(plan, workspaceRoot));
      const exit = await new Promise((resolve, reject) => {
        child.once?.("error", reject);
        child.once?.("close", (code, signalName) => resolve({ code, signal: signalName }));
      }).finally(() => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
      }).catch((error) => {
        throw executionError("CODEX_CLI_START_FAILED", String(error.message || error), 502);
      });
      if (signal?.aborted) throw executionError("EXECUTION_CANCELLED", "Execution was cancelled", 499);
      if (Date.now() - startedAt >= bounded && exit.code === null) throw executionError("EXECUTION_TIMEOUT", "Codex execution timed out", 504);
      const lastMessage = await this.fs.readFile(outputFile, "utf8").catch(() => "");
      const filteredLogs = safeText(`${stdout}\n${stderr}`);
      return {
        exitStatus: Number.isInteger(exit.code) ? exit.code : 1,
        signal: exit.signal || null,
        lastMessage: safeText(lastMessage, 40_000),
        filteredLogs,
        durationMs: Date.now() - startedAt,
        tokenUsage: parseUsage(stdout),
      };
    } finally {
      await this.fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function parseUsage(output) {
  const usage = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.usage && typeof event.usage === "object") Object.assign(usage, event.usage);
      if (event.type === "turn.completed" && event.usage) Object.assign(usage, event.usage);
    } catch { /* Codex may emit human-readable lines alongside JSONL. */ }
  }
  return usage;
}

export const __test__ = { promptForPlan, parseUsage, safeText };
