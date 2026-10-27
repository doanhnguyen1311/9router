"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, ThemeToggle } from "@/shared/components";

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

const exactNumber = new Intl.NumberFormat("en-US");

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const AUTO_REFRESH_MS = 30_000;

function formatDate(value, includeTime = true) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

function Progress({ value, limit, label }) {
  if (limit === null || limit === undefined) {
    return (
      <div className="mt-4 flex items-center justify-between text-[11px] text-text-muted">
        <span>{label}</span>
        <span className="font-medium text-text-main">Unlimited</span>
      </div>
    );
  }

  const percent = limit > 0 ? Math.min(100, (value / limit) * 100) : 0;
  const isNearLimit = percent >= 80;

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-text-muted">
        <span>{label}</span>
        <span className={isNearLimit ? "font-semibold text-warning" : "font-medium text-text-main"}>
          {percent.toFixed(percent < 10 ? 1 : 0)}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(value, limit)}>
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${isNearLimit ? "bg-warning" : "bg-brand-500"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-text-muted">
        {exactNumber.format(value)} of {exactNumber.format(limit)}
      </p>
    </div>
  );
}

function MetricCard({ icon, label, value, detail, children }) {
  return (
    <Card padding="sm" className="min-h-40">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-text-muted">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-text-main sm:text-[28px]">{value}</p>
          <p className="mt-1 text-xs text-text-muted">{detail}</p>
        </div>
        <span className="material-symbols-outlined rounded-[10px] bg-brand-500/10 p-2 text-[20px] text-brand-500" aria-hidden="true">
          {icon}
        </span>
      </div>
      {children}
    </Card>
  );
}

function scheduleLabel(windowInfo) {
  if (windowInfo.resetMode !== "scheduled") return "Manual reset window";
  if (windowInfo.resetInterval === "custom") {
    return `Resets every ${windowInfo.resetIntervalValue} ${windowInfo.resetIntervalUnit}`;
  }
  return `${windowInfo.resetInterval?.charAt(0).toUpperCase()}${windowInfo.resetInterval?.slice(1)} reset`;
}

