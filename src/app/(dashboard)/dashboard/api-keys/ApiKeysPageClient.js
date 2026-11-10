"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button, Card, Input, Toggle, Modal, ConfirmModal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import KeyAccessControls from "../endpoint/components/KeyAccessControls";
import KeyQuotaControls from "../endpoint/components/KeyQuotaControls";
import KeyEffortControls from "../endpoint/components/KeyEffortControls";
import KeyUsageAccessControls from "../endpoint/components/KeyUsageAccessControls";

const KEY_SYNC_DEBOUNCE_MS = 300;
const KEY_SYNC_FALLBACK_MS = 30000;

const MANAGE_TABS = [
  { id: "general", label: "General", icon: "tune" },
  { id: "access", label: "Model Access", icon: "lock_open" },
  { id: "effort", label: "Effort", icon: "psychology" },
  { id: "quota", label: "Quota & Usage", icon: "data_usage" },
];

function maskKey(fullKey) {
  if (!fullKey || fullKey.length <= 10) return fullKey || "";
  return `${fullKey.slice(0, 6)}••••••••${fullKey.slice(-4)}`;
}

function compact(value) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value) || 0);
}

function money(value) {
  const amount = Number(value) || 0;
  return amount > 0 && amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

function UsageBar({ label, used, limit, format = compact }) {
  const hasLimit = Number(limit) > 0;
  const percent = hasLimit ? Math.min(100, (Number(used) / Number(limit)) * 100) : 0;
  const barColor = percent >= 90 ? "bg-red-500" : percent >= 70 ? "bg-amber-500" : "bg-primary";
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-text-muted">{label}</span>
        <span className="font-medium text-text-main tabular-nums">
          {format(used)}
          <span className="text-text-muted font-normal">{hasLimit ? ` / ${format(limit)}` : ""}</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
        {hasLimit ? (
          <div className={`h-full rounded-full ${barColor}`} style={{ width: `${percent}%` }} />
        ) : (
          <div className="h-full w-full rounded-full bg-black/5 dark:bg-white/5" title="Unlimited" />
        )}
      </div>
    </div>
  );
}

function StatPill({ icon, label, value, tone = "text-primary bg-primary/10" }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <span className={`material-symbols-outlined flex size-9 items-center justify-center rounded-lg text-[20px] ${tone}`}>{icon}</span>
      <div>
        <p className="text-xl font-bold leading-none text-text-main tabular-nums">{value}</p>
        <p className="mt-1 text-[11px] text-text-muted">{label}</p>
      </div>
    </div>
  );
}

