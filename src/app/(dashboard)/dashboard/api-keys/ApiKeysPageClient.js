"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, Input, Toggle, Modal, ConfirmModal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import KeyAccessControls from "../endpoint/components/KeyAccessControls";
import KeyQuotaControls from "../endpoint/components/KeyQuotaControls";
import KeyEffortControls from "../endpoint/components/KeyEffortControls";
import KeyUsageAccessControls from "../endpoint/components/KeyUsageAccessControls";

const KEY_SYNC_DEBOUNCE_MS = 300;
const KEY_SYNC_FALLBACK_MS = 30000;

function maskKey(fullKey) {
  if (!fullKey || fullKey.length <= 10) return fullKey || "";
  return fullKey.slice(0, 6) + "•".repeat(Math.max(4, fullKey.length - 10)) + fullKey.slice(-4);
}

function MetricCard({ icon, label, value, detail, color = "text-primary" }) {
  return (
    <Card padding="sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</p>
          <p className="mt-1 text-2xl font-bold text-text-main">{value}</p>
          {detail && <p className="mt-0.5 text-xs text-text-muted">{detail}</p>}
        </div>
        <span className={`material-symbols-outlined rounded-xl bg-black/5 dark:bg-white/5 p-2 text-[20px] ${color}`}>
          {icon}
        </span>
      </div>
    </Card>
  );
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

  // Create key modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyV2Enabled, setNewKeyV2Enabled] = useState(false);
  const [newKeyV2Endpoint, setNewKeyV2Endpoint] = useState("");
  const [newKeyV2ApiKey, setNewKeyV2ApiKey] = useState("");
  const [newKeyError, setNewKeyError] = useState("");
  const [createdKey, setCreatedKey] = useState(null);

  // Confirm modal state
  const [confirmState, setConfirmState] = useState(null);
  const { copied, copy } = useCopyToClipboard(2000);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch("/api/keys");
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

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await reloadData();
      } finally {
        if (active) setLoading(false);
      }
    })();

    let refreshTimer = null;
    let refreshing = false;
    let refreshAgain = false;

    const refreshKeys = async () => {
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        const fetched = await fetchKeys();
        if (active) setKeys(fetched);
      } catch {
        // Fallback retry
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
      source.onopen = () => {
        if (active) setKeySyncStatus("live");
      };
      source.onerror = () => {
        if (active) setKeySyncStatus("reconnecting");
      };
      source.addEventListener("keys-changed", scheduleRefresh);
    } catch {
      // SSE not available
    }

    const onVisible = () => {
      if (!document.hidden) scheduleRefresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const fallback = setInterval(() => {
      if (!document.hidden) scheduleRefresh();
    }, KEY_SYNC_FALLBACK_MS);

    return () => {
      active = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      clearInterval(fallback);
      document.removeEventListener("visibilitychange", onVisible);
      if (source) source.close();
    };
  }, [fetchKeys, reloadData]);

  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
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
        setNewKeyName("");
        setNewKeyV2Enabled(false);
        setNewKeyV2Endpoint("");
        setNewKeyV2ApiKey("");
        setShowAddModal(false);
      } else {
        setNewKeyError(data.error || "Failed to create API key");
      }
    } catch (error) {
      console.error("Error creating key:", error);
      setNewKeyError("Failed to create API key");
    }
  };

  const handleToggleKey = async (id, isActive) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, isActive } : k)));
      }
    } catch (error) {
      console.error("Error toggling key:", error);
    }
  };

  const handleDeleteKey = (id, name) => {
    setConfirmState({
      title: "Delete API Key",
      message: `Are you sure you want to delete API key "${name}"? This key will immediately stop working and any applications using it will be rejected.`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (res.ok) {
            setKeys((prev) => prev.filter((k) => k.id !== id));
            setVisibleKeys((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        } catch (error) {
          console.error("Error deleting key:", error);
        }
      },
    });
  };

  const handleUpdateKeyAccess = async (id, access) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        setKeys((prev) => prev.map((k) => (k.id === id ? data.key : k)));
        return { ok: true };
      }
      return { ok: false, error: data.error || `Request failed (${res.status})` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const handleUpdateKeyModelRouting = async (id, modelRouting) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelRouting }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        setKeys((prev) => prev.map((k) => (k.id === id ? data.key : k)));
        return { ok: true };
      }
      return { ok: false, error: data.error || `Request failed (${res.status})` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const handleUpdateKeyQuota = async (id, quota) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quota }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        setKeys((prev) => prev.map((k) => (k.id === id ? data.key : k)));
        return { ok: true };
      }
      return { ok: false, error: data.error || `Request failed (${res.status})` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const handleUpdateKeyEffort = async (id, effortPolicy) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effortPolicy }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        setKeys((prev) => prev.map((k) => (k.id === id ? data.key : k)));
        return { ok: true };
      }
      return { ok: false, error: data.error || `Request failed (${res.status})` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const handleUpdateKeyUsageAccess = async (id, updates) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        setKeys((prev) => prev.map((k) => (k.id === id ? data.key : k)));
        return { ok: true };
      }
      return { ok: false, error: data.error || `Request failed (${res.status})` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const handleResetKeyUsage = async (id) => {
    try {
      const res = await fetch(`/api/keys/${id}/usage/reset`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        setKeys((prev) => prev.map((k) => (k.id === id ? data.key : k)));
      }
    } catch (error) {
      console.error("Error resetting key usage:", error);
    }
  };

  const handleAssignProject = async (apiKeyId, currentProjectId, targetProjectId) => {
    try {
      if (targetProjectId === "") {
        // Unassign
        if (currentProjectId) {
          await fetch(`/api/projects/${currentProjectId}/api-keys`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKeyId }),
          });
        }
      } else {
        // Assign to new project
        await fetch(`/api/projects/${targetProjectId}/api-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKeyId }),
        });
      }
      await reloadData();
    } catch (error) {
      console.error("Error changing project assignment:", error);
    }
  };

  // Filtered keys
  const filteredKeys = useMemo(() => {
    return keys.filter((key) => {
      // Search
      if (search.trim()) {
        const q = search.toLowerCase();
        const matchesName = key.name?.toLowerCase().includes(q);
        const matchesId = key.id?.toLowerCase().includes(q);
        const matchesKey = key.key?.toLowerCase().includes(q);
        if (!matchesName && !matchesId && !matchesKey) return false;
      }

      // Status
      if (statusFilter === "active" && key.isActive === false) return false;
      if (statusFilter === "paused" && key.isActive !== false) return false;

      // Project
      if (projectFilter === "assigned" && !key.assignedProjectId) return false;
      if (projectFilter === "unassigned" && key.assignedProjectId) return false;
      if (projectFilter !== "all" && projectFilter !== "assigned" && projectFilter !== "unassigned") {
        if (key.assignedProjectId !== projectFilter) return false;
      }

      return true;
    });
  }, [keys, search, statusFilter, projectFilter]);

  // Project map for quick lookup
  const projectMap = useMemo(() => {
    const map = new Map();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  // Statistics
  const stats = useMemo(() => {
    const total = keys.length;
    const active = keys.filter((k) => k.isActive !== false).length;
    const paused = keys.filter((k) => k.isActive === false).length;
    const assigned = keys.filter((k) => Boolean(k.assignedProjectId)).length;
    return { total, active, paused, assigned };
  }, [keys]);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-text-muted">
        <span className="material-symbols-outlined mr-2 animate-spin">progress_activity</span>
        Loading API keys…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-text-main flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[28px]">vpn_key</span>
              API Keys
            </h1>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${keySyncStatus === "live" ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-orange-500/10 text-orange-600 dark:text-orange-400"}`}
              title={keySyncStatus === "live" ? "Live real-time sync connected" : "Syncing updates..."}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${keySyncStatus === "live" ? "bg-green-500" : "bg-orange-500"}`} />
              {keySyncStatus === "live" ? "Live" : "Syncing"}
            </span>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            Manage client access tokens, model restrictions, usage quotas, and Project Memory assignments.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" icon="refresh" onClick={reloadData}>
            Refresh
          </Button>
          <Button icon="add" onClick={() => setShowAddModal(true)}>
            Create Key
          </Button>
        </div>
      </div>

      {/* Metrics Overview */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard icon="key" label="Total Keys" value={stats.total} detail={`${stats.active} enabled`} />
        <MetricCard icon="check_circle" label="Active Keys" value={stats.active} color="text-green-500" detail="Ready for requests" />
        <MetricCard icon="pause_circle" label="Paused Keys" value={stats.paused} color="text-orange-500" detail="Temporarily disabled" />
        <MetricCard icon="account_tree" label="Project Assigned" value={stats.assigned} color="text-brand-500" detail="Memory context active" />
      </div>

      {/* Search and Filters */}
      <Card padding="sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[17px] text-text-muted">
              search
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by key name or ID..."
              className="h-9 w-full rounded-lg border border-border bg-surface-2 pl-9 pr-3 text-xs outline-none focus:border-primary"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 rounded-lg border border-border bg-surface-2 px-3 text-xs text-text-main outline-none"
            >
              <option value="all">All Status</option>
              <option value="active">Active Only</option>
              <option value="paused">Paused Only</option>
            </select>

            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="h-9 rounded-lg border border-border bg-surface-2 px-3 text-xs text-text-main outline-none max-w-[200px] truncate"
            >
              <option value="all">All Projects</option>
              <option value="assigned">Assigned to Any Project</option>
              <option value="unassigned">Unassigned</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  Project: {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {/* Keys Table Card */}
      <Card padding="none" className="overflow-hidden">
        {filteredKeys.length === 0 ? (
          <div className="py-12 text-center text-text-muted">
            <span className="material-symbols-outlined text-[36px] text-text-muted">vpn_key_off</span>
            <p className="mt-2 text-sm font-medium">No API keys match your filters</p>
            <p className="mt-1 text-xs">Try adjusting search query or filter options</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-xs">
              <thead className="border-b border-border bg-surface-2/70 text-[10px] uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-4 py-3 font-semibold">Key Name & Details</th>
                  <th className="px-4 py-3 font-semibold">Key Token</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Project Memory</th>
                  <th className="px-4 py-3 font-semibold">Model Access</th>
                  <th className="px-4 py-3 font-semibold">Usage & Quota</th>
                  <th className="px-4 py-3 font-semibold text-right">Controls & Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filteredKeys.map((key) => {
                  const assignedProject = key.assignedProjectId ? projectMap.get(key.assignedProjectId) : null;
                  const isVisible = visibleKeys.has(key.id);

                  return (
                    <tr
                      key={key.id}
                      className={`transition-colors hover:bg-surface-2/40 ${key.isActive === false ? "opacity-60" : ""}`}
                    >
                      {/* Name & Owner */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-text-main text-sm">{key.name || "Unnamed"}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[10px] text-text-muted">
                          <span>Created {new Date(key.createdAt).toLocaleDateString()}</span>
                          {key.ownerId && <span>• Owner: {key.ownerId}</span>}
                          {key.v2Proxy?.enabled && (
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary font-medium">V2 Proxy</span>
                          )}
                        </div>
                      </td>

                      {/* Key Token */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <code className="font-mono text-xs text-text-muted">
                            {isVisible ? key.key : maskKey(key.key)}
                          </code>
                          <button
                            type="button"
                            onClick={() => toggleKeyVisibility(key.id)}
                            className="rounded p-1 text-text-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-primary transition"
                            title={isVisible ? "Hide key" : "Show key"}
                          >
                            <span className="material-symbols-outlined text-[15px]">
                              {isVisible ? "visibility_off" : "visibility"}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => copy(key.key, key.id)}
                            className="rounded p-1 text-text-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-primary transition"
                            title="Copy key"
                          >
                            <span className="material-symbols-outlined text-[15px]">
                              {copied === key.id ? "check" : "content_copy"}
                            </span>
                          </button>
                        </div>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Toggle
                            size="sm"
                            checked={key.isActive ?? true}
                            onChange={(checked) => {
                              if (key.isActive && !checked) {
                                setConfirmState({
                                  title: "Pause API Key",
                                  message: `Pause API key "${key.name}"?\n\nThis key will stop working immediately until resumed.`,
                                  onConfirm: async () => {
                                    setConfirmState(null);
                                    handleToggleKey(key.id, checked);
                                  },
                                });
                              } else {
                                handleToggleKey(key.id, checked);
                              }
                            }}
                          />
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                              key.isActive !== false
                                ? "bg-green-500/10 text-green-500"
                                : "bg-orange-500/10 text-orange-500"
                            }`}
                          >
                            {key.isActive !== false ? "Active" : "Paused"}
                          </span>
                        </div>
                      </td>

                      {/* Project Memory Assignment */}
                      <td className="px-4 py-3">
                        <select
                          value={key.assignedProjectId || ""}
                          onChange={(e) =>
                            handleAssignProject(key.id, key.assignedProjectId, e.target.value)
                          }
                          className="h-8 rounded-lg border border-border bg-surface-2 px-2 text-xs text-text-main outline-none max-w-[170px]"
                        >
                          <option value="">No Project</option>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        {assignedProject && (
                          <div className="mt-1">
                            <Link
                              href={`/dashboard/projects/${assignedProject.id}`}
                              className="inline-flex items-center gap-1 text-[10px] text-brand-500 hover:underline"
                            >
                              <span className="material-symbols-outlined text-[12px]">open_in_new</span>
                              Open workspace
                            </Link>
                          </div>
                        )}
                      </td>

                      {/* Model Access */}
                      <td className="px-4 py-3">
                        {key.access?.restricted ? (
                          <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                            {key.access.allow?.length || 0} Models Allowed
                          </span>
                        ) : (
                          <span className="rounded bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-500">
                            All Models
                          </span>
                        )}
                        {key.modelRouting?.selectedModel && (
                          <p className="mt-1 text-[10px] text-text-muted truncate max-w-[130px]" title={key.modelRouting.selectedModel}>
                            Target: {key.modelRouting.selectedModel}
                          </p>
                        )}
                      </td>

                      {/* Usage & Quota */}
                      <td className="px-4 py-3">
                        <div className="space-y-0.5 text-[11px] text-text-muted">
                          <p>
                            Reqs: <strong className="text-text-main">{key.usage?.requests ?? 0}</strong>
                            {key.quota?.maxRequests ? ` / ${key.quota.maxRequests}` : ""}
                          </p>
                          <p>
                            Tokens: <strong className="text-text-main">{key.usage?.inputTokens ?? 0}</strong>
                            {key.quota?.maxInputTokens ? ` / ${key.quota.maxInputTokens}` : ""}
                          </p>
                          {key.usage?.cost > 0 && (
                            <p>
                              Cost: <strong className="text-text-main">${key.usage.cost.toFixed(4)}</strong>
                            </p>
                          )}
                        </div>
                      </td>

                      {/* Controls and Actions */}
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1 flex-wrap">
                          <KeyUsageAccessControls
                            apiKey={key}
                            onChange={(updates) => handleUpdateKeyUsageAccess(key.id, updates)}
                          />
                          <KeyAccessControls
                            apiKey={key}
                            onChange={(access) => handleUpdateKeyAccess(key.id, access)}
                            onModelRoutingChange={(modelRouting) =>
                              handleUpdateKeyModelRouting(key.id, modelRouting)
                            }
                            onRequestRestrict={() =>
                              setConfirmState({
                                title: "Restrict API Key",
                                message: `Restrict API key "${key.name}"?\n\nIt will only be able to call the models you allow.`,
                                onConfirm: async () => {
                                  setConfirmState(null);
                                  handleUpdateKeyAccess(key.id, {
                                    restricted: true,
                                    allow: key.access?.allow || [],
                                    accountRestricted: key.access?.accountRestricted === true,
                                    accountIds: key.access?.accountIds || [],
                                  });
                                },
                              })
                            }
                          />
                          <KeyEffortControls
                            apiKey={key}
                            onSave={(policy) => handleUpdateKeyEffort(key.id, policy)}
                          />
                          <KeyQuotaControls
                            apiKey={key}
                            onSave={(quota) => handleUpdateKeyQuota(key.id, quota)}
                            onRequestReset={() =>
                              setConfirmState({
                                title: "Reset API Key Usage",
                                message: `Reset request, input-token, and cost usage for "${key.name}"?\n\nConfigured limits will be kept.`,
                                onConfirm: async () => {
                                  setConfirmState(null);
                                  await handleResetKeyUsage(key.id);
                                },
                              })
                            }
                          />
                          <Button
                            size="xs"
                            variant="danger"
                            icon="delete"
                            onClick={() => handleDeleteKey(key.id, key.name)}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Create Key Modal */}
      <Modal
        isOpen={showAddModal}
        onClose={() => {
          setShowAddModal(false);
          setNewKeyError("");
        }}
        title="Create API Key"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Key Name</label>
            <Input
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="e.g., Development, Cursor IDE, Production"
              autoFocus
            />
          </div>

          <div className="border-t border-border pt-3">
            <label className="flex items-center gap-2 cursor-pointer text-sm font-medium">
              <input
                type="checkbox"
                checked={newKeyV2Enabled}
                onChange={(e) => setNewKeyV2Enabled(e.target.checked)}
                className="size-4 accent-primary"
              />
              Enable V2 Proxy Forwarding
            </label>
            {newKeyV2Enabled && (
              <div className="mt-3 space-y-3 pl-6 border-l-2 border-primary/20">
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1">
                    Upstream Base URL
                  </label>
                  <Input
                    value={newKeyV2Endpoint}
                    onChange={(e) => setNewKeyV2Endpoint(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1">
                    Upstream API Key
                  </label>
                  <Input
                    type="password"
                    value={newKeyV2ApiKey}
                    onChange={(e) => setNewKeyV2ApiKey(e.target.value)}
                    placeholder="sk-..."
                  />
                </div>
              </div>
            )}
          </div>

          {newKeyError && <p className="text-sm text-red-500">{newKeyError}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              onClick={() => {
                setShowAddModal(false);
                setNewKeyError("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateKey}
              disabled={
                !newKeyName.trim() ||
                (newKeyV2Enabled && (!newKeyV2Endpoint.trim() || !newKeyV2ApiKey.trim()))
              }
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>

      {/* Newly Created Key Display Modal */}
      <Modal
        isOpen={Boolean(createdKey)}
        onClose={() => setCreatedKey(null)}
        title="API Key Created"
      >
        <div className="space-y-4">
          <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-4 text-sm text-yellow-600 dark:text-yellow-400">
            <p className="font-semibold">Save this key now!</p>
            <p className="mt-1 text-xs">
              Store this key securely. You can view and copy it anytime from the API Keys list.
            </p>
          </div>
          <div className="flex gap-2">
            <Input value={createdKey || ""} readOnly className="font-mono text-xs" />
            <Button onClick={() => copy(createdKey, "modal")}>
              {copied === "modal" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <div className="flex justify-end pt-2">
            <Button onClick={() => setCreatedKey(null)}>Done</Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Modal */}
      {confirmState && (
        <ConfirmModal
          isOpen={Boolean(confirmState)}
          title={confirmState.title}
          message={confirmState.message}
          onConfirm={confirmState.onConfirm}
          onClose={() => setConfirmState(null)}
        />
      )}
    </div>
  );
}
