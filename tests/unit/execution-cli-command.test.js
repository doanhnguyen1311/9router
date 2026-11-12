import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as nodeExecFile, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const command = require("../../cli/src/cli/commands/executePlan.js");
const realExecFile = promisify(nodeExecFile);
const roots = [];

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cli-execution-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/example.js"), "export const example = true;\n");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "CLI Test"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("9router execute-plan command", () => {
  it("requires secrets from environment instead of process-visible flags", () => {
    expect(() => command.parseArgs(["--api-key", "secret"])).toThrow(/forbidden/i);
    expect(() => command.parseArgs(["--worker-secret", "secret"])).toThrow(/forbidden/i);
    expect(command.parseArgs([
      "--server", "http://localhost:20128", "--plan", "plan-1", "--workspace", "/workspace",
    ])).toMatchObject({ workerId: "local-codex-worker", timeoutMs: 1800000, expirationMinutes: 15 });
  });

  it("snapshots the Git workspace and runs the complete approved handoff", async () => {
    const root = workspace();
    const session = {
      object: "9router.planning_session",
      planId: "plan-approved",
      status: "APPROVED",
      version: 4,
      selectedOptionId: "option-1",
      originalRequest: "Implement example",
      interpretedObjective: "Implement the approved example",
      constraints: ["Stay scoped"],
      affectedModules: ["src/example.js"],
      options: [{ id: "option-1", filesAffected: ["src/example.js"], acceptanceCriteria: ["Done"], testStrategy: ["Test"] }],
    };
    const calls = [];
    let preparedBody;
    let completedBody;
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ pathname, method: init.method || "GET", headers: init.headers, body });
      if (pathname.endsWith("/planning/sessions/plan-approved") && (init.method || "GET") === "GET") return json(session);
      if (pathname.endsWith("/planning/sessions/plan-approved/actions")) {
        preparedBody = body;
        return json({ ...session, execution: { id: "execution-1", status: "QUEUED" }, executionHandoff: { ticket: "signed-ticket", executionId: "execution-1" } }, 201);
      }
      if (pathname.endsWith("/executions/claim")) return json({
        execution: { id: "execution-1", status: "EXECUTING", sourceRevision: preparedBody.workspace },
        plan: { ...session, id: session.planId, currentRevision: 1 },
      });
      if (pathname.endsWith("/executions/complete")) {
        completedBody = body;
        return json({ execution: { id: "execution-1", status: "COMPLETED" } });
      }
      if (pathname.endsWith("/executions/heartbeat")) return json({ execution: { id: "execution-1", status: "EXECUTING" } });
      return json({ error: "not found" }, 404);
    });
    const codexExecCalls = [];
    const execFile = vi.fn(async (binary, args, options) => {
      if (binary === "git") return realExecFile(binary, args, options);
      codexExecCalls.push({ args, options });
      if (args[0] === "--version") return { stdout: "codex-cli 0.165.0" };
      return { stdout: "--sandbox\n--output-last-message\n--json\n-C, --cd\n--ephemeral\n--ignore-user-config\n--ignore-rules\n--strict-config" };
    });
    const spawn = vi.fn((_binary, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      child.stdin = { end: vi.fn(async () => {
        const outputFile = args[args.indexOf("--output-last-message") + 1];
        fs.writeFileSync(outputFile, "Completed approved plan");
        child.stdout.emit("data", Buffer.from('{"type":"turn.completed","usage":{"totalTokens":12}}\n'));
        queueMicrotask(() => child.emit("close", 0, null));
      }) };
      return child;
    });
    const result = await command.run([
      "--server", "http://localhost:20128",
      "--plan", session.planId,
      "--workspace", root,
      "--worker-id", "cli-worker",
      "--timeout-ms", "10000",
    ], {
      fetch: fetchImpl,
      execFile,
      spawn,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NINEROUTER_API_KEY: "sk-session-owner",
        NINEROUTER_EXECUTION_WORKER_SECRET: "worker-secret-012345678901234567890",
        EXECUTION_WORKSPACE_ROOTS: root,
        OPENAI_API_KEY: "must-not-reach-codex",
      },
    });
    expect(result).toMatchObject({ code: 0, execution: { status: "COMPLETED" } });
    expect(preparedBody).toMatchObject({
      action: "prepare_execution", expectedVersion: 4, workerId: "cli-worker",
      workspace: { root, fileHashes: { "src/example.js": expect.stringMatching(/^[a-f0-9]{64}$/) }, workingTreeHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(completedBody.result).toMatchObject({
      exitStatus: 0,
      tokenUsage: { totalTokens: 12 },
      testResults: { source: "codex-final-report", summary: "Completed approved plan" },
    });
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining([
      "exec", "--sandbox", "workspace-write", "--ephemeral", "--ignore-user-config",
      "--ignore-rules", "--strict-config", "--json", "-",
    ]));
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining([
      "-c", 'approval_policy="never"', 'shell_environment_policy.inherit="none"',
    ]));
    expect(spawn.mock.calls[0][1]).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(spawn.mock.calls[0][2].env).toMatchObject({ PATH: process.env.PATH, HOME: process.env.HOME });
    expect(spawn.mock.calls[0][2].env).not.toHaveProperty("NINEROUTER_API_KEY");
    expect(spawn.mock.calls[0][2].env).not.toHaveProperty("NINEROUTER_EXECUTION_WORKER_SECRET");
    expect(spawn.mock.calls[0][2].env).not.toHaveProperty("OPENAI_API_KEY");
    expect(codexExecCalls[0].options.env).not.toHaveProperty("NINEROUTER_API_KEY");
    expect(codexExecCalls[0].options.env).not.toHaveProperty("NINEROUTER_EXECUTION_WORKER_SECRET");
    expect(codexExecCalls[0].options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(JSON.stringify(calls.map((call) => call.body))).not.toContain("worker-secret-012345678901234567890");
  });

  it("rejects a workspace containing a protected secret file before preparing a ticket", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, ".env"), "API_KEY=real-secret\n");
    await expect(command.workspaceSnapshot(root, { affectedModules: [], options: [] })).rejects.toThrow(/protected secret file/i);
    fs.rmSync(path.join(root, ".env"));
    fs.writeFileSync(path.join(root, ".env.example"), "API_KEY=replace-me\n");
    await expect(command.workspaceSnapshot(root, { affectedModules: [], options: [] })).resolves.toMatchObject({ root });
  });
});
