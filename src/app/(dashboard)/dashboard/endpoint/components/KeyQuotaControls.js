"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Select } from "@/shared/components";

const EMPTY_QUOTA = {
  maxCost: null,
  maxInputTokens: null,
  maxRequests: null,
  resetMode: "manual",
  resetInterval: null,
  resetIntervalValue: null,
  resetIntervalUnit: null,
};
const EMPTY_USAGE = { cost: 0, inputTokens: 0, requests: 0, resetAt: null, nextResetAt: null };

const RESET_INTERVALS = [
  { value: "daily", label: "Every 24 hours" },
  { value: "weekly", label: "Every 7 days" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom interval" },
];

const RESET_UNITS = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
];

function compactNumber(value) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function cost(value) {
  const amount = Number(value) || 0;
  return amount < 0.01 && amount > 0 ? `$${amount.toFixed(6)}` : `$${amount.toFixed(2)}`;
}

function initialForm(quota) {
  return {
    maxCost: quota.maxCost ?? "",
    maxInputTokens: quota.maxInputTokens ?? "",
    maxRequests: quota.maxRequests ?? "",
    resetMode: quota.resetMode === "scheduled" ? "scheduled" : "manual",
    resetInterval: quota.resetMode === "scheduled" ? (quota.resetInterval || "monthly") : "monthly",
    resetIntervalValue: quota.resetIntervalValue ?? 30,
    resetIntervalUnit: quota.resetIntervalUnit || "minutes",
  };
}

function formatResetDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatTimeLeft(value, now) {
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) return null;
  const seconds = Math.max(0, Math.ceil((target - now) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function quotaValue(raw, integer = false) {
  if (raw === "" || raw === null || raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) return undefined;
  return value;
}

function resetScheduleLabel(quota) {
  if (quota.resetInterval === "custom") {
    const value = quota.resetIntervalValue;
    const unit = quota.resetIntervalUnit || "minutes";
    return `Every ${value} ${value === 1 ? unit.replace(/s$/, "") : unit}`;
  }
  return RESET_INTERVALS.find((item) => item.value === quota.resetInterval)?.label || quota.resetInterval;
}

function Meter({ label, used, limit, formatter }) {
  const bounded = limit !== null && Number(limit) > 0;
  const percent = bounded ? Math.min(100, (Number(used) / Number(limit)) * 100) : 0;
  const exhausted = bounded && Number(used) >= Number(limit);
  return (
    <div className={`rounded-lg border px-2.5 py-2 ${exhausted ? "border-red-500/40 bg-red-500/5" : "border-border bg-surface-2/50"}`}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-text-muted">{label}</span>
        <span className={exhausted ? "font-semibold text-red-500" : "text-text-main"}>
          {formatter(used)} / {bounded ? formatter(limit) : "Unlimited"}
        </span>
      </div>
      {bounded && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
          <div className={`h-full rounded-full ${exhausted ? "bg-red-500" : "bg-primary"}`} style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

Meter.propTypes = {
  label: PropTypes.string.isRequired,
  used: PropTypes.number.isRequired,
  limit: PropTypes.number,
  formatter: PropTypes.func.isRequired,
};

export default function KeyQuotaControls({ apiKey, onSave, onRequestReset }) {
  const quota = apiKey.quota || EMPTY_QUOTA;
  const usage = apiKey.usage || EMPTY_USAGE;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => initialForm(quota));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!usage.nextResetAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [usage.nextResetAt]);

  const save = async () => {
    const customIntervalValue = form.resetMode === "scheduled" && form.resetInterval === "custom"
      ? quotaValue(form.resetIntervalValue, true)
      : null;
    const next = {
      maxCost: quotaValue(form.maxCost),
      maxInputTokens: quotaValue(form.maxInputTokens, true),
      maxRequests: quotaValue(form.maxRequests, true),
      resetMode: form.resetMode,
      resetInterval: form.resetMode === "scheduled" ? form.resetInterval : null,
      resetIntervalValue: form.resetMode === "scheduled" && form.resetInterval === "custom"
        ? customIntervalValue
        : null,
      resetIntervalUnit: form.resetMode === "scheduled" && form.resetInterval === "custom"
        ? form.resetIntervalUnit
        : null,
    };
    if ([next.maxCost, next.maxInputTokens, next.maxRequests].some((value) => value === undefined)) {
      setError("Limits must be positive numbers. Tokens and requests must be whole numbers.");
      return;
    }
    if (customIntervalValue === undefined) {
      setError("Custom reset interval must be a positive whole number.");
      return;
    }
    if (next.resetIntervalValue !== null && next.resetIntervalValue > 100000) {
      setError("Custom reset interval must be between 1 and 100,000.");
      return;
    }
    setSaving(true);
    setError("");
    const result = await onSave(next);
    setSaving(false);
    if (result?.ok === false) {
      setError(result.error || "Failed to save limits");
      return;
    }
    setEditing(false);
  };

  const hasUsage = usage.requests > 0 || usage.inputTokens > 0 || usage.cost > 0;

  return (
    <div className="mt-3" data-testid="key-quota">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-text-main">Usage limits</span>
        <button
          type="button"
          onClick={() => {
            if (!editing) setForm(initialForm(quota));
            setEditing((value) => !value);
            setError("");
          }}
          className="text-xs font-medium text-primary hover:underline"
        >
          {editing ? "Close" : "Configure"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
        <Meter label="Requests" used={usage.requests} limit={quota.maxRequests} formatter={compactNumber} />
        <Meter label="Input tokens" used={usage.inputTokens} limit={quota.maxInputTokens} formatter={compactNumber} />
        <Meter label="Estimated cost" used={usage.cost} limit={quota.maxCost} formatter={cost} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
        <span className="font-medium text-text-main">
          {quota.resetMode === "scheduled"
            ? `Automatic reset · ${resetScheduleLabel(quota)}`
            : "One usage window · admin reset"}
        </span>
        {quota.resetMode === "scheduled" && usage.nextResetAt && (
          <span title={formatResetDate(usage.nextResetAt) || undefined}>
            Next reset {formatResetDate(usage.nextResetAt)} ({formatTimeLeft(usage.nextResetAt, now)})
          </span>
        )}
        {usage.resetAt && <span>Last reset {formatResetDate(usage.resetAt)}</span>}
      </div>

      {editing && (
        <div className="mt-2.5 rounded-lg border border-border bg-surface-2/40 p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input
              label="Max requests"
              type="number"
              min="1"
              step="1"
              value={form.maxRequests}
              onChange={(event) => setForm((current) => ({ ...current, maxRequests: event.target.value }))}
              placeholder="Unlimited"
            />
            <Input
              label="Max input tokens"
              type="number"
              min="1"
              step="1"
              value={form.maxInputTokens}
              onChange={(event) => setForm((current) => ({ ...current, maxInputTokens: event.target.value }))}
              placeholder="Unlimited"
            />
            <Input
              label="Max cost (USD)"
              type="number"
              min="0.000001"
              step="0.01"
              value={form.maxCost}
              onChange={(event) => setForm((current) => ({ ...current, maxCost: event.target.value }))}
              placeholder="Unlimited"
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
            Blank means unlimited. Request limits are exact. Token and cost limits stop the next request after recorded usage reaches the cap, so the final in-flight request can exceed it slightly.
          </p>
          <fieldset className="mt-3">
            <legend className="text-xs font-medium text-text-main">Usage reset</legend>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
              {[
                {
                  value: "manual",
                  title: "Wait for admin reset",
                  description: "Usage is cumulative until an admin clicks Reset usage.",
                },
                {
                  value: "scheduled",
                  title: "Automatic schedule",
                  description: "Start a fresh quota window on a recurring schedule.",
                },
              ].map((option) => (
                <label
                  key={option.value}
                  className={`cursor-pointer rounded-lg border p-2.5 transition-colors ${form.resetMode === option.value ? "border-primary bg-primary/5" : "border-border bg-surface"}`}
                >
                  <span className="flex items-center gap-2 text-xs font-medium text-text-main">
                    <input
                      type="radio"
                      name={`quota-reset-${apiKey.id}`}
                      value={option.value}
                      checked={form.resetMode === option.value}
                      onChange={() => setForm((current) => ({ ...current, resetMode: option.value }))}
                    />
                    {option.title}
                  </span>
                  <span className="mt-1 block pl-5 text-[11px] leading-relaxed text-text-muted">{option.description}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {form.resetMode === "scheduled" && (
            <div className="mt-3 max-w-xl">
              <Select
                className="max-w-xs"
                label="Reset frequency"
                value={form.resetInterval}
                options={RESET_INTERVALS}
                onChange={(event) => setForm((current) => ({ ...current, resetInterval: event.target.value }))}
              />
              {form.resetInterval === "custom" && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <Input
                    label="Repeat every"
                    type="number"
                    min="1"
                    max="100000"
                    step="1"
                    value={form.resetIntervalValue}
                    onChange={(event) => setForm((current) => ({ ...current, resetIntervalValue: event.target.value }))}
                  />
                  <Select
                    label="Unit"
                    value={form.resetIntervalUnit}
                    options={RESET_UNITS}
                    onChange={(event) => setForm((current) => ({ ...current, resetIntervalUnit: event.target.value }))}
                  />
                </div>
              )}
              <p className="mt-1.5 text-xs text-text-muted">
                The first window starts when you save this schedule.
              </p>
            </div>
          )}
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save limits"}</Button>
            {hasUsage && <Button size="sm" variant="ghost" onClick={onRequestReset}>Reset usage</Button>}
          </div>
        </div>
      )}
    </div>
  );
}

KeyQuotaControls.propTypes = {
  apiKey: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    quota: PropTypes.shape({
      maxCost: PropTypes.number,
      maxInputTokens: PropTypes.number,
      maxRequests: PropTypes.number,
      resetMode: PropTypes.oneOf(["manual", "scheduled"]),
      resetInterval: PropTypes.oneOf(["daily", "weekly", "monthly", "custom"]),
      resetIntervalValue: PropTypes.number,
      resetIntervalUnit: PropTypes.oneOf(["minutes", "hours", "days"]),
    }),
    usage: PropTypes.shape({
      cost: PropTypes.number,
      inputTokens: PropTypes.number,
      requests: PropTypes.number,
      resetAt: PropTypes.string,
      nextResetAt: PropTypes.string,
    }),
  }).isRequired,
  onSave: PropTypes.func.isRequired,
  onRequestReset: PropTypes.func.isRequired,
};
