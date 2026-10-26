"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Input } from "@/shared/components";

const EMPTY_QUOTA = { maxCost: null, maxInputTokens: null, maxRequests: null };
const EMPTY_USAGE = { cost: 0, inputTokens: 0, requests: 0, resetAt: null };

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
  };
}

function quotaValue(raw, integer = false) {
  if (raw === "" || raw === null || raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) return undefined;
  return value;
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

  const save = async () => {
    const next = {
      maxCost: quotaValue(form.maxCost),
      maxInputTokens: quotaValue(form.maxInputTokens, true),
      maxRequests: quotaValue(form.maxRequests, true),
    };
    if (Object.values(next).some((value) => value === undefined)) {
      setError("Limits must be positive numbers. Tokens and requests must be whole numbers.");
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
    }),
    usage: PropTypes.shape({
      cost: PropTypes.number,
      inputTokens: PropTypes.number,
      requests: PropTypes.number,
      resetAt: PropTypes.string,
    }),
  }).isRequired,
  onSave: PropTypes.func.isRequired,
  onRequestReset: PropTypes.func.isRequired,
};
