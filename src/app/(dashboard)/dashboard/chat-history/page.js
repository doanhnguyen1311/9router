"use client";

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Card, Button } from '@/shared/components';
import ChatHistoryDetail from '@/shared/components/ChatHistoryDetail';
import ChatHistoryOwner from '@/shared/components/ChatHistoryOwner';

export default function ChatHistoryPage() {
  const [filters, setFilters] = useState({ q: '', model: '', provider: '', status: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const detailRequest = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => () => detailRequest.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setError('');
      try {
        const p = new URLSearchParams({ offset: String(offset), limit: '20' });
        for (const [k, v] of Object.entries(filters)) if (v) p.set(k, k === 'from' || k === 'to' ? new Date(v).toISOString() : v);
        const r = await fetch('/api/chat-history?' + p, { signal: controller.signal });
        const result = await r.json();
        if (!r.ok) throw new Error(result.error);
        setData(result);
      } catch (e) { if (!controller.signal.aborted) setError(e.message || 'Could not load history.'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [filters, offset, refresh]);
  async function open(id) {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setSelectedId(id); setDetailError(''); setDetail(null); setDetailLoading(true);
    try {
      const r = await fetch('/api/chat-history?id=' + encodeURIComponent(id), { signal: controller.signal });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error);
      if (!controller.signal.aborted) setDetail(result);
    } catch (e) { if (!controller.signal.aborted) setDetailError(e.message || 'Could not load conversation.'); }
    finally { if (!controller.signal.aborted) setDetailLoading(false); }
  }
  function closeDetail() {
    detailRequest.current?.abort();
    setSelectedId(null); setDetail(null); setDetailError(''); setDetailLoading(false);
  }
  async function remove(id) {
    if (!window.confirm('Delete this history record?')) return;
    setDeleting(true); setDetailError('');
    try {
      const r = await fetch('/api/chat-history?id=' + encodeURIComponent(id), { method: 'DELETE' });
      if (!r.ok) throw new Error('Could not delete history.');
      closeDetail(); setRefresh(n => n + 1);
    } catch (e) { setDetailError(e.message); }
    finally { setDeleting(false); }
  }
  const change = (key, value) => { setFilters(f => ({ ...f, [key]: value })); setOffset(0); };
  return <div className="space-y-6">
    <div className="flex justify-between gap-4"><div><h1 className="text-2xl font-semibold">Chat History</h1><p className="text-sm text-text-muted mt-1">Requests, messages, tools and errors. Each request is stored independently.</p></div><Link className="text-sm text-primary" href="/dashboard/profile">History settings</Link></div>
    <Card className="p-4 grid sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {['q', 'model', 'provider'].map(key => <label key={key} className="text-xs text-text-muted">{key === 'q' ? 'Search content' : key}<input aria-label={key === 'q' ? 'Search content' : key} value={filters[key]} onChange={e => change(key, e.target.value)} className="mt-1 w-full p-2 rounded-lg border border-border bg-surface text-text-main" /></label>)}
      <label className="text-xs text-text-muted">Status<select value={filters.status} onChange={e => change('status', e.target.value)} className="mt-1 w-full p-2 rounded-lg border border-border bg-surface text-text-main"><option value="">All</option>{['success', 'failed', 'aborted', 'interrupted', 'timeout'].map(s => <option key={s}>{s}</option>)}</select></label>
      {['from', 'to'].map(key => <label key={key} className="text-xs text-text-muted">{key}<input type="datetime-local" value={filters[key]} onChange={e => change(key, e.target.value)} className="mt-1 w-full p-2 rounded-lg border border-border bg-surface text-text-main" /></label>)}
    </Card>
    {error && <div role="alert" className="text-red-500 flex items-center gap-3">{error}<Button variant="secondary" onClick={() => setRefresh(n => n + 1)}>Retry</Button></div>}
    {loading && <p role="status" className="text-text-muted">Loading history…</p>}
    {!loading && !error && data?.items.length === 0 && <Card className="p-10 text-center text-text-muted">No history found. Enable Chat History in Settings and complete an AI request.</Card>}
    {data?.items.length > 0 && <Card className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left border-b border-border">{['Request', 'API key', 'Model / Provider', 'Status', 'Tokens in / out', 'Time', 'Detail'].map(h => <th className="p-3" key={h}>{h}</th>)}</tr></thead><tbody>{data.items.map(row => <tr key={row.id} className="border-b border-border"><td className="p-3"><button onClick={() => open(row.id)} className="text-primary text-left break-words max-w-xs">{row.title || row.id}</button></td><td className="p-3"><ChatHistoryOwner apiKey={row.apiKey} ownerId={row.ownerId} /></td><td className="p-3">{row.model}<div className="text-xs text-text-muted">{row.provider || 'Unresolved'}</div></td><td className="p-3">{row.status}{row.httpStatus >= 400 ? ` (${row.httpStatus})` : ''}</td><td className="p-3">{row.inputTokens ?? '—'} / {row.outputTokens ?? '—'}</td><td className="p-3 whitespace-nowrap">{new Date(row.createdAt).toLocaleString()}</td><td className="p-3"><Button size="sm" variant="secondary" onClick={() => open(row.id)}>View detail</Button></td></tr>)}</tbody></table></Card>}
    <div className="flex items-center gap-3"><Button variant="secondary" disabled={!offset || loading} onClick={() => setOffset(n => Math.max(0, n - 20))}>Previous</Button><span className="text-sm">Page {offset / 20 + 1}</span><Button variant="secondary" disabled={!data?.hasMore || loading} onClick={() => setOffset(n => n + 20)}>Next</Button><Button variant="secondary" onClick={() => setRefresh(n => n + 1)}>Refresh</Button></div>
    {data?.metrics && <p className="text-xs text-text-muted">Queue {data.metrics.queueDepth} / {data.metrics.queueCapacity} · {data.metrics.queueBytes} / {data.metrics.queueMaxBytes} bytes · Saved {data.metrics.saved} · Dropped {data.metrics.dropped + data.metrics.activeDropped} · Worker {data.metrics.ready ? 'ready' : 'unavailable'}</p>}
    <ChatHistoryDetail isOpen={!!selectedId} detail={detail} loading={detailLoading} error={detailError} deleting={deleting} onClose={closeDetail} onDelete={() => remove(detail.id)} onRetry={() => open(selectedId)} />
  </div>;
}
