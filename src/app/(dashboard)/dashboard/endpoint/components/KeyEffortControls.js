"use client";

import { useState } from 'react';
import { Button, Modal } from '@/shared/components';
import { KEY_EFFORT_VALUES, KEY_EFFORT_DEFAULT } from '@/shared/utils/keyEffort.js';

export default function KeyEffortControls({ apiKey, onSave }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(KEY_EFFORT_DEFAULT);
  const [target, setTarget] = useState('');
  const [cap, setCap] = useState(null);
  const [override, setOverride] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const policy = apiKey.effortPolicy || KEY_EFFORT_DEFAULT;
  function edit() {
    setDraft({ allowUserChoice: policy.allowUserChoice, effort: policy.effort || (policy.allowUserChoice ? null : 'high'), overrides: [...(policy.overrides || [])] }); setError(''); setCap(null); setOpen(true);
  }
  async function check() {
    setBusy(true); setError(''); setCap(null);
    try {
      const r = await fetch(`/api/keys/${apiKey.id}/effort?model=${encodeURIComponent(target)}`);
      const data = await r.json(); if (!r.ok) throw new Error(data.error);
      setCap(data); setOverride(data.levels.includes(draft.effort) ? draft.effort : data.levels[0] || '');
    } catch (e) { setError(e.message || 'Could not check this model'); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError('');
    const result = await onSave(draft);
    setBusy(false);
    if (result.ok) setOpen(false); else setError(result.error || 'Could not save effort policy');
  }
  return <div className="mt-3" data-testid="key-effort">
    <Button size="sm" variant="secondary" onClick={edit}>Effort · {policy.allowUserChoice ? 'User access' : `Admin: ${policy.effort || 'Invalid policy'}`}</Button>
    <Modal isOpen={open} onClose={() => setOpen(false)} title={`Effort access — ${apiKey.name}`}>
      <div className="space-y-4">
        <p className="text-sm text-text-muted">Control effort for this API key. A signed-in administrator is required to save. Model access and provider-account access stay separate.</p>
        <div className="flex gap-2">
          <Button variant={draft.allowUserChoice ? 'primary' : 'secondary'} onClick={() => setDraft({ ...draft, allowUserChoice: true })}>Access · User chooses</Button>
          <Button variant={!draft.allowUserChoice ? 'primary' : 'secondary'} onClick={() => setDraft({ ...draft, allowUserChoice: false, effort: draft.effort || 'high' })}>No access · Admin chooses</Button>
        </div>
        <label className="block text-sm">{draft.allowUserChoice ? 'Default effort when the client does not choose' : 'Locked default effort'}
          <select aria-label="Default effort" className="mt-1 w-full rounded-lg border border-border bg-surface p-2" value={draft.effort || ''} onChange={e => setDraft({ ...draft, effort: e.target.value || null })}>
            {draft.allowUserChoice && <option value="">Inherit provider / model default</option>}
            {KEY_EFFORT_VALUES.map(v => <option key={v} value={v}>{v === 'thinking' ? 'Thinking on (binary models)' : v}</option>)}
          </select>
        </label>
        <p className="text-xs text-text-muted">Unsupported levels are rejected for that model. Combos may try another compatible member. Nothing is silently raised or lowered. Use model overrides when a key routes to models with different effort levels.</p>
        <div className="border-t border-border pt-3 space-y-2">
          <h3 className="font-medium text-sm">Model overrides</h3>
          {draft.overrides.map(row => <div key={row.model} className="flex items-center gap-2 text-xs"><code className="flex-1 break-all">{row.model}</code><span>{row.effort}</span><button type="button" onClick={() => setDraft({ ...draft, overrides: draft.overrides.filter(r => r.model !== row.model) })} className="text-red-500">Remove</button></div>)}
          <label className="block text-sm">Concrete model (provider/model)<input aria-label="Effort override model" value={target} maxLength={256} onChange={e => { setTarget(e.target.value); setCap(null); }} placeholder="cx/gpt-6.1-sol or kc/moonshotai/kimi-k3" className="mt-1 w-full rounded-lg border border-border bg-surface p-2" /></label>
          <Button variant="secondary" disabled={busy || !target} onClick={check}>Check supported levels</Button>
          {cap && <div className="space-y-2"><p className="text-xs text-text-muted">{cap.model} · {cap.kind}{cap.kind === 'budget' ? ' (gateway token-budget presets)' : ''}{cap.gateway ? ' · Gateway mapping' : ''}</p>
            {cap.levels.length ? <div className="flex gap-2"><select aria-label="Model override effort" value={override} onChange={e => setOverride(e.target.value)} className="rounded-lg border border-border bg-surface p-2 text-sm">{cap.levels.map(v => <option key={v} value={v}>{v}{cap.kind === 'budget' && cap.budgets[v] ? ` (${cap.budgets[v]} thinking tokens)` : ''}</option>)}</select><Button disabled={draft.overrides.length >= 50} onClick={() => { setDraft({ ...draft, overrides: [...draft.overrides.filter(r => r.model !== cap.model), { model: cap.model, effort: override }] }); setCap(null); setTarget(''); }}>Set override</Button></div> : <p className="text-xs text-orange-500">{cap.reason}. Admin locking is unavailable for this route.</p>}
          </div>}
        </div>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={busy || (!draft.allowUserChoice && !draft.effort)} onClick={save}>Save effort access</Button></div>
      </div>
    </Modal>
  </div>;
}
