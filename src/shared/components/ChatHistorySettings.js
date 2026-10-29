"use client";

import { useEffect, useState } from 'react';
import { Card, Button, Toggle } from '@/shared/components';
import { HISTORY_DEFAULTS, HISTORY_LIMITS, historyConfig } from '@/lib/chatHistory/config.js';

export default function ChatHistorySettings() {
  const [form, setForm] = useState(HISTORY_DEFAULTS);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/settings', { cache: 'no-store', signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => { if (!controller.signal.aborted) { setForm(historyConfig(data)); setLoaded(true); } })
      .catch(() => { if (!controller.signal.aborted) { setError(true); setMessage('Could not load history settings.'); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  async function persist(values) {
    // Keep the small settings write alive when navigating immediately after a click.
    const r = await fetch('/api/settings', { method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not save history settings.');
    return data;
  }
  async function changeEnabled(enabled) {
    if (busy || !loaded) return;
    const previous = form.chatHistoryEnabled;
    setForm(current => ({ ...current, chatHistoryEnabled: enabled }));
    setBusy(true); setError(false); setMessage('Saving Chat History…');
    try {
      const data = await persist({ chatHistoryEnabled: enabled });
      if (data.chatHistoryEnabled !== enabled) throw new Error('Could not confirm the saved history setting.');
      setMessage(`Chat History ${enabled ? 'enabled' : 'disabled'}. Saved automatically.`);
    } catch (e) {
      setForm(current => ({ ...current, chatHistoryEnabled: previous }));
      setError(true); setMessage(e.message || 'Could not save history settings.');
    } finally { setBusy(false); }
  }
  async function save() {
    if (busy || !loaded) return;
    setBusy(true); setError(false); setMessage('Saving history settings…');
    try {
      const data = await persist(form);
      setForm(historyConfig(data));
      setMessage('History settings saved.');
    } catch (e) { setError(true); setMessage(e.message || 'Could not save history settings.'); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (!window.confirm('Delete all chat history? This cannot be undone. Active requests may still create new records.')) return;
    setBusy(true); setError(false); setMessage('');
    try {
      let more = true;
      while (more) {
        const r = await fetch('/api/chat-history?all=true', { method: 'DELETE' });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        more = data.more;
      }
      setMessage('Saved history deleted.');
    } catch (e) { setError(true); setMessage(e.message || 'Could not delete history.'); }
    finally { setBusy(false); }
  }
  return <Card data-testid="chat-history-settings" className="p-6 space-y-4">
    <h2 className="text-lg font-semibold">Chat History</h2>
    <p className="text-sm text-text-muted">Save conversation content on this server. Requires a signed-in administrator. Shared API keys identify a group, not individual people. Sensitive text is filtered on a best-effort basis.</p>
    {loading && <p role="status" className="text-sm text-text-muted">Loading history settings…</p>}
    <div className="flex items-center justify-between"><span>Enable Chat History</span><Toggle label="Collect conversation content" checked={form.chatHistoryEnabled} disabled={!loaded || busy} onChange={changeEnabled} /></div>
    <p className="text-xs text-text-muted">Turning capture on or off saves automatically. Use Save history settings for retention and content limits.</p>
    <div className="grid sm:grid-cols-3 gap-4">
      {[
        ['chatHistoryRetentionDays', 'Retention (days)', 1, 365],
        ['chatHistoryQueueCapacity', 'Queue capacity (records)', 1, HISTORY_LIMITS.queueRecords],
        ['chatHistoryMaxContentBytes', 'Maximum content (bytes)', 4096, 262144],
      ].map(([key, label, min, max]) => <label key={key} className="text-sm space-y-2">{label}<input disabled={!loaded || busy} type="number" min={min} max={max} value={form[key]} onChange={e => setForm({ ...form, [key]: Number(e.target.value) })} className="block w-full rounded-lg border border-border bg-surface p-2" /></label>)}
    </div>
    <p className="text-xs text-text-muted">Queue: at most 50 records / 16 MiB of UTF-8 payload, including in-flight batches. Each record: at most 512 KiB. One worker, batches of 10, flush every 2 seconds.</p>
    <div className="flex gap-3"><Button onClick={save} disabled={!loaded || busy}>Save history settings</Button><Button variant="secondary" onClick={clear} disabled={!loaded || busy}>Delete all history</Button></div>
    {!loading && !loaded && <Button variant="secondary" onClick={() => { setLoading(true); setError(false); setMessage(''); setReload(n => n + 1); }}>Retry loading settings</Button>}
    {message && <p role={error ? 'alert' : 'status'} className={`text-sm ${error ? 'text-red-500' : 'text-text-muted'}`}>{message}</p>}
  </Card>;
}
