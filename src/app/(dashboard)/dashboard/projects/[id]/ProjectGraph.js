"use client";

import { useMemo, useState } from "react";
import { Background, Controls, MiniMap, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Card } from "@/shared/components";

const COLORS = {
  file: "#f97316", class: "#8b5cf6", function: "#0ea5e9", interface: "#14b8a6",
  concept: "#64748b", decision: "#eab308", type: "#ec4899", table: "#22c55e",
};

export default function ProjectGraph({ graph, loading, onSearch }) {
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const types = useMemo(() => [...new Set((graph?.nodes || []).map((node) => node.entityType))].sort(), [graph]);
  const visibleIds = useMemo(() => new Set((graph?.nodes || []).filter((node) => !type || node.entityType === type).map((node) => node.id)), [graph, type]);
  const nodes = useMemo(() => (graph?.nodes || []).filter((node) => visibleIds.has(node.id)).map((node, index) => ({
    id: node.id,
    data: { label: node.name, entity: node },
    position: { x: (index % 5) * 210, y: Math.floor(index / 5) * 130 },
    style: { background: "var(--color-surface, #171717)", color: "var(--color-text-main, #fafafa)", border: `1px solid ${COLORS[node.entityType] || COLORS.concept}`, borderRadius: 12, width: 180, fontSize: 12, padding: 10 },
  })), [graph, visibleIds]);
  const edges = useMemo(() => (graph?.edges || []).filter((edge) => visibleIds.has(edge.fromEntityId) && visibleIds.has(edge.toEntityId)).map((edge) => ({ id: edge.id, source: edge.fromEntityId, target: edge.toEntityId, label: edge.relationType, animated: false, style: { stroke: "#64748b" }, labelStyle: { fontSize: 9, fill: "#94a3b8" } })), [graph, visibleIds]);

  function search(event) { event.preventDefault(); onSearch({ q: query, depth: 2 }); }
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
    <Card padding="none" className="overflow-hidden">
      <form onSubmit={search} className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row">
        <div className="relative flex-1"><span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[17px] text-text-muted">search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search nodes, files, symbols" className="h-9 w-full rounded-lg border border-border bg-surface-2 pl-9 pr-3 text-xs outline-none focus:border-brand-500/60" /></div>
        <select value={type} onChange={(event) => setType(event.target.value)} className="h-9 rounded-lg border border-border bg-surface-2 px-3 text-xs"><option value="">All entity types</option>{types.map((item) => <option key={item}>{item}</option>)}</select>
        <button className="h-9 rounded-lg bg-brand-500 px-4 text-xs font-semibold text-white">Explore</button>
      </form>
      <div className="h-[560px] bg-bg/60">{loading ? <div className="flex h-full items-center justify-center text-sm text-text-muted">Loading graph…</div> : nodes.length === 0 ? <div className="flex h-full flex-col items-center justify-center text-center text-text-muted"><span className="material-symbols-outlined text-[36px]">hub</span><p className="mt-2 text-sm">No matching entities yet. Upload source files or add memories.</p></div> : <ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.2} maxZoom={2} onNodeClick={(_, node) => setSelected(node.data.entity)}><Background gap={22} size={1} /><Controls /><MiniMap nodeColor={(node) => COLORS[node.data?.entity?.entityType] || COLORS.concept} pannable zoomable /></ReactFlow>}</div>
    </Card>
    <Card title="Node inspector" subtitle="Provenance and relationships" icon="info">
      {!selected ? <p className="text-sm leading-6 text-text-muted">Select a node to inspect its type, source metadata, and connected relationships.</p> : <div className="space-y-4"><div><span className="rounded-full bg-brand-500/10 px-2 py-1 text-[10px] font-semibold uppercase text-brand-500">{selected.entityType}</span><h3 className="mt-3 break-words font-semibold text-text-main">{selected.name}</h3><p className="mt-1 text-xs text-text-muted">Confidence {Number(selected.confidence || 0).toFixed(2)} · {selected.sourceType}</p></div><div className="border-t border-border pt-3"><p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Metadata</p><dl className="mt-2 space-y-2">{Object.entries(selected.metadata || {}).map(([key, value]) => <div key={key}><dt className="text-[10px] uppercase text-text-muted">{key}</dt><dd className="break-words text-xs text-text-main">{String(value)}</dd></div>)}</dl></div></div>}
    </Card>
  </div>;
}
