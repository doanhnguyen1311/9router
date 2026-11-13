"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "@/shared/components";

function statusTone(status) {
  if (status === "ACTIVE") return "text-green-500";
  if (status === "REVOKED" || status === "EXPIRED") return "text-red-500";
  return "text-amber-500";
}

export default function ProjectChatGPTConnectorPanel({ projectId, canEdit }) {
  const [connectors, setConnectors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pairing, setPairing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/chatgpt-connectors`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load ChatGPT connectors.");
      setConnectors(body.connectors || []);
    } catch (loadError) {
      setError(loadError.message || "Could not load ChatGPT connectors.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  async function createConnector() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/chatgpt-connectors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "ChatGPT Workspace Planning", allowPlanSubmit: true }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not create ChatGPT connector.");
      setPairing({ ...body, connector: body.connector, mcpUrl: body.mcpUrl });
      await load();
    } catch (createError) {
      setError(createError.message || "Could not create ChatGPT connector.");
    } finally {
      setBusy(false);
    }
  }

  async function rotatePairing(connectorId) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/chatgpt-connectors/${connectorId}/pair`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not rotate pairing code.");
      setPairing({ ...body, mcpUrl: `${window.location.origin}/api/v1/connectors/chatgpt/mcp` });
      await load();
    } catch (pairError) {
      setError(pairError.message || "Could not rotate pairing code.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeConnector(connectorId) {
    if (!window.confirm("Revoke this ChatGPT workspace connection?")) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/chatgpt-connectors/${connectorId}`, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not revoke connector.");
      setPairing(null);
      await load();
    } catch (revokeError) {
      setError(revokeError.message || "Could not revoke connector.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-4">
    <Card title="ChatGPT Workspace Connector" subtitle="Connect ChatGPT to this Project for read-only context, planning, and review." icon="auto_awesome">
      <p className="text-sm leading-6 text-text-muted">This connection is scoped to this Project. ChatGPT can read bounded project context and submit a plan, while Codex remains responsible for approval and execution.</p>
      {error && <p role="alert" className="mt-3 rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-xs text-red-500">{error}</p>}
      {canEdit && <div className="mt-4 flex flex-wrap gap-2"><Button icon="add_link" loading={busy} onClick={() => void createConnector()}>Create connection</Button><Button variant="secondary" icon="refresh" onClick={() => void load()} disabled={busy}>Refresh</Button></div>}
    </Card>

    {pairing && <Card title="Pair this workspace" subtitle="Use the one-time code before it expires." icon="key">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-surface-2 p-4"><p className="text-[10px] uppercase tracking-wide text-text-muted">Pairing code</p><p className="mt-2 font-mono text-2xl font-bold tracking-[0.25em] text-text-main">{pairing.pairingCode}</p></div>
        <div className="rounded-xl bg-surface-2 p-4"><p className="text-[10px] uppercase tracking-wide text-text-muted">Connector URL</p><p className="mt-2 break-all font-mono text-xs text-text-main">{pairing.mcpUrl}</p></div>
      </div>
      <p className="mt-3 text-xs leading-5 text-text-muted">In ChatGPT, add this connector with the URL above, choose OAuth, authorize it, and enter the pairing code. Do not share the code.</p>
    </Card>}

    <Card title="Connections" subtitle="Only active connections can access this Project." icon="link">
      {loading ? <p className="text-sm text-text-muted">Loading connections…</p> : !connectors.length ? <p className="text-sm text-text-muted">No ChatGPT connection has been created for this Project.</p> : <div className="space-y-2">{connectors.map((connector) => <div key={connector.id} className="flex flex-col gap-3 rounded-xl bg-surface-2 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-medium text-text-main">{connector.displayName}</p><p className={`mt-1 text-xs font-semibold ${statusTone(connector.status)}`}>{connector.status} · {connector.allowPlanSubmit ? "Plan submission enabled" : "Read only"}</p><p className="mt-1 text-[10px] text-text-muted">Expires {connector.expiresAt ? new Date(connector.expiresAt).toLocaleString() : "—"}</p></div>{canEdit && <div className="flex flex-wrap gap-2"><Button size="xs" variant="secondary" icon="key" disabled={busy || ["REVOKED", "EXPIRED"].includes(connector.status)} onClick={() => void rotatePairing(connector.id)}>New pairing code</Button><Button size="xs" variant="danger" disabled={busy || connector.status === "REVOKED"} onClick={() => void revokeConnector(connector.id)}>Revoke</Button></div>}</div>)}</div>}
    </Card>
  </div>;
}
