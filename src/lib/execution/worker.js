import { CodexCliExecutor } from "./codexCli.js";
import { EXECUTION_LIMITS, cleanWorkerId, executionError } from "./constants.js";
import { collectWorkspaceResult } from "./workspace.js";

export class LocalExecutionWorker {
  constructor({ serverUrl, workerId, workerToken, fetchImpl = fetch, codex = new CodexCliExecutor(), resultCollector = collectWorkspaceResult } = {}) {
    if (!serverUrl) throw executionError("WORKER_SERVER_REQUIRED", "serverUrl is required", 400);
    this.serverUrl = String(serverUrl).replace(/\/$/, "");
    this.workerId = cleanWorkerId(workerId);
    this.workerToken = workerToken;
    if (!workerToken) throw executionError("WORKER_TOKEN_REQUIRED", "workerToken is required", 400);
    this.fetch = fetchImpl;
    this.codex = codex;
    this.resultCollector = resultCollector;
  }

  headers() {
    return {
      authorization: `Bearer ${this.workerToken}`,
      "x-execution-worker-id": this.workerId,
      "content-type": "application/json",
    };
  }

  async request(path, body) {
    const response = await this.fetch(`${this.serverUrl}${path}`, { method: "POST", headers: this.headers(), body: JSON.stringify(body || {}) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = executionError(payload.error || "Execution worker request failed", payload.error || "Execution worker request failed", response.status, payload);
      error.code = payload.code || "WORKER_REQUEST_FAILED";
      throw error;
    }
    return payload;
  }

  async run(ticket, { signal = null } = {}) {
    const claimed = await this.request("/api/v1/executions/claim", { ticket });
    const execution = claimed.execution;
    const workspace = execution.sourceRevision;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    let heartbeatFailures = 0;
    let heartbeatTimer = setInterval(() => {
      void this.request("/api/v1/executions/heartbeat", { ticket })
        .then((payload) => {
          heartbeatFailures = 0;
          if (payload.execution?.cancelRequestedAt) controller.abort(new Error("Execution cancellation requested"));
        })
        .catch((error) => {
          heartbeatFailures += 1;
          if (heartbeatFailures >= 2) controller.abort(error);
        });
    }, EXECUTION_LIMITS.heartbeatMs);
    heartbeatTimer.unref?.();
    try {
      const result = await this.codex.run({ plan: claimed.plan, workspaceRoot: workspace.root, timeoutMs: workspace.timeoutMs, signal: controller.signal });
      const files = await this.resultCollector(workspace.root);
      return await this.request("/api/v1/executions/complete", { ticket, result: { ...result, ...files } });
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.code === "EXECUTION_CANCELLED";
      await this.request("/api/v1/executions/complete", {
        ticket,
        result: {
          exitStatus: null,
          cancelled,
          errorCode: error?.code || "CODEX_EXECUTION_FAILED",
          errorMessage: String(error?.message || error).slice(0, 2_000),
          filteredLogs: "",
          modifiedFiles: [],
          diffSummary: "",
        },
      }).catch(() => {});
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
      signal?.removeEventListener?.("abort", onExternalAbort);
    }
  }
}

export const __test__ = { LocalExecutionWorker };
