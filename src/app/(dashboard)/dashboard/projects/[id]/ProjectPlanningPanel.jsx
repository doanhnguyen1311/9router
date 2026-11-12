"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card } from "@/shared/components";

const TERMINAL = new Set(["APPROVED", "REJECTED", "CANCELLED", "FAILED", "EXPIRED", "STALE", "COMPLETED"]);
const STATUS_TONES = {
  APPROVED: "bg-green-500/10 text-green-500",
  COMPLETED: "bg-green-500/10 text-green-500",
  PENDING_APPROVAL: "bg-amber-500/10 text-amber-500",
  NEEDS_CLARIFICATION: "bg-amber-500/10 text-amber-500",
  FAILED: "bg-red-500/10 text-red-500",
  REJECTED: "bg-red-500/10 text-red-500",
  EXPIRED: "bg-red-500/10 text-red-500",
};

const date = (value) => value ? new Date(value).toLocaleString() : "—";

export function PlanStatusBadge({ status }) {
  return <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONES[status] || "bg-brand-500/10 text-brand-500"}`}>{String(status || "unknown").replaceAll("_", " ")}</span>;
}

function TextList({ title, values, empty = "None recorded" }) {
  return <div><h4 className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{title}</h4>{values?.length ? <ul className="mt-2 space-y-1 text-xs leading-5 text-text-main">{values.map((value, index) => <li key={`${index}-${typeof value === "string" ? value : value.description}`} className="flex gap-2"><span aria-hidden="true" className="text-brand-500">•</span><span>{typeof value === "string" ? value : `${value.severity ? `${value.severity}: ` : ""}${value.description || JSON.stringify(value)}`}</span></li>)}</ul> : <p className="mt-2 text-xs text-text-muted">{empty}</p>}</div>;
}

export function PlanOptionCard({ option, selected, disabled, onSelect }) {
  return <article className={`rounded-2xl border p-4 ${selected ? "border-brand-500 bg-brand-500/5" : "border-border bg-surface"}`}>
    <div className="flex flex-wrap items-start justify-between gap-2"><div><div className="flex items-center gap-2"><h3 className="font-semibold text-text-main">{option.name}</h3>{option.recommended && <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-green-500">Recommended</span>}</div><p className="mt-1 text-xs leading-5 text-text-muted">{option.summary}</p></div><Button type="button" size="xs" variant={selected ? "primary" : "secondary"} disabled={disabled || selected} onClick={() => onSelect(option.id)}>{selected ? "Selected" : "Select"}</Button></div>
    <div className="mt-4 grid gap-4 border-t border-border-subtle pt-4 md:grid-cols-2"><TextList title="Implementation" values={option.implementationSteps} /><TextList title="Acceptance" values={option.acceptanceCriteria} /><TextList title="Pros" values={option.pros} /><TextList title="Risks / cons" values={[...(option.cons || []), ...(option.risks || [])]} /></div>
    <dl className="mt-4 grid gap-3 rounded-xl bg-surface-2 p-3 text-xs sm:grid-cols-3"><div><dt className="text-text-muted">Complexity</dt><dd className="mt-1 capitalize text-text-main">{option.complexity}</dd></div><div><dt className="text-text-muted">Files</dt><dd className="mt-1 text-text-main">{option.filesAffected?.length || 0}</dd></div><div><dt className="text-text-muted">Test steps</dt><dd className="mt-1 text-text-main">{option.testStrategy?.length || 0}</dd></div></dl>
  </article>;
}

function newNonce() {
  if (globalThis.crypto?.randomUUID) return `${globalThis.crypto.randomUUID()}-${globalThis.crypto.randomUUID()}`;
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export default function ProjectPlanningPanel({ projectId, canEdit }) {
  const [plans, setPlans] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState({ originalRequest: "", providerId: "", modelId: "", contextTokenBudget: 1800, expirationMinutes: 10080 });

  const base = `/api/v1/projects/${projectId}/plans`;
  const selectedOption = useMemo(() => plan?.options?.find((option) => option.id === plan.selectedOptionId) || null, [plan]);

  const readJson = async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const requestError = new Error(body.error || `Request failed (${response.status})`);
      requestError.status = response.status;
      requestError.code = body.code;
      throw requestError;
    }
    return body;
  };

  const loadPlans = useCallback(async () => {
    const body = await readJson(await fetch(`${base}?limit=100`, { cache: "no-store" }));
    setPlans(body.plans || []);
    setSelectedId((current) => current || body.plans?.[0]?.id || null);
  }, [base]);

  const loadPlan = useCallback(async (planId) => {
    if (!planId) { setPlan(null); return; }
    setDetailLoading(true);
    try { setPlan((await readJson(await fetch(`${base}/${planId}`, { cache: "no-store" }))).plan); }
    finally { setDetailLoading(false); }
  }, [base]);

  useEffect(() => {
    let active = true;
    (async () => {
      try { await loadPlans(); }
      catch (loadError) { if (active) setError(loadError.message); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [loadPlans]);

  useEffect(() => { if (selectedId) void loadPlan(selectedId).catch((loadError) => setError(loadError.message)); }, [selectedId, loadPlan]);

  async function mutate(action, path, body) {
    setBusy(action); setError("");
    try {
      const responseBody = await readJson(await fetch(`${base}/${plan.id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
      if (responseBody.plan) setPlan(responseBody.plan);
      await loadPlans();
      await loadPlan(plan.id);
      return responseBody.plan;
    } catch (mutationError) {
      setError(mutationError.status === 409 ? `${mutationError.message} Refreshing the latest revision.` : mutationError.message);
      if (mutationError.status === 409) await loadPlan(plan.id).catch(() => {});
      return null;
    } finally { setBusy(""); }
  }

  async function createPlan(event) {
    event.preventDefault(); setBusy("create"); setError("");
    try {
      const body = await readJson(await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, contextTokenBudget: Number(draft.contextTokenBudget), expirationMinutes: Number(draft.expirationMinutes) }),
      }));
      setShowCreate(false); setPlan(body.plan); setSelectedId(body.plan.id);
      setDraft({ originalRequest: "", providerId: "", modelId: "", contextTokenBudget: 1800, expirationMinutes: 10080 });
      await loadPlans();
    } catch (createError) { setError(createError.message); }
    finally { setBusy(""); }
  }

  async function decide(decision) {
    if (!selectedOption) return;
    const reason = decision === "reject" ? window.prompt("Reason for rejection (optional)", "") : "";
    if (decision === "reject" && reason === null) return;
    if (!window.confirm(`${decision === "approve" ? "Approve" : "Reject"} revision ${plan.currentRevision} and option “${selectedOption.name}”?`)) return;
    await mutate(decision, decision, {
      expectedVersion: plan.version,
      optionId: selectedOption.id,
      scope: "EXECUTE_APPROVED_PLAN",
      idempotencyKey: newNonce(),
      reason,
    });
  }

  if (loading) return <Card><p className="flex items-center gap-2 text-sm text-text-muted"><span className="material-symbols-outlined animate-spin">progress_activity</span>Loading planning workspace…</p></Card>;

  return <div className="space-y-4">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold text-text-main">Planning workspace</h2><p className="mt-1 text-xs text-text-muted">Planning → explicit approval. Approved plans remain inert until the Phase 3 execution worker is enabled.</p></div>{canEdit && <Button icon="add" onClick={() => setShowCreate((value) => !value)}>New plan</Button>}</div>
    {error && <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-red-500/25 bg-red-500/5 p-3 text-sm text-red-500"><span>{error}</span><button type="button" className="underline" onClick={() => { setError(""); void loadPlans(); if (selectedId) void loadPlan(selectedId); }}>Retry</button></div>}
    {showCreate && canEdit && <Card title="Create planning task" subtitle="The selected provider receives only bounded, redacted Project context" icon="edit_note"><form onSubmit={createPlan} className="space-y-3"><label className="block text-xs font-semibold text-text-main">Request<textarea required rows={5} value={draft.originalRequest} onChange={(event) => setDraft((current) => ({ ...current, originalRequest: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-border bg-surface-2 p-3 text-sm outline-none focus:border-brand-500/60" placeholder="Describe the outcome, constraints, and acceptance criteria." /></label><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-text-main">Provider ID<input required value={draft.providerId} onChange={(event) => setDraft((current) => ({ ...current, providerId: event.target.value }))} className="mt-1.5 h-10 w-full rounded-lg border border-border bg-surface-2 px-3" placeholder="Configured provider" /></label><label className="text-xs font-semibold text-text-main">Model ID<input required value={draft.modelId} onChange={(event) => setDraft((current) => ({ ...current, modelId: event.target.value }))} className="mt-1.5 h-10 w-full rounded-lg border border-border bg-surface-2 px-3" placeholder="Configured model" /></label><label className="text-xs font-semibold text-text-main">Context token budget<input type="number" min="256" max="16000" required value={draft.contextTokenBudget} onChange={(event) => setDraft((current) => ({ ...current, contextTokenBudget: event.target.value }))} className="mt-1.5 h-10 w-full rounded-lg border border-border bg-surface-2 px-3" /></label><label className="text-xs font-semibold text-text-main">Expires after (minutes)<input type="number" min="5" max="43200" required value={draft.expirationMinutes} onChange={(event) => setDraft((current) => ({ ...current, expirationMinutes: event.target.value }))} className="mt-1.5 h-10 w-full rounded-lg border border-border bg-surface-2 px-3" /></label></div><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button><Button type="submit" loading={busy === "create"}>Generate options</Button></div></form></Card>}

    <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <Card title="Plans" subtitle={`${plans.length} planning task${plans.length === 1 ? "" : "s"}`} icon="list_alt" padding="none"><div className="max-h-[70vh] overflow-y-auto">{!plans.length ? <div className="p-8 text-center text-sm text-text-muted"><span className="material-symbols-outlined text-[34px]">edit_note</span><p className="mt-2">No plans yet.</p>{!canEdit && <p className="mt-1 text-xs">Viewer access is read-only.</p>}</div> : plans.map((item) => <button type="button" key={item.id} onClick={() => setSelectedId(item.id)} className={`w-full border-b border-border-subtle p-4 text-left last:border-0 ${selectedId === item.id ? "bg-brand-500/5" : "hover:bg-surface-2/50"}`}><div className="flex items-start justify-between gap-2"><p className="line-clamp-2 text-sm font-medium text-text-main">{item.interpretedObjective || item.originalRequest}</p><PlanStatusBadge status={item.status} /></div><p className="mt-2 text-[10px] text-text-muted">Revision {item.currentRevision} · v{item.version} · {date(item.updatedAt)}</p></button>)}</div></Card>

      <div className="min-w-0 space-y-4">{detailLoading ? <Card><p className="text-sm text-text-muted">Loading plan details…</p></Card> : !plan ? <Card className="p-12 text-center"><p className="text-sm text-text-muted">Select a plan to inspect its objective, options, and approval history.</p></Card> : <>
        <Card><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><PlanStatusBadge status={plan.status} /><span className="text-[10px] text-text-muted">Revision {plan.currentRevision} · version {plan.version}</span></div><h2 className="mt-3 text-xl font-semibold text-text-main">{plan.interpretedObjective || "Intent is being interpreted"}</h2><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-muted">{plan.originalRequest}</p></div><div className="text-right text-[10px] text-text-muted"><p>{plan.providerId} / {plan.modelId}</p><p className="mt-1">Expires {date(plan.expiresAt)}</p></div></div><div className="mt-5 grid gap-4 border-t border-border pt-4 md:grid-cols-2"><TextList title="Assumptions" values={plan.assumptions} /><TextList title="Missing information" values={plan.missingInformation} /><TextList title="Constraints" values={plan.constraints} /><TextList title="Affected modules" values={plan.affectedModules} /><TextList title="Risks" values={plan.risks} /></div></Card>

        {plan.status === "APPROVED" && <div role="status" className="rounded-xl border border-green-500/25 bg-green-500/5 p-4 text-sm text-green-600"><p className="font-semibold">Approved and locked</p><p className="mt-1 text-xs">No execution has started. Phase 3 will issue a scoped execution ticket after workspace validation.</p></div>}
        {plan.status === "EXPIRED" && <div role="status" className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-sm text-amber-600">This plan expired. Create or revise a current plan before approval.</div>}

        <section aria-labelledby="plan-options-heading" className="space-y-3"><div className="flex items-center justify-between"><h2 id="plan-options-heading" className="font-semibold text-text-main">Options</h2><span className="text-xs text-text-muted">{plan.options?.length || 0} available</span></div>{!plan.options?.length ? <Card><p className="text-sm text-text-muted">No options are available. Answer the missing questions through a revision.</p></Card> : plan.options.map((option) => <PlanOptionCard key={option.id} option={option} selected={option.id === plan.selectedOptionId} disabled={!canEdit || busy !== "" || TERMINAL.has(plan.status)} onSelect={(optionId) => void mutate("select", "select-option", { optionId, expectedVersion: plan.version })} />)}</section>

        {canEdit && !TERMINAL.has(plan.status) && <Card title="Review actions" subtitle="Every mutation checks the exact plan version" icon="fact_check"><div className="space-y-3"><label className="block text-xs font-semibold text-text-main">Feedback or clarification<textarea rows={3} value={feedback} onChange={(event) => setFeedback(event.target.value)} className="mt-1.5 w-full rounded-xl border border-border bg-surface-2 p-3 text-sm outline-none focus:border-brand-500/60" placeholder="Explain what should change in the next revision." /></label><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" disabled={!feedback.trim() || Boolean(busy)} loading={busy === "feedback"} onClick={async () => { const updated = await mutate("feedback", "feedback", { expectedVersion: plan.version, feedback }); if (updated) setFeedback(""); }}>Save feedback</Button><Button size="sm" variant="secondary" disabled={!feedback.trim() || Boolean(busy)} loading={busy === "revision"} onClick={async () => { const updated = await mutate("revision", "revisions", { expectedVersion: plan.version, feedback }); if (updated) setFeedback(""); }}>Generate revision</Button>{plan.status === "OPTIONS_READY" && <Button size="sm" disabled={!plan.selectedOptionId || Boolean(busy)} loading={busy === "request"} onClick={() => void mutate("request", "request-approval", { expectedVersion: plan.version })}>Request approval</Button>}{plan.status === "PENDING_APPROVAL" && <><Button size="sm" disabled={Boolean(busy)} loading={busy === "approve"} onClick={() => void decide("approve")}>Approve selected option</Button><Button size="sm" variant="danger" disabled={Boolean(busy)} loading={busy === "reject"} onClick={() => void decide("reject")}>Reject</Button></>}<Button size="sm" variant="danger" disabled={Boolean(busy)} loading={busy === "cancel"} onClick={() => { if (window.confirm("Cancel this plan?")) void mutate("cancel", "cancel", { expectedVersion: plan.version, reason: "Cancelled from dashboard" }); }}>Cancel</Button></div></div></Card>}

        <div className="grid gap-4 lg:grid-cols-2"><Card title="Revision history" icon="history">{!plan.revisions?.length ? <p className="text-sm text-text-muted">No generated revision yet.</p> : <ol className="space-y-3">{plan.revisions.map((revision) => <li key={revision.id} className="rounded-xl bg-surface-2 p-3 text-xs"><div className="flex justify-between gap-2"><span className="font-semibold text-text-main">Revision {revision.revision}</span><span className="text-text-muted">{date(revision.createdAt)}</span></div>{revision.feedback && <p className="mt-2 text-text-muted">Feedback: {revision.feedback}</p>}<p className="mt-1 text-text-muted">{revision.content?.options?.length || 0} options · {revision.usage?.totalTokens || 0} tokens</p></li>)}</ol>}</Card><Card title="Approval & audit" icon="verified_user">{plan.approval ? <dl className="grid gap-2 text-xs"><div className="flex justify-between"><dt className="text-text-muted">Decision</dt><dd><PlanStatusBadge status={plan.approval.decision} /></dd></div><div className="flex justify-between"><dt className="text-text-muted">Actor</dt><dd className="text-text-main">{plan.approval.actorId}</dd></div><div className="flex justify-between"><dt className="text-text-muted">Revision</dt><dd className="text-text-main">{plan.approval.revision}</dd></div><div className="flex justify-between"><dt className="text-text-muted">Scope</dt><dd className="font-mono text-[10px] text-text-main">{plan.approval.scope}</dd></div></dl> : <p className="text-sm text-text-muted">No approval decision recorded.</p>}<div className="mt-4 max-h-48 space-y-2 overflow-y-auto border-t border-border pt-3">{plan.auditLog?.map((entry) => <div key={entry.id} className="flex justify-between gap-3 text-[10px]"><span className="text-text-main">{entry.eventType.replaceAll("_", " ")}</span><span className="whitespace-nowrap text-text-muted">v{entry.planVersion} · {date(entry.createdAt)}</span></div>)}</div></Card></div>
      </>}</div>
    </div>
  </div>;
}