function Badge({ children, tone }) {
  const tones = {
    green: "bg-green-500/10 text-green-600 dark:text-green-400",
    orange: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    primary: "bg-primary/10 text-primary",
    muted: "bg-black/5 dark:bg-white/10 text-text-muted",
    red: "bg-red-500/10 text-red-500",
  };
  return <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${tones[tone] || tones.muted}`}>{children}</span>;
}

export default function ApiKeysPageClient() {
  const [keys, setKeys] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [keySyncStatus, setKeySyncStatus] = useState("syncing");
  const [visibleKeys, setVisibleKeys] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");

  const [manageKeyId, setManageKeyId] = useState(null);
  const [manageTab, setManageTab] = useState("general");

  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyV2Enabled, setNewKeyV2Enabled] = useState(false);
  const [newKeyV2Endpoint, setNewKeyV2Endpoint] = useState("");
  const [newKeyV2ApiKey, setNewKeyV2ApiKey] = useState("");
  const [newKeyError, setNewKeyError] = useState("");
  const [createdKey, setCreatedKey] = useState(null);

  const [confirmState, setConfirmState] = useState(null);
  const [actionError, setActionError] = useState("");
  const { copied, copy } = useCopyToClipboard(2000);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      if (!res.ok) return [];
      const data = await res.json();
      return data.keys || [];
    } catch {
      return [];
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) return [];
      const data = await res.json();
      return data.projects || [];
    } catch {
      return [];
    }
  }, []);

  const reloadData = useCallback(async () => {
    const [fetchedKeys, fetchedProjects] = await Promise.all([fetchKeys(), fetchProjects()]);
    setKeys(fetchedKeys);
    setProjects(fetchedProjects);
  }, [fetchKeys, fetchProjects]);

  // Initial load + real-time sync (same mechanism as Endpoint & Key page)
  useEffect(() => {
    let active = true;
    (async () => {
      try { await reloadData(); } finally { if (active) setLoading(false); }
    })();

    let refreshTimer = null;
    let refreshing = false;
    let refreshAgain = false;

    const refreshKeys = async () => {
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      try {
        const fetched = await fetchKeys();
        if (active) setKeys(fetched);
      } finally {
        refreshing = false;
        if (refreshAgain && active) {
          refreshAgain = false;
          refreshTimer = setTimeout(refreshKeys, KEY_SYNC_DEBOUNCE_MS);
        }
      }
    };

    const scheduleRefresh = () => {
      if (!active) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshKeys, KEY_SYNC_DEBOUNCE_MS);
    };

    let source = null;
    try {
      source = new EventSource("/api/keys/stream");
      source.onopen = () => { if (active) setKeySyncStatus("live"); };
      source.onerror = () => { if (active) setKeySyncStatus("reconnecting"); };
      source.addEventListener("keys-changed", scheduleRefresh);
    } catch { /* SSE unavailable; fallback timer still refreshes */ }

    const onVisible = () => { if (!document.hidden) scheduleRefresh(); };
    document.addEventListener("visibilitychange", onVisible);
    const fallback = setInterval(() => { if (!document.hidden) scheduleRefresh(); }, KEY_SYNC_FALLBACK_MS);

    return () => {
      active = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      clearInterval(fallback);
      document.removeEventListener("visibilitychange", onVisible);
      if (source) source.close();
    };
  }, [fetchKeys, reloadData]);

  const replaceKey = (updated) => setKeys((prev) => prev.map((k) => (k.id === updated.id ? updated : k)));

  // Generic PUT /api/keys/:id helper used by all control components.
  const updateKey = async (id, body) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        replaceKey(data.key);
        return { ok: true };
      }
      return { ok: false, error: data.error || `Request failed (${res.status})` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId); else next.add(keyId);
      return next;
    });
  };

  const resetCreateForm = () => {
    setNewKeyName("");
    setNewKeyV2Enabled(false);
    setNewKeyV2Endpoint("");
    setNewKeyV2ApiKey("");
    setNewKeyError("");
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim() || (newKeyV2Enabled && (!newKeyV2Endpoint.trim() || !newKeyV2ApiKey.trim()))) return;
    try {
      setNewKeyError("");
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newKeyName,
          v2Proxy: {
            enabled: newKeyV2Enabled,
            upstreamBaseUrl: newKeyV2Enabled ? newKeyV2Endpoint : undefined,
            upstreamApiKey: newKeyV2Enabled ? newKeyV2ApiKey : undefined,
          },
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setCreatedKey(data.key);
        await reloadData();
        resetCreateForm();
        setShowAddModal(false);
      } else {
        setNewKeyError(data.error || "Failed to create API key");
      }
    } catch {
      setNewKeyError("Failed to create API key");
    }
  };

  const handleToggleKey = async (key, checked) => {
    const run = async () => {
      const result = await updateKey(key.id, { isActive: checked });
      if (!result.ok) {
        // Older API versions may not return the key body; fall back to optimistic update.
        setKeys((prev) => prev.map((k) => (k.id === key.id ? { ...k, isActive: checked } : k)));
      }
    };
    if (key.isActive !== false && !checked) {
      setConfirmState({
        title: "Pause API Key",
        message: `Pause "${key.name}"?\n\nThis key stops working immediately but can be resumed later.`,
        onConfirm: async () => { setConfirmState(null); await run(); },
      });
    } else {
      await run();
    }
  };

  const handleDeleteKey = (key) => {
    setConfirmState({
      title: "Delete API Key",
      message: `Delete "${key.name}"?\n\nApplications using this key will be rejected immediately. This cannot be undone.`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${key.id}`, { method: "DELETE" });
          if (res.ok) {
            setKeys((prev) => prev.filter((k) => k.id !== key.id));
            if (manageKeyId === key.id) setManageKeyId(null);
          }
        } catch { /* ignore */ }
      },
    });
  };

  const handleResetKeyUsage = async (id) => {
    try {
      const res = await fetch(`/api/keys/${id}/reset-usage`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) replaceKey(data.key);
    } catch { /* ignore */ }
  };

  const handleAssignProject = async (key, targetProjectId) => {
    setActionError("");
    try {
      let res;
      if (!targetProjectId) {
        if (!key.assignedProjectId) return;
        res = await fetch(`/api/projects/${key.assignedProjectId}/api-keys`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKeyId: key.id }),
        });
      } else {
        res = await fetch(`/api/projects/${targetProjectId}/api-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKeyId: key.id }),
        });
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setActionError(data.error || "Could not change project assignment");
      }
      await reloadData();
    } catch (error) {
      setActionError(error.message);
    }
  };

  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const filteredKeys = useMemo(() => {
    const q = search.trim().toLowerCase();
    return keys.filter((key) => {
      if (q && !key.name?.toLowerCase().includes(q) && !key.id?.toLowerCase().includes(q)) return false;
      if (statusFilter === "active" && key.isActive === false) return false;
      if (statusFilter === "paused" && key.isActive !== false) return false;
      if (projectFilter === "assigned" && !key.assignedProjectId) return false;
      if (projectFilter === "unassigned" && key.assignedProjectId) return false;
      if (!["all", "assigned", "unassigned"].includes(projectFilter) && key.assignedProjectId !== projectFilter) return false;
      return true;
    });
  }, [keys, search, statusFilter, projectFilter]);

  const stats = useMemo(() => ({
    total: keys.length,
    active: keys.filter((k) => k.isActive !== false).length,
    paused: keys.filter((k) => k.isActive === false).length,
    assigned: keys.filter((k) => Boolean(k.assignedProjectId)).length,
  }), [keys]);

  const managedKey = manageKeyId ? keys.find((k) => k.id === manageKeyId) : null;

  const openManage = (key, tab = "general") => {
    setActionError("");
    setManageTab(tab);
    setManageKeyId(key.id);
  };

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-text-muted">
        <span className="material-symbols-outlined mr-2 animate-spin">progress_activity</span>
        Loading API keys…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-text-main">API Keys</h1>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${keySyncStatus === "live" ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-orange-500/10 text-orange-600 dark:text-orange-400"}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${keySyncStatus === "live" ? "bg-green-500" : "bg-orange-500"}`} />
              {keySyncStatus === "live" ? "Live" : "Syncing"}
            </span>
          </div>
          <p className="mt-1 text-sm text-text-muted">Create keys, control model access, quotas and Project Memory assignment.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" icon="refresh" onClick={reloadData}>Refresh</Button>
          <Button size="sm" icon="add" onClick={() => setShowAddModal(true)}>Create Key</Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatPill icon="key" label="Total keys" value={stats.total} />
        <StatPill icon="check_circle" label="Active" value={stats.active} tone="text-green-500 bg-green-500/10" />
        <StatPill icon="pause_circle" label="Paused" value={stats.paused} tone="text-orange-500 bg-orange-500/10" />
        <StatPill icon="account_tree" label="Linked to project" value={stats.assigned} tone="text-sky-500 bg-sky-500/10" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <div className="relative flex-1">
          <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-text-muted">search</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search keys by name…"
            className="h-10 w-full rounded-lg border border-border bg-surface pl-10 pr-3 text-sm outline-none transition focus:border-primary/60"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex h-10 items-center rounded-lg border border-border bg-surface p-1">
            {[["all", "All"], ["active", "Active"], ["paused", "Paused"]].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setStatusFilter(value)}
                className={`h-full rounded-md px-3 text-xs font-medium transition ${statusFilter === value ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text-main"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="h-10 max-w-[200px] rounded-lg border border-border bg-surface px-3 text-xs text-text-main outline-none"
          >
            <option value="all">All projects</option>
            <option value="assigned">Linked to a project</option>
            <option value="unassigned">No project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      {/* Key list */}
      {filteredKeys.length === 0 ? (
        <Card className="py-14 text-center">
          <span className="material-symbols-outlined text-[40px] text-text-muted">vpn_key_off</span>
          <p className="mt-2 font-medium text-text-main">{keys.length ? "No keys match your filters" : "No API keys yet"}</p>
          <p className="mt-1 text-sm text-text-muted">{keys.length ? "Try a different search or filter." : "Create your first key to start using the endpoint."}</p>
          {!keys.length && <Button className="mt-4" icon="add" onClick={() => setShowAddModal(true)}>Create Key</Button>}
        </Card>
      ) : (
        <div className="space-y-3">
          {filteredKeys.map((key) => {
            const isActive = key.isActive !== false;
            const isVisible = visibleKeys.has(key.id);
            const project = key.assignedProjectId ? projectMap.get(key.assignedProjectId) : null;
            const restricted = key.access?.restricted === true;
            return (
              <div
                key={key.id}
                className={`rounded-xl border bg-surface transition hover:border-primary/30 hover:shadow-sm ${isActive ? "border-border" : "border-border opacity-70"}`}
              >
                <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] lg:items-center">
                  {/* Identity */}
                  <div className="flex min-w-0 gap-3">
                    <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${isActive ? "bg-primary/10 text-primary" : "bg-black/5 text-text-muted dark:bg-white/10"}`}>
                      <span className="material-symbols-outlined text-[20px]">vpn_key</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate text-sm font-semibold text-text-main">{key.name || "Unnamed key"}</p>
                        <Badge tone={isActive ? "green" : "orange"}>{isActive ? "Active" : "Paused"}</Badge>
                        {key.isExpired && <Badge tone="red">Expired</Badge>}
                        {restricted && <Badge tone="amber">{key.access.allow?.length || 0} models</Badge>}
                        {key.v2Proxy?.enabled && <Badge tone="primary">V2</Badge>}
                      </div>
                      <div className="mt-1.5 flex items-center gap-1">
                        <code className="truncate rounded bg-black/5 px-2 py-0.5 font-mono text-[11px] text-text-muted dark:bg-white/5">
                          {isVisible ? key.key : maskKey(key.key)}
                        </code>
                        <button type="button" onClick={() => toggleKeyVisibility(key.id)} title={isVisible ? "Hide" : "Show"} className="rounded p-1 text-text-muted transition hover:bg-black/5 hover:text-primary dark:hover:bg-white/5">
                          <span className="material-symbols-outlined text-[15px]">{isVisible ? "visibility_off" : "visibility"}</span>
                        </button>
                        <button type="button" onClick={() => copy(key.key, key.id)} title="Copy" className="rounded p-1 text-text-muted transition hover:bg-black/5 hover:text-primary dark:hover:bg-white/5">
                          <span className="material-symbols-outlined text-[15px]">{copied === key.id ? "check" : "content_copy"}</span>
                        </button>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
                        <span className="inline-flex items-center gap-1">
                          <span className="material-symbols-outlined text-[13px]">calendar_today</span>
                          {new Date(key.createdAt).toLocaleDateString()}
                        </span>
                        {project ? (
                          <Link href={`/dashboard/projects/${project.id}`} className="inline-flex items-center gap-1 text-sky-500 hover:underline">
                            <span className="material-symbols-outlined text-[13px]">account_tree</span>
                            {project.name}
                          </Link>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <span className="material-symbols-outlined text-[13px]">link_off</span>
                            No project
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Usage */}
                  <div className="grid grid-cols-3 gap-3 lg:grid-cols-1 lg:gap-2">
                    <UsageBar label="Requests" used={key.usage?.requests} limit={key.quota?.maxRequests} />
                    <UsageBar label="Input tokens" used={key.usage?.inputTokens} limit={key.quota?.maxInputTokens} />
                    <UsageBar label="Cost" used={key.usage?.cost} limit={key.quota?.maxCost} format={money} />
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-end gap-2 border-t border-border pt-3 lg:border-0 lg:pt-0">
                    <Toggle size="sm" checked={isActive} onChange={(checked) => handleToggleKey(key, checked)} />
                    <Button size="sm" variant="secondary" icon="settings" onClick={() => openManage(key)}>Manage</Button>
                    <button
                      type="button"
                      onClick={() => handleDeleteKey(key)}
                      title="Delete key"
                      className="flex size-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-red-500/10 hover:text-red-500"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Manage modal: all detailed controls live here instead of cluttering the list */}
      <Modal
        isOpen={Boolean(managedKey)}
        onClose={() => setManageKeyId(null)}
        title={managedKey ? `Manage · ${managedKey.name}` : "Manage key"}
        size="full"
      >
        {managedKey && (
          <div className="space-y-4">
            <div className="flex gap-1 overflow-x-auto border-b border-border">
              {MANAGE_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setManageTab(tab.id)}
                  className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-xs font-medium transition ${manageTab === tab.id ? "border-primary text-primary" : "border-transparent text-text-muted hover:text-text-main"}`}
                >
                  <span className="material-symbols-outlined text-[16px]">{tab.icon}</span>
                  {tab.label}
                </button>
              ))}
            </div>

            {actionError && <div className="rounded-lg border border-red-500/25 bg-red-500/5 p-2.5 text-xs text-red-500">{actionError}</div>}

            <div className="max-h-[60vh] overflow-y-auto pr-1">
              {manageTab === "general" && (
                <div className="space-y-4">
                  <section>
                    <h3 className="text-sm font-semibold text-text-main">Project Memory</h3>
                    <p className="mt-0.5 text-xs text-text-muted">Requests made with this key will use the selected project&apos;s memory and files as context.</p>
                    <div className="mt-2 flex items-center gap-2">
                      <select
                        value={managedKey.assignedProjectId || ""}
                        onChange={(e) => handleAssignProject(managedKey, e.target.value)}
                        disabled={managedKey.projectAccess === false}
                        className="h-10 flex-1 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-main outline-none disabled:opacity-50"
                      >
                        <option value="">No project (default gateway behavior)</option>
                        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      {managedKey.assignedProjectId && (
                        <Link href={`/dashboard/projects/${managedKey.assignedProjectId}`} className="inline-flex h-10 items-center gap-1 rounded-lg border border-border px-3 text-xs text-text-muted hover:border-primary/50 hover:text-primary">
                          <span className="material-symbols-outlined text-[15px]">open_in_new</span>
                          Open
                        </Link>
                      )}
                    </div>
                    {managedKey.projectAccess === false && (
                      <p className="mt-1.5 text-[11px] text-orange-500">Project access is disabled for this key by an administrator.</p>
                    )}
                  </section>

                  <section className="border-t border-border pt-4">
                    <h3 className="text-sm font-semibold text-text-main">Key Usage page</h3>
                    <KeyUsageAccessControls apiKey={managedKey} onChange={(updates) => updateKey(managedKey.id, updates)} />
                  </section>

                  <section className="border-t border-border pt-4">
                    <h3 className="text-sm font-semibold text-text-main">Details</h3>
                    <dl className="mt-2 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
                      <div><dt className="text-text-muted">Key ID</dt><dd className="mt-0.5 truncate font-mono text-text-main" title={managedKey.id}>{managedKey.id}</dd></div>
                      <div><dt className="text-text-muted">Owner</dt><dd className="mt-0.5 truncate text-text-main">{managedKey.ownerId || "—"}</dd></div>
                      <div><dt className="text-text-muted">Created</dt><dd className="mt-0.5 text-text-main">{new Date(managedKey.createdAt).toLocaleString()}</dd></div>
                      <div><dt className="text-text-muted">V2 forwarding</dt><dd className="mt-0.5 text-text-main">{managedKey.v2Proxy?.enabled ? "Enabled" : "Disabled"}</dd></div>
                    </dl>
                    <p className="mt-2 text-[11px] text-text-muted">V2 forwarding can be configured from the Endpoint &amp; Key page.</p>
                  </section>
                </div>
              )}

              {manageTab === "access" && (
                <KeyAccessControls
                  apiKey={managedKey}
                  onChange={(access) => updateKey(managedKey.id, { access })}
                  onModelRoutingChange={(modelRouting) => updateKey(managedKey.id, { modelRouting })}
                  onRequestRestrict={() => setConfirmState({
                    title: "Restrict API Key",
                    message: `Restrict "${managedKey.name}"?\n\nIt will only be able to call the combos and models you add. Until you add one, it can call nothing.`,
                    onConfirm: async () => {
                      setConfirmState(null);
                      await updateKey(managedKey.id, {
                        access: {
                          restricted: true,
                          allow: managedKey.access?.allow || [],
                          accountRestricted: managedKey.access?.accountRestricted === true,
                          accountIds: managedKey.access?.accountIds || [],
                        },
                      });
                    },
                  })}
                />
              )}

              {manageTab === "effort" && (
                <KeyEffortControls apiKey={managedKey} onSave={(effortPolicy) => updateKey(managedKey.id, { effortPolicy })} />
              )}

              {manageTab === "quota" && (
                <KeyQuotaControls
                  apiKey={managedKey}
                  onSave={(quota) => updateKey(managedKey.id, { quota })}
                  onRequestReset={() => setConfirmState({
                    title: "Reset API Key Usage",
                    message: `Reset request, input-token, and cost usage for "${managedKey.name}"?\n\nThe configured limits will be kept. This cannot be undone.`,
                    onConfirm: async () => { setConfirmState(null); await handleResetKeyUsage(managedKey.id); },
                  })}
                />
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Create key */}
      <Modal
        isOpen={showAddModal}
        onClose={() => { setShowAddModal(false); resetCreateForm(); }}
        title="Create API Key"
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Key name</label>
            <Input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="e.g. Cursor IDE, Production" autoFocus />
          </div>
          <div className="rounded-lg border border-border p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={newKeyV2Enabled} onChange={(e) => setNewKeyV2Enabled(e.target.checked)} className="size-4 accent-primary" />
              Enable V2 forwarding
            </label>
            {newKeyV2Enabled && (
              <div className="mt-3 space-y-3">
                <Input value={newKeyV2Endpoint} onChange={(e) => setNewKeyV2Endpoint(e.target.value)} placeholder="Upstream base URL — https://api.example.com/v1" />
                <Input type="password" value={newKeyV2ApiKey} onChange={(e) => setNewKeyV2ApiKey(e.target.value)} placeholder="Upstream API key" />
              </div>
            )}
          </div>
          {newKeyError && <p className="text-sm text-red-500">{newKeyError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => { setShowAddModal(false); resetCreateForm(); }}>Cancel</Button>
            <Button
              onClick={handleCreateKey}
              disabled={!newKeyName.trim() || (newKeyV2Enabled && (!newKeyV2Endpoint.trim() || !newKeyV2ApiKey.trim()))}
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>

      {/* Created key */}
      <Modal isOpen={Boolean(createdKey)} onClose={() => setCreatedKey(null)} title="API Key Created">
        <div className="space-y-4">
          <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-300">
            <p className="font-medium">Save this key now</p>
            <p className="mt-0.5 text-xs">You can view or copy it later from the API Keys list.</p>
          </div>
          <div className="flex gap-2">
            <Input value={createdKey || ""} readOnly className="font-mono text-xs" />
            <Button onClick={() => copy(createdKey, "created")}>{copied === "created" ? "Copied" : "Copy"}</Button>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => setCreatedKey(null)}>Done</Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={Boolean(confirmState)}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}