export default function KeyUsageClient() {
  const [apiKey, setApiKey] = useState("");
  const [activeKey, setActiveKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelMessage, setModelMessage] = useState("");
  const requestControllerRef = useRef(null);

  const fetchUsage = useCallback(async (key, { background = false } = {}) => {
    if (background && requestControllerRef.current) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    if (background) setBackgroundRefreshing(true);
    else setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/key-usage", {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const responseError = new Error(body.error || "Unable to load usage right now.");
        responseError.status = response.status;
        throw responseError;
      }
      setSummary(body);
      setActiveKey(key);
      setRefreshedAt(new Date());
    } catch (requestError) {
      if (requestError.name === "AbortError") return;
      if (background && (!requestError.status || requestError.status >= 500)) {
        setError("Auto-refresh failed. The page will try again in 30 seconds.");
        return;
      }
      setSummary(null);
      setActiveKey("");
      setError(requestError.message || "Unable to load usage right now.");
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        if (background) setBackgroundRefreshing(false);
        else setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!activeKey) return undefined;
    const intervalId = window.setInterval(() => {
      void fetchUsage(activeKey, { background: true });
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [activeKey, fetchUsage]);

  useEffect(() => () => requestControllerRef.current?.abort(), []);

  const loadUsage = (event) => {
    event?.preventDefault();
    const key = apiKey.trim();
    if (!key) {
      setError("Enter your 9Router API key to continue.");
      return;
    }
    void fetchUsage(key);
  };

  const handleKeyChange = (event) => {
    const nextKey = event.target.value;
    setApiKey(nextKey);
    if (activeKey && nextKey.trim() !== activeKey) {
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      setActiveKey("");
      setSummary(null);
      setRefreshedAt(null);
      setError("");
      setLoading(false);
      setBackgroundRefreshing(false);
      setModelSaving(false);
      setModelMessage("");
    }
  };

  const clearKey = () => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setApiKey("");
    setActiveKey("");
    setSummary(null);
    setError("");
    setRefreshedAt(null);
    setShowKey(false);
    setLoading(false);
    setBackgroundRefreshing(false);
    setModelSaving(false);
    setModelMessage("");
  };

  const selectModel = async (selectedModel) => {
    if (!activeKey || !summary?.modelAccess?.publicModel) return;
    setModelSaving(true);
    setModelMessage("");
    try {
      const response = await fetch("/api/key-usage", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${activeKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ selectedModel }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Unable to change model.");
      setSummary((current) => current ? { ...current, modelAccess: body.modelAccess } : current);
      setModelMessage("Model updated.");
    } catch (selectionError) {
      setModelMessage(selectionError.message || "Unable to change model.");
    } finally {
      setModelSaving(false);
    }
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-bg">
      <div className="landing-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="pointer-events-none absolute -left-32 top-[-12rem] size-[32rem] rounded-full bg-brand-500/10 blur-[110px]" aria-hidden="true" />
      <div className="pointer-events-none absolute -right-36 bottom-[-14rem] size-[30rem] rounded-full bg-blue-500/8 blur-[120px]" aria-hidden="true" />

      <header className="relative z-10 border-b border-border-subtle bg-bg/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-3" aria-label="9Router home">
            <span className="flex size-9 items-center justify-center rounded-[10px] bg-gradient-to-br from-brand-500 to-brand-700 shadow-[var(--shadow-warm)]">
              <span className="material-symbols-outlined text-[20px] text-white" aria-hidden="true">hub</span>
            </span>
            <span>
              <span className="block text-sm font-semibold leading-tight text-text-main">9Router</span>
              <span className="block text-[11px] leading-tight text-text-muted">API usage</span>
            </span>
          </Link>
          <div className="flex items-center gap-1">
            <Link href="/login" className="rounded-[9px] px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main">
              Admin login
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <section className="mx-auto max-w-2xl text-center">
          <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-brand-500/20 bg-brand-500/8 px-3 py-1.5 text-xs font-medium text-brand-600 dark:text-brand-300">
            <span className="material-symbols-outlined text-[15px]" aria-hidden="true">shield_lock</span>
            Your key stays in this tab
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] text-text-main sm:text-5xl">
            See exactly what your key has used.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-text-muted sm:text-base">
            Paste an active 9Router API key to view requests, tokens, cost, and model activity for its current usage window.
          </p>
        </section>

        <Card elev padding="sm" className="mx-auto mt-8 max-w-3xl sm:p-5">
          <form onSubmit={loadUsage} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label htmlFor="api-key" className="mb-1.5 block text-xs font-semibold text-text-main">API key</label>
              <div className="relative">
                <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-text-muted" aria-hidden="true">key</span>
                <input
                  id="api-key"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={handleKeyChange}
                  placeholder="sk-••••••••••••••••"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "key-usage-error" : "key-usage-hint"}
                  className="h-11 w-full rounded-[10px] border border-border bg-surface-2 pl-10 pr-11 font-mono text-[16px] text-text-main outline-none transition focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/20 sm:text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((visible) => !visible)}
                  className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-3 hover:text-text-main"
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                >
                  <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{showKey ? "visibility_off" : "visibility"}</span>
                </button>
              </div>
            </div>
            <div className="flex gap-2">
              {summary && (
                <Button type="button" variant="outline" size="lg" onClick={clearKey} className="flex-1 sm:flex-none">
                  Clear
                </Button>
              )}
              <Button type="submit" size="lg" loading={loading} disabled={!apiKey.trim()} className="flex-1 sm:flex-none">
                {summary ? "Refresh" : "View usage"}
              </Button>
            </div>
          </form>
          <div className="mt-3 min-h-5" aria-live="polite">
            {error ? (
              <p id="key-usage-error" className="flex items-center gap-1.5 text-xs text-danger">
                <span className="material-symbols-outlined text-[15px]" aria-hidden="true">error</span>
                {error}
              </p>
            ) : (
              <p id="key-usage-hint" className="flex items-center gap-1.5 text-xs text-text-muted">
                <span className="material-symbols-outlined text-[15px]" aria-hidden="true">lock</span>
                Sent securely in the request header and never stored by this page.
              </p>
            )}
          </div>
        </Card>

        {summary && (
          <section className="mt-8 fade-in" aria-label="API key usage results" aria-busy={loading || backgroundRefreshing}>
            <div className="mb-4 flex flex-col gap-3 rounded-[14px] border border-border-subtle bg-surface/80 px-4 py-3 shadow-[var(--shadow-soft)] backdrop-blur sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
                  <span className="material-symbols-outlined text-[20px]" aria-hidden="true">verified</span>
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-text-main">{summary.key.name}</h2>
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">Active</span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{summary.key.masked}</p>
                </div>
              </div>
              <div className="text-left text-[11px] text-text-muted sm:text-right">
                <p className="font-medium text-text-main">{scheduleLabel(summary.window)}</p>
                <p className="mt-0.5">
                  {summary.window.resetsAt
                    ? `Next reset ${formatDate(summary.window.resetsAt)}`
                    : `Since ${formatDate(summary.window.startedAt)}`}
                </p>
                <p className="mt-0.5">
                  {summary.quota.expiresAt
                    ? `Key expires ${formatDate(summary.quota.expiresAt)}`
                    : "Key never expires"}
                </p>
                {refreshedAt && (
                  <p className="mt-0.5 flex items-center gap-1 sm:justify-end" aria-live="polite">
                    {backgroundRefreshing && (
                      <span className="material-symbols-outlined animate-spin text-[12px]" aria-hidden="true">progress_activity</span>
                    )}
                    Auto-refresh every 30s · Updated {formatDate(refreshedAt)}
                  </p>
                )}
              </div>
            </div>

            {summary.modelAccess?.restricted && (
              <Card padding="sm" className="mb-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-[19px] text-brand-500" aria-hidden="true">route</span>
                      <h2 className="text-sm font-semibold text-text-main">Available models</h2>
                    </div>
                    {summary.modelAccess.publicModel ? (
                      <p className="mt-1.5 text-xs leading-5 text-text-muted">
                        Use <code className="rounded bg-surface-2 px-1.5 py-0.5 text-text-main">{summary.modelAccess.publicModel}</code> for the selected target,
                        or call any allowed model below by its own name.
                      </p>
                    ) : (
                      <p className="mt-1.5 text-xs leading-5 text-text-muted">
                        This key can call the models below directly. No fixed public model name is configured.
                      </p>
                    )}
                  </div>
                  {summary.modelAccess.publicModel && summary.modelAccess.allowedModels.length > 0 && (
                    <div className="w-full shrink-0 sm:w-80">
                      <label htmlFor="selected-key-model" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                        Target for {summary.modelAccess.publicModel}
                      </label>
                      <div className="relative">
                        <select
                          id="selected-key-model"
                          value={summary.modelAccess.selectedModel || ""}
                          onChange={(event) => void selectModel(event.target.value)}
                          disabled={modelSaving}
                          className="h-10 w-full appearance-none rounded-[10px] border border-border bg-surface-2 px-3 pr-9 font-mono text-xs text-text-main outline-none focus:border-brand-500/60 disabled:opacity-60"
                        >
                          {summary.modelAccess.allowedModels.map((model) => (
                            <option key={model} value={model}>{model}</option>
                          ))}
                        </select>
                        <span className={`material-symbols-outlined pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[17px] text-text-muted ${modelSaving ? "animate-spin" : ""}`} aria-hidden="true">
                          {modelSaving ? "progress_activity" : "expand_more"}
                        </span>
                      </div>
                      {modelMessage && <p className="mt-1.5 text-[11px] text-text-muted" aria-live="polite">{modelMessage}</p>}
                    </div>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {summary.modelAccess.allowedModels.map((model) => (
                    <code key={model} className="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] text-text-main">{model}</code>
                  ))}
                </div>
              </Card>
            )}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                icon="data_usage"
                label="Total tokens"
                value={compactNumber.format(summary.usage.totalTokens)}
                detail={`${compactNumber.format(summary.usage.inputTokens)} input · ${compactNumber.format(summary.usage.outputTokens)} output`}
              >
                <Progress value={summary.usage.inputTokens} limit={summary.quota.maxInputTokens} label="Input token quota" />
              </MetricCard>
              <MetricCard
                icon="payments"
                label="Current cost"
                value={usd.format(summary.usage.cost)}
                detail="Based on configured pricing"
              >
                <Progress value={summary.usage.cost} limit={summary.quota.maxCost} label="Cost quota" />
              </MetricCard>
              <MetricCard
                icon="send"
                label="Requests"
                value={exactNumber.format(summary.usage.requests)}
                detail={`${exactNumber.format(summary.usage.recordedRequests)} completed with usage`}
              >
                <Progress value={summary.usage.requests} limit={summary.quota.maxRequests} label="Request quota" />
              </MetricCard>
              <MetricCard
                icon="deployed_code"
                label="Models used"
                value={exactNumber.format(summary.usage.modelCount)}
                detail={summary.usage.modelCount === 1 ? "Model in this window" : "Models in this window"}
              >
                <div className="mt-4 flex items-center justify-between text-[11px] text-text-muted">
                  <span>Window started</span>
                  <span className="font-medium text-text-main">{formatDate(summary.window.startedAt, false)}</span>
                </div>
              </MetricCard>
            </div>

            <Card padding="none" className="mt-4 overflow-hidden">
              <div className="flex items-center justify-between border-b border-border-subtle px-4 py-4 sm:px-5">
                <div>
                  <h2 className="text-sm font-semibold text-text-main">Model activity</h2>
                  <p className="mt-0.5 text-xs text-text-muted">Usage recorded during the current window</p>
                </div>
                <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-text-muted">
                  {summary.models.length} {summary.models.length === 1 ? "model" : "models"}
                </span>
              </div>

              {summary.models.length === 0 ? (
                <div className="flex flex-col items-center px-5 py-14 text-center">
                  <span className="material-symbols-outlined text-[32px] text-text-subtle" aria-hidden="true">hourglass_empty</span>
                  <h3 className="mt-3 text-sm font-semibold text-text-main">No model usage yet</h3>
                  <p className="mt-1 max-w-sm text-xs leading-5 text-text-muted">
                    This key is active, but no completed model requests have been recorded in the current window.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left">
                    <thead className="bg-surface-2/70 text-[11px] uppercase tracking-wide text-text-muted">
                      <tr>
                        <th className="px-5 py-3 font-semibold">Model</th>
                        <th className="px-4 py-3 text-right font-semibold">Requests</th>
                        <th className="px-4 py-3 text-right font-semibold">Input</th>
                        <th className="px-4 py-3 text-right font-semibold">Output</th>
                        <th className="px-4 py-3 text-right font-semibold">Cost</th>
                        <th className="px-5 py-3 text-right font-semibold">Last used</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle">
                      {summary.models.map((item) => (
                        <tr key={`${item.provider}/${item.model}`} className="transition-colors hover:bg-surface-2/40">
                          <td className="px-5 py-3.5">
                            <p className="max-w-[270px] truncate font-mono text-xs font-medium text-text-main">{item.model}</p>
                            <p className="mt-0.5 text-[11px] text-text-muted">{item.provider}</p>
                          </td>
                          <td className="px-4 py-3.5 text-right text-xs tabular-nums text-text-main">{exactNumber.format(item.requests)}</td>
                          <td className="px-4 py-3.5 text-right text-xs tabular-nums text-text-main">{exactNumber.format(item.inputTokens)}</td>
                          <td className="px-4 py-3.5 text-right text-xs tabular-nums text-text-main">{exactNumber.format(item.outputTokens)}</td>
                          <td className="px-4 py-3.5 text-right text-xs tabular-nums text-text-main">{usd.format(item.cost)}</td>
                          <td className="px-5 py-3.5 text-right text-xs text-text-muted">{formatDate(item.lastUsedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <p className="mt-4 text-center text-[11px] leading-5 text-text-muted">
              Request count includes admitted calls. Token and model details appear after a provider returns usage data.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
