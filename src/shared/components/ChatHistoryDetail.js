"use client";

import { useMemo, useState } from 'react';
import Button from './Button';
import Modal from './Modal';
import ChatHistoryOwner from './ChatHistoryOwner';
import { historyMessages, formatHistoryValue } from '@/shared/utils/chatHistoryMessages.js';

function JsonDetails({ label, value }) {
  const [open, setOpen] = useState(false);
  if (value == null) return null;
  return <details onToggle={e => setOpen(e.currentTarget.open)} className="rounded-lg border border-border p-3">
    <summary className="cursor-pointer text-sm font-medium">{label}</summary>
    {open && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{formatHistoryValue(value)}</pre>}
  </details>;
}

const ROLES = { user: 'User', assistant: 'Assistant', system: 'System', developer: 'Developer', tool: 'Tool result' };
function Message({ message }) {
  return <article className={`rounded-lg border p-4 space-y-3 ${message.role === 'user' ? 'border-brand-500/25 bg-brand-500/5' : 'border-border bg-surface'}`}>
    <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-text-muted"><span>{ROLES[message.role] || 'Message'}</span>{message.name && <code>{message.name}</code>}{message.id && <code className="break-all font-normal">{message.id}</code>}</div>
    {message.parts.map((part, i) => {
      if (part.kind === 'reasoning') return <JsonDetails key={i} label="Reasoning / thinking" value={part.text} />;
      if (part.kind === 'tool_call' || part.kind === 'tool_result') return <div key={i} className="rounded-lg border border-border bg-bg p-3 space-y-2">
        <p className="text-sm font-medium">{part.kind === 'tool_call' ? 'Tool call' : 'Tool result'} · <code>{part.name}</code></p>
        {part.id && <p className="break-all text-xs text-text-muted">{part.id}</p>}
        {part.value != null && <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{formatHistoryValue(part.value)}</pre>}
      </div>;
      if (part.kind === 'attachment') return <p key={i} className="text-sm text-text-muted">{part.text}</p>;
      if (part.kind === 'json') return <JsonDetails key={i} label="Captured payload" value={part.value} />;
      return <div key={i} className="whitespace-pre-wrap break-words text-sm leading-relaxed max-h-[32rem] overflow-auto">{part.text}</div>;
    })}
  </article>;
}

export default function ChatHistoryDetail({ isOpen, detail, loading, error, deleting, onClose, onDelete, onRetry }) {
  const messages = useMemo(() => detail ? historyMessages(detail) : { request: [], response: [] }, [detail]);
  const latestUser = messages.request.findLastIndex(message => message.role === 'user');
  const context = latestUser >= 0 ? messages.request.slice(0, latestUser) : messages.request;
  const sent = latestUser >= 0 ? messages.request.slice(latestUser) : [];
  return <Modal isOpen={isOpen} onClose={() => { if (!deleting) onClose(); }} title="Conversation detail" size="full" footer={<>
    {detail && <Button variant="secondary" disabled={deleting} onClick={onDelete}>Delete record</Button>}
    <Button variant="secondary" disabled={deleting} onClick={onClose}>Close</Button>
  </>}>
    <div className="space-y-6">
      {loading && <p role="status" className="text-text-muted">Loading conversation…</p>}
      {error && <div role="alert" className="space-y-2 text-red-500"><p>{error}</p><Button variant="secondary" onClick={onRetry}>Retry detail</Button></div>}
      {detail && <>
        <div role="group" aria-label="Request API key" className="space-y-1"><h3 className="text-xs text-text-muted">API key</h3><ChatHistoryOwner apiKey={detail.apiKey} ownerId={detail.ownerId} /></div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted"><span>{detail.model || detail.requestedModel}</span><span>{detail.provider || 'Unresolved provider'}</span><span>{detail.status}{detail.httpStatus ? ` · HTTP ${detail.httpStatus}` : ''}</span><span>{Math.round(detail.durationMs || 0)} ms</span><span>Tokens {detail.inputTokens ?? '—'} in / {detail.outputTokens ?? '—'} out</span></div>
        {detail.truncated && <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">Only part of this request was captured because of content limits. Earlier records cannot recover content that was not saved.</p>}
        <section className="space-y-3" aria-label="Sent to AI">
          <h3 className="font-semibold">Sent to AI</h3>
          {sent.length ? sent.map((message, i) => <Message key={i} message={message} />) : <p className="text-sm text-text-muted">No user message was captured for this request.</p>}
          {context.length > 0 && <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm text-text-muted">Context and instructions sent with this request ({context.length} messages)</summary><div className="mt-3 space-y-3">{context.map((message, i) => <Message key={i} message={message} />)}</div></details>}
        </section>
        <section className="space-y-3" aria-label="AI response">
          <h3 className="font-semibold">AI response</h3>
          {messages.response.length ? messages.response.map((message, i) => <Message key={i} message={message} />) : <p className="text-sm text-text-muted">No assistant response was captured{detail.status === 'failed' ? '; see the request error below' : ''}.</p>}
        </section>
        {detail.error && <div role="alert" className="rounded-lg border border-red-500/30 p-3 space-y-2"><h3 className="font-medium text-red-500">Request error</h3><p className="whitespace-pre-wrap break-words text-sm">{detail.error.message || 'Request failed'}</p><p className="text-xs text-text-muted">{[detail.error.category, detail.error.code, detail.error.httpStatus && `HTTP ${detail.error.httpStatus}`].filter(Boolean).join(' · ')}</p></div>}
        <div className="space-y-2 border-t border-border pt-4">
          <JsonDetails label="Tool definitions" value={detail.request?.tools} />
          <JsonDetails label="Routing attempts" value={detail.attempts} />
          <JsonDetails label="Raw captured request" value={detail.request} />
          <JsonDetails label="Raw captured response" value={detail.response} />
          <p className="break-all text-xs text-text-muted">Request {detail.id} · {detail.createdAt ? new Date(detail.createdAt).toLocaleString() : ''}</p>
        </div>
      </>}
    </div>
  </Modal>;
}
