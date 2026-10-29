"use client";

export default function ChatHistoryOwner({ apiKey, ownerId }) {
  const id = apiKey?.id || ownerId;
  const state = apiKey?.state || (id ? 'unavailable' : 'unidentified');
  const name = state === 'identified' ? apiKey.name || 'Unnamed API key'
    : state === 'deleted' ? 'Deleted API key'
      : state === 'unavailable' ? 'API key unavailable' : 'Unidentified';
  return <div className="space-y-1" data-testid="history-api-key">
    <span className="block max-w-xs break-words text-sm font-medium" title={name}>{name}</span>
    {id ? <span className="block text-xs text-text-muted" title={id}>ID: {id.slice(0, 8)}</span>
      : <span className="block text-xs text-text-muted">No API key was identified</span>}
  </div>;
}
