"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card } from "@/shared/components";
import ProjectGraph from "./ProjectGraph.js";
import ProjectPlanningPanel from "./ProjectPlanningPanel.jsx";

const TABS = [
  ["overview", "Overview", "dashboard"], ["graph", "Knowledge Graph", "hub"],
  ["planning", "Planning", "edit_note"],
  ["memories", "Memories", "memory"], ["files", "Files & Knowledge", "folder_open"],
  ["sessions", "Sessions", "forum"], ["api-keys", "API Keys", "key"],
  ["analytics", "Analytics", "monitoring"], ["settings", "Settings", "settings"],
];

const date = (value) => value ? new Date(value).toLocaleString() : "—";
const bytes = (value = 0) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;

function Metric({ icon, label, value, detail }) {
  return <Card padding="sm"><div className="flex items-start justify-between"><div><p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</p><p className="mt-2 text-2xl font-semibold text-text-main">{value}</p><p className="mt-1 text-xs text-text-muted">{detail}</p></div><span className="material-symbols-outlined rounded-xl bg-brand-500/10 p-2 text-brand-500">{icon}</span></div></Card>;
}

function Toggle({ label, description, checked, onChange, disabled }) {
  return <label className="flex cursor-pointer items-center justify-between gap-4 border-b border-border-subtle py-3 last:border-0"><span><span className="block text-sm font-medium text-text-main">{label}</span><span className="mt-0.5 block text-xs leading-5 text-text-muted">{description}</span></span><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-brand-500" /></label>;
}

export default function ProjectDetailClient({ projectId }) {
  const [project, setProject] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [planningPlanId, setPlanningPlanId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState({});
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingAll, setDeletingAll] = useState("");
  const [selectedMemory, setSelectedMemory] = useState(null);
  const [memoryDraft, setMemoryDraft] = useState({ memoryType: "technical_fact", subject: "", value: "", pinned: false });
  const [showMemoryForm, setShowMemoryForm] = useState(false);
  const [memoryHistory, setMemoryHistory] = useState([]);
  const fileInput = useRef(null);
  const folderInput = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedTab = params.get("tab");
    if (TABS.some(([id]) => id === requestedTab)) setActiveTab(requestedTab);
    const requestedPlan = params.get("plan");
    if (requestedPlan) setPlanningPlanId(requestedPlan);
  }, []);

  const loadProject = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load project.");
    setProject(body.project);
  }, [projectId]);

  const loadTab = useCallback(async (tab = activeTab, options = {}) => {
    setTabLoading(true); setError("");
    if (tab === "planning") { setTabLoading(false); return; }
    const endpoints = {
      overview: `/api/projects/${projectId}/analytics`,
      graph: `/api/projects/${projectId}/graph?q=${encodeURIComponent(options.q || query)}&depth=${options.depth || 2}`,
      memories: `/api/projects/${projectId}/memories?q=${encodeURIComponent(query)}&limit=200`,
      files: `/api/projects/${projectId}/files?q=${encodeURIComponent(query)}&limit=500`,
      sessions: `/api/projects/${projectId}/sessions?limit=200`,
      "api-keys": `/api/projects/${projectId}/api-keys`,
      analytics: `/api/projects/${projectId}/analytics`,
      settings: `/api/projects/${projectId}/settings`,
    };
    try {
      if (tab === "api-keys") {
        const assignedResponse = await fetch(endpoints[tab], { cache: "no-store" });
        const assigned = await assignedResponse.json();
        if (!assignedResponse.ok) throw new Error(assigned.error);
        setData((current) => ({ ...current, apiKeys: assigned.apiKeys || [], allApiKeys: assigned.availableApiKeys || [] }));
      } else if (tab === "settings") {
        const [settingsResponse, membersResponse, accessResponse] = await Promise.all([
          fetch(endpoints[tab], { cache: "no-store" }), fetch(`/api/projects/${projectId}/members`, { cache: "no-store" }), fetch("/api/projects/access", { cache: "no-store" }),
        ]);
        const settings = await settingsResponse.json(); const members = await membersResponse.json(); const access = await accessResponse.json();
        if (!settingsResponse.ok) throw new Error(settings.error); if (!membersResponse.ok) throw new Error(members.error);
        setData((current) => ({ ...current, settings: settings.settings, members: members.members || [], access }));
      } else {
        const response = await fetch(endpoints[tab], { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `Could not load ${tab}.`);
        setData((current) => ({ ...current, ...body }));
      }
    } catch (loadError) { setError(loadError.message || `Could not load ${tab}.`); }
    finally { setTabLoading(false); }
  }, [activeTab, projectId, query]);

  useEffect(() => { (async () => { try { await loadProject(); await loadTab("overview"); } catch (loadError) { setError(loadError.message); } finally { setLoading(false); } })(); }, [loadProject]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!loading) void loadTab(activeTab); }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (loading || !["memories", "files"].includes(activeTab)) return; const timer = setTimeout(() => void loadTab(activeTab), 220); return () => clearTimeout(timer); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  async function request(url, options, reload = true) {
    setError("");
    const response = await fetch(url, options); const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Operation failed.");
    if (reload) { await loadProject(); await loadTab(activeTab); }
    return body;
  }

  async function upload(files) {
    if (!files?.length) return;
    setUploading(true); setError("");
    try {
      const form = new FormData(); const paths = [];
      for (const file of files) { form.append("files", file, file.name); paths.push(file.webkitRelativePath || file.name); }
      form.append("relativePaths", JSON.stringify(paths));
      await request(`/api/projects/${projectId}/files`, { method: "POST", body: form });
    } catch (uploadError) { setError(uploadError.message); }
    finally { setUploading(false); setDragging(false); }
  }

  async function deleteAll(resource, label) {
    if (!window.confirm(`Delete all ${label} from this project? This cannot be undone.`)) return;
    setDeletingAll(resource);
    try {
      await request(`/api/projects/${projectId}/${resource}`, { method: "DELETE" });
      if (resource === "memories") { setSelectedMemory(null); setMemoryHistory([]); }
      if (resource === "files") setData((current) => ({ ...current, relatedFile: null }));
    } catch (deleteError) { setError(deleteError.message); }
    finally { setDeletingAll(""); }
  }

  async function createMemory(event) {
    event.preventDefault();
    try { await request(`/api/projects/${projectId}/memories`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(memoryDraft) }); setShowMemoryForm(false); setMemoryDraft({ memoryType: "technical_fact", subject: "", value: "", pinned: false }); }
    catch (saveError) { setError(saveError.message); }
  }

  async function mutateMemory(memory, changes) {
    try { await request(`/api/projects/${projectId}/memories/${memory.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) }); setSelectedMemory((current) => current?.id === memory.id ? { ...current, ...changes } : current); }
    catch (saveError) { setError(saveError.message); }
  }

  async function editMemory(memory) {
    const subject = window.prompt("Memory subject", memory.subject);
    if (subject == null) return;
    const value = window.prompt("Memory value", memory.value);
    if (value == null) return;
    await mutateMemory(memory, { subject, value });
    setSelectedMemory((current) => current?.id === memory.id ? { ...current, subject, value } : current);
  }

  async function loadMemoryHistory(memory) {
    try {
      const body = await request(`/api/projects/${projectId}/memories/${memory.id}`, { cache: "no-store" }, false);
      setMemoryHistory(body.history || []);
    } catch (historyError) { setError(historyError.message); }
  }

  async function saveSettings(next) {
    try {
      const body = await request(`/api/projects/${projectId}/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }, false);
      setData((current) => ({ ...current, settings: body.settings }));
    } catch (saveError) { setError(saveError.message); }
  }

  if (loading) return <div className="flex min-h-[50vh] items-center justify-center text-text-muted"><span className="material-symbols-outlined mr-2 animate-spin">progress_activity</span>Loading project…</div>;
  if (!project) return <Card className="p-12 text-center"><h1 className="text-lg font-semibold">Project unavailable</h1><p className="mt-2 text-sm text-text-muted">{error}</p><Link href="/dashboard/projects" className="mt-4 inline-block text-sm text-brand-500">Back to Projects</Link></Card>;

  const analytics = data.analytics || {};
  const canEdit = ["owner", "editor"].includes(project.role);
  return <div className="space-y-5">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div><Link href="/dashboard/projects" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-brand-500"><span className="material-symbols-outlined text-[15px]">arrow_back</span>Projects</Link><div className="mt-3 flex items-center gap-3"><div className="flex size-11 items-center justify-center rounded-xl bg-brand-500/10 text-brand-500"><span className="material-symbols-outlined">account_tree</span></div><div><div className="flex items-center gap-2"><h1 className="text-2xl font-semibold tracking-tight text-text-main">{project.name}</h1><span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-green-500">{project.status}</span></div><p className="mt-0.5 text-sm text-text-muted">{project.description || "No project description."}</p></div></div></div>
      <div className="flex items-center gap-2"><span className="rounded-lg border border-border bg-surface px-3 py-2 text-xs capitalize text-text-muted">{project.role}</span><Button variant="secondary" size="sm" icon="refresh" onClick={() => { void loadProject(); void loadTab(activeTab); }}>Refresh</Button></div>
    </div>

    <div className="overflow-x-auto border-b border-border"><nav className="flex min-w-max gap-1">{TABS.map(([id, label, icon]) => <button key={id} onClick={() => { setQuery(""); setActiveTab(id); }} className={`flex items-center gap-2 border-b-2 px-3 py-3 text-xs font-medium transition ${activeTab === id ? "border-brand-500 text-brand-500" : "border-transparent text-text-muted hover:text-text-main"}`}><span className="material-symbols-outlined text-[17px]">{icon}</span>{label}</button>)}</nav></div>
    {error && <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/5 p-3 text-sm text-red-500">{error}</div>}

    {activeTab === "overview" && <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric icon="memory" label="Active memories" value={project.stats.memories} detail={`${analytics.extraction?.processed || 0} events processed`} /><Metric icon="folder_open" label="Indexed files" value={project.stats.files} detail={bytes(project.stats.indexedBytes)} /><Metric icon="hub" label="Graph entities" value={project.stats.entities} detail={`${analytics.graph?.relationships || 0} relationships`} /><Metric icon="forum" label="Persistent sessions" value={project.stats.sessions} detail={`${project.stats.apiKeys} assigned API keys`} /></div>
      <div className="grid gap-4 lg:grid-cols-2"><Card title="How this project is used" subtitle="Provider-independent request flow" icon="route"><div className="space-y-3 text-sm"><div className="rounded-xl bg-surface-2 p-3"><p className="font-medium text-text-main">1. Resolve</p><p className="mt-1 text-xs text-text-muted">The API key pins this project at request start. In-flight requests never switch project.</p></div><div className="rounded-xl bg-surface-2 p-3"><p className="font-medium text-text-main">2. Retrieve</p><p className="mt-1 text-xs text-text-muted">Only relevant pinned decisions, constraints, files, and graph neighbors fit the configured token budget.</p></div><div className="rounded-xl bg-surface-2 p-3"><p className="font-medium text-text-main">3. Learn</p><p className="mt-1 text-xs text-text-muted">Minimal events enter the durable queue. Verified evidence outranks suggestions; pinned facts cannot be overwritten.</p></div></div></Card><Card title="Safety posture" subtitle="Current project boundaries" icon="shield"><ul className="space-y-3 text-sm text-text-muted"><li className="flex gap-2"><span className="material-symbols-outlined text-[17px] text-green-500">check_circle</span>Unassigned keys take the legacy path.</li><li className="flex gap-2"><span className="material-symbols-outlined text-[17px] text-green-500">check_circle</span>Project data is always treated as untrusted context.</li><li className="flex gap-2"><span className="material-symbols-outlined text-[17px] text-green-500">check_circle</span>Source uploads are redacted and never executed.</li><li className="flex gap-2"><span className="material-symbols-outlined text-[17px] text-green-500">check_circle</span>Session identity survives account failover and restarts.</li></ul></Card></div>
    </div>}

    {activeTab === "graph" && <div className="space-y-4">{canEdit && <div className="flex justify-end"><Button variant="danger" size="sm" icon="delete_sweep" loading={deletingAll === "graph"} disabled={Boolean(deletingAll)} onClick={() => void deleteAll("graph", "knowledge graph data")}>Delete all</Button></div>}<ProjectGraph graph={data.graph} loading={tabLoading} onSearch={(options) => void loadTab("graph", options)} /></div>}

    {activeTab === "planning" && <ProjectPlanningPanel projectId={projectId} canEdit={canEdit} initialPlanId={planningPlanId} />}

    {activeTab === "memories" && <div className="space-y-4"><div className="flex flex-col gap-3 sm:flex-row"><div className="relative flex-1"><span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[17px] text-text-muted">search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search subjects and values" className="h-10 w-full rounded-[10px] border border-border bg-surface pl-10 pr-3 text-sm outline-none focus:border-brand-500/60" /></div><Button icon="add" onClick={() => setShowMemoryForm(true)}>Add memory</Button>{canEdit && <Button variant="danger" icon="delete_sweep" loading={deletingAll === "memories"} disabled={Boolean(deletingAll)} onClick={() => void deleteAll("memories", "memories")}>Delete all</Button>}</div>
      {showMemoryForm && <Card><form onSubmit={createMemory} className="grid gap-3 lg:grid-cols-[180px_1fr_1fr_auto]"><select value={memoryDraft.memoryType} onChange={(event) => setMemoryDraft((current) => ({ ...current, memoryType: event.target.value }))} className="h-10 rounded-lg border border-border bg-surface-2 px-3 text-xs">{["project","architecture","entity","relationship","decision","task","constraint","technical_fact","file","dependency","issue","resolution"].map((type) => <option key={type}>{type}</option>)}</select><input required placeholder="Subject" value={memoryDraft.subject} onChange={(event) => setMemoryDraft((current) => ({ ...current, subject: event.target.value }))} className="h-10 rounded-lg border border-border bg-surface-2 px-3 text-sm" /><input required placeholder="Structured fact or decision" value={memoryDraft.value} onChange={(event) => setMemoryDraft((current) => ({ ...current, value: event.target.value }))} className="h-10 rounded-lg border border-border bg-surface-2 px-3 text-sm" /><div className="flex gap-2"><Button type="submit" size="sm">Save</Button><Button type="button" size="sm" variant="secondary" onClick={() => setShowMemoryForm(false)}>Cancel</Button></div><label className="col-span-full flex items-center gap-2 text-xs text-text-muted"><input type="checkbox" checked={memoryDraft.pinned} onChange={(event) => setMemoryDraft((current) => ({ ...current, pinned: event.target.checked }))} />Pin this memory</label></form></Card>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]"><Card padding="none" className="overflow-hidden">{tabLoading ? <p className="p-6 text-sm text-text-muted">Loading memories…</p> : !data.memories?.length ? <div className="p-12 text-center text-text-muted"><span className="material-symbols-outlined text-[34px]">memory</span><p className="mt-2 text-sm">No memories match this query.</p></div> : <div className="divide-y divide-border-subtle">{data.memories.map((memory) => <button key={memory.id} onClick={() => { setSelectedMemory(memory); setMemoryHistory([]); }} className={`w-full p-4 text-left hover:bg-surface-2/50 ${selectedMemory?.id === memory.id ? "bg-brand-500/5" : ""}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase text-text-muted">{memory.memoryType}</span>{memory.pinned && <span className="material-symbols-outlined text-[15px] text-amber-500">keep</span>}<span className={`text-[10px] ${memory.status === "rejected" ? "text-red-500" : "text-green-500"}`}>{memory.status}</span></div><p className="mt-2 font-medium text-text-main">{memory.subject}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-text-muted">{memory.value}</p></div><span className="text-[10px] text-text-muted">{Number(memory.confidence).toFixed(2)}</span></div></button>)}</div>}</Card><Card title="Memory inspector" icon="manage_search">{!selectedMemory ? <p className="text-sm leading-6 text-text-muted">Select a memory to view provenance, edit it, pin or archive it, and inspect history.</p> : <div className="space-y-4"><div><p className="text-[10px] uppercase tracking-wide text-text-muted">{selectedMemory.memoryType} · v{selectedMemory.version}</p><h3 className="mt-1 font-semibold text-text-main">{selectedMemory.subject}</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-muted">{selectedMemory.value}</p></div><dl className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs"><div><dt className="text-text-muted">Source</dt><dd className="mt-1 text-text-main">{selectedMemory.sourceType}</dd></div><div><dt className="text-text-muted">Evidence</dt><dd className="mt-1 break-words text-text-main">{selectedMemory.evidenceReference || "—"}</dd></div><div><dt className="text-text-muted">Confidence</dt><dd className="mt-1 text-text-main">{Number(selectedMemory.confidence).toFixed(2)}</dd></div><div><dt className="text-text-muted">Updated</dt><dd className="mt-1 text-text-main">{date(selectedMemory.updatedAt)}</dd></div></dl><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" icon="edit" onClick={() => void editMemory(selectedMemory)}>Edit</Button><Button size="sm" variant="secondary" icon="history" onClick={() => void loadMemoryHistory(selectedMemory)}>History</Button><Button size="sm" variant="secondary" icon="keep" onClick={() => void mutateMemory(selectedMemory, { pinned: !selectedMemory.pinned, status: selectedMemory.pinned ? "active" : "pinned" })}>{selectedMemory.pinned ? "Unpin" : "Pin"}</Button><Button size="sm" variant="secondary" icon="archive" onClick={() => void mutateMemory(selectedMemory, { status: "archived", pinned: false })}>Archive</Button><Button size="sm" variant="danger" icon="delete" onClick={async () => { if (!window.confirm("Delete this memory and its history?")) return; try { await request(`/api/projects/${projectId}/memories/${selectedMemory.id}`, { method: "DELETE" }); setSelectedMemory(null); setMemoryHistory([]); } catch (deleteError) { setError(deleteError.message); } }}>Delete</Button></div>{memoryHistory.length > 0 && <div className="border-t border-border pt-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Version history</p><div className="mt-2 max-h-44 space-y-2 overflow-y-auto">{memoryHistory.map((entry) => <div key={entry.id} className="rounded-lg bg-surface-2 p-2 text-[11px]"><div className="flex justify-between text-text-muted"><span>v{entry.version} · {entry.reason}</span><span>{date(entry.createdAt)}</span></div><p className="mt-1 text-text-main">{entry.snapshot?.subject}: {entry.snapshot?.value}</p></div>)}</div></div>}</div>}</Card></div>
    </div>}

    {activeTab === "files" && <div className="space-y-4">{canEdit && <div className="flex justify-end"><Button variant="danger" size="sm" icon="delete_sweep" loading={deletingAll === "files"} disabled={Boolean(deletingAll)} onClick={() => void deleteAll("files", "indexed files and file knowledge")}>Delete all</Button></div>}<div onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files); }} className={`rounded-2xl border-2 border-dashed p-8 text-center transition ${dragging ? "border-brand-500 bg-brand-500/5" : "border-border bg-surface"}`}><span className="material-symbols-outlined text-[42px] text-brand-500">cloud_upload</span><h2 className="mt-3 font-semibold text-text-main">Drop files, folders, or a source ZIP</h2><p className="mt-1 text-sm text-text-muted">Supported source and text formats are validated, redacted, parsed, and indexed incrementally. Nothing is executed.</p><div className="mt-5 flex flex-wrap justify-center gap-2"><Button onClick={() => fileInput.current?.click()} loading={uploading}>Browse files</Button><Button variant="secondary" onClick={() => folderInput.current?.click()} disabled={uploading}>Upload folder</Button><input ref={fileInput} hidden type="file" multiple accept=".ts,.tsx,.js,.jsx,.py,.java,.go,.rs,.php,.html,.css,.json,.yaml,.yml,.toml,.md,.sql,.xml,.zip" onChange={(event) => void upload(event.target.files)} /><input ref={folderInput} hidden type="file" multiple webkitdirectory="" onChange={(event) => void upload(event.target.files)} /></div></div>
      <div className="relative"><span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[17px] text-text-muted">search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search paths and symbols" className="h-10 w-full rounded-[10px] border border-border bg-surface pl-10 pr-3 text-sm outline-none focus:border-brand-500/60" /></div>
      <Card padding="none" className="overflow-x-auto">{tabLoading ? <p className="p-6 text-sm text-text-muted">Loading indexed files…</p> : !data.files?.length ? <div className="p-12 text-center text-text-muted"><span className="material-symbols-outlined text-[34px]">folder_off</span><p className="mt-2 text-sm">No indexed files match this query.</p></div> : <table className="w-full min-w-[900px] text-left text-xs"><thead className="border-b border-border bg-surface-2/70 text-[10px] uppercase tracking-wide text-text-muted"><tr>{["File", "Language", "Size", "Status", "Symbols", "Dependencies", "Content hash", "Indexed", "Actions"].map((heading) => <th key={heading} className="px-4 py-3 font-semibold">{heading}</th>)}</tr></thead><tbody className="divide-y divide-border-subtle">{data.files.map((file) => <tr key={file.id} className="hover:bg-surface-2/40"><td className="max-w-xs px-4 py-3 font-mono text-text-main">{file.relativePath}</td><td className="px-4 py-3 text-text-muted">{file.language || "Text"}</td><td className="px-4 py-3 text-text-muted">{bytes(file.fileSize)}</td><td className="px-4 py-3"><span className="rounded-full bg-green-500/10 px-2 py-1 text-[10px] text-green-500">{file.indexingStatus}</span></td><td className="px-4 py-3 text-text-main">{file.symbolCount}</td><td className="px-4 py-3 text-text-main">{file.dependencyCount}</td><td title={file.contentHash} className="max-w-28 truncate px-4 py-3 font-mono text-text-muted">{file.contentHash.slice(0, 12)}</td><td className="px-4 py-3 whitespace-nowrap text-text-muted">{date(file.indexedAt)}</td><td className="px-4 py-3"><div className="flex gap-1"><Button size="xs" variant="secondary" onClick={async () => { try { const related = await request(`/api/projects/${projectId}/files/${file.id}/related?depth=2`, {}, false); setData((current) => ({ ...current, relatedFile: related.related })); } catch (relatedError) { setError(relatedError.message); } }}>Related</Button><Button size="xs" variant="secondary" onClick={() => void request(`/api/projects/${projectId}/files/${file.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reindex" }) })}>Re-index</Button><Button size="xs" variant="danger" onClick={() => { if (window.confirm(`Remove ${file.relativePath} from this project?`)) void request(`/api/projects/${projectId}/files/${file.id}`, { method: "DELETE" }); }}>Remove</Button></div></td></tr>)}</tbody></table>}</Card>
      {data.relatedFile && <Card title={`Related files · ${data.relatedFile.source.relativePath}`} subtitle="Ranked from verified dependency edges" icon="account_tree" action={<button onClick={() => setData((current) => ({ ...current, relatedFile: null }))} className="text-text-muted"><span className="material-symbols-outlined">close</span></button>}><div className="space-y-2">{data.relatedFile.relationships.length ? data.relatedFile.relationships.map((relation) => <div key={`${relation.id}-${relation.depth}`} className="rounded-lg bg-surface-2 p-3 text-xs"><span className="font-mono text-text-main">{relation.sourcePath}</span><span className="mx-2 text-brand-500">—{relation.relationType}→</span><span className="font-mono text-text-main">{relation.targetPath || relation.targetReference}</span><span className="ml-2 text-text-muted">depth {relation.depth} · {relation.evidenceType}</span></div>) : <p className="text-sm text-text-muted">No verified relationships found.</p>}</div></Card>}
    </div>}

    {activeTab === "sessions" && <div className="space-y-4">{canEdit && <div className="flex justify-end"><Button variant="danger" size="sm" icon="delete_sweep" loading={deletingAll === "sessions"} disabled={Boolean(deletingAll)} onClick={() => void deleteAll("sessions", "sessions")}>Delete all</Button></div>}<Card padding="none" className="overflow-x-auto">{tabLoading ? <p className="p-6 text-text-muted">Loading sessions…</p> : <table className="w-full min-w-[760px] text-left text-xs"><thead className="border-b border-border bg-surface-2/70 text-[10px] uppercase text-text-muted"><tr>{["Virtual session", "Client", "Provider", "Account mapping", "Version", "Last activity"].map((heading) => <th className="px-4 py-3" key={heading}>{heading}</th>)}</tr></thead><tbody className="divide-y divide-border">{(data.sessions || []).map((session) => <tr key={session.id}><td className="px-4 py-3 font-mono text-text-main">{session.id.slice(0, 12)}…</td><td className="px-4 py-3"><p>{session.clientNamespace}</p><p className="max-w-56 truncate font-mono text-[10px] text-text-muted">{session.clientSessionId}</p></td><td className="px-4 py-3">{session.provider || "—"}</td><td className="px-4 py-3 font-mono text-text-muted">{session.accountId?.slice(0, 12) || "—"}</td><td className="px-4 py-3">v{session.sessionVersion}</td><td className="px-4 py-3 whitespace-nowrap text-text-muted">{date(session.lastActivityAt)}</td></tr>)}</tbody></table>}</Card></div>}

    {activeTab === "api-keys" && <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]"><Card title="Assigned API keys" subtitle="Each key has one active project at a time" icon="key">{!data.apiKeys?.length ? <p className="text-sm text-text-muted">No API keys are assigned to this project.</p> : <div className="space-y-2">{data.apiKeys.map((key) => <div key={key.id} className="flex items-center justify-between rounded-xl bg-surface-2 p-3"><div><p className="text-sm font-medium text-text-main">{key.name || key.id}</p><p className="mt-0.5 text-[11px] text-text-muted">{key.isActive ? "Active" : "Inactive"} · assigned {date(key.assignedAt)}</p></div><Button size="xs" variant="danger" onClick={() => void request(`/api/projects/${projectId}/api-keys`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKeyId: key.id }) })}>Remove</Button></div>)}</div>}</Card><Card title="Assign existing key" subtitle="New requests use this project immediately" icon="add_link"><div className="space-y-2">{(data.allApiKeys || []).filter((key) => key.projectAccess && !data.apiKeys?.some((assigned) => assigned.id === key.id)).map((key) => <button key={key.id} onClick={() => void request(`/api/projects/${projectId}/api-keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKeyId: key.id }) })} className="flex w-full items-center justify-between rounded-xl border border-border p-3 text-left hover:border-brand-500/40"><span><span className="block text-sm font-medium text-text-main">{key.name || key.id}</span><span className="mt-0.5 block text-[10px] text-text-muted">{key.isActive ? "Active" : "Inactive"}</span></span><span className="material-symbols-outlined text-brand-500">add</span></button>)}</div></Card></div>}

    {activeTab === "analytics" && <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric icon="speed" label="Avg retrieval" value={`${Number(analytics.retrieval?.averageDurationMs || 0).toFixed(1)} ms`} detail={`max ${analytics.retrieval?.maxDurationMs || 0} ms`} /><Metric icon="token" label="Context tokens" value={analytics.retrieval?.contextTokens || 0} detail={`${analytics.retrieval?.operations || 0} retrievals`} /><Metric icon="queue" label="Queue pending" value={analytics.queue?.pending || 0} detail={`${analytics.queue?.failed || 0} failed`} /><Metric icon="schema" label="Relationships" value={analytics.graph?.relationships || 0} detail={`${analytics.graph?.entities || 0} entities`} /></div><div className="grid gap-4 lg:grid-cols-2"><Card title="Memory by type" icon="memory"><div className="space-y-2">{(analytics.memoryByType || []).map((item) => <div key={`${item.memoryType}-${item.status}`} className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-xs"><span className="capitalize text-text-main">{item.memoryType.replaceAll("_", " ")} <span className="text-text-muted">· {item.status}</span></span><strong>{item.count}</strong></div>)}</div></Card><Card title="File indexing" icon="folder_managed"><div className="space-y-2">{(analytics.filesByStatus || []).map((item) => <div key={item.indexingStatus} className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-xs"><span className="capitalize text-text-main">{item.indexingStatus}</span><span className="text-text-muted">{item.count} files · {bytes(item.bytes)}</span></div>)}</div></Card></div></div>}

    {activeTab === "settings" && data.settings && <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]"><div className="space-y-4"><Card title="Memory engine" subtitle="Project-level switches sit below global and user access" icon="tune"><Toggle label="Structured memory" description="Master switch for this project. Data remains stored when disabled." checked={data.settings.memoryEnabled} onChange={(value) => void saveSettings({ memoryEnabled: value })} /><Toggle label="Automatic extraction" description="Queue minimal request/tool evidence for heuristic extraction." checked={data.settings.extractionEnabled} onChange={(value) => void saveSettings({ extractionEnabled: value })} /><Toggle label="Automatic retrieval" description="Build relevant, bounded untrusted context for assigned keys." checked={data.settings.retrievalEnabled} onChange={(value) => void saveSettings({ retrievalEnabled: value })} /><Toggle label="File indexing" description="Allow uploads, ZIP import, parsing, and dependency updates." checked={data.settings.fileIndexingEnabled} onChange={(value) => void saveSettings({ fileIndexingEnabled: value })} /><Toggle label="Retain redacted source" description="Required for one-click re-index. Secret findings are redacted first." checked={data.settings.retainSourceContent} onChange={(value) => void saveSettings({ retainSourceContent: value })} /><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-xs font-semibold text-text-main">Context token budget<input type="number" min="128" max="16000" value={data.settings.contextTokenBudget} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, contextTokenBudget: Number(event.target.value) } }))} onBlur={() => void saveSettings({ contextTokenBudget: data.settings.contextTokenBudget })} className="mt-1.5 h-10 w-full rounded-lg border border-border bg-surface-2 px-3" /></label><label className="text-xs font-semibold text-text-main">Graph traversal depth<input type="number" min="1" max="6" value={data.settings.maxGraphDepth} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, maxGraphDepth: Number(event.target.value) } }))} onBlur={() => void saveSettings({ maxGraphDepth: data.settings.maxGraphDepth })} className="mt-1.5 h-10 w-full rounded-lg border border-border bg-surface-2 px-3" /></label></div></Card><Card title="Project sharing" subtitle="Owner, editor, and viewer roles" icon="group"><div className="space-y-2">{(data.members || []).map((member) => <div key={member.principalId} className="rounded-xl bg-surface-2 p-3"><div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium text-text-main">{member.displayName || member.principalId}</p><p className="truncate font-mono text-[10px] text-text-muted">{member.principalId}</p></div><span className="rounded-full bg-brand-500/10 px-2 py-1 text-[10px] uppercase text-brand-500">{member.role}</span></div></div>)}</div><p className="mt-3 text-xs leading-5 text-text-muted">Member invitation UI accepts stable dashboard principals once directory-backed user discovery is available. The API already supports add, revoke, and ownership transfer.</p></Card></div><div className="space-y-4"><Card title="Effective access" icon="admin_panel_settings"><dl className="space-y-3 text-xs"><div className="flex justify-between"><dt className="text-text-muted">Global access</dt><dd className={data.access?.system?.enabled ? "text-green-500" : "text-red-500"}>{data.access?.system?.enabled ? "ON" : "OFF"}</dd></div><div className="flex justify-between"><dt className="text-text-muted">User access</dt><dd className={data.access?.user?.userEnabled ? "text-green-500" : "text-red-500"}>{data.access?.user?.userEnabled ? "ON" : "OFF"}</dd></div><div className="flex justify-between"><dt className="text-text-muted">Effective</dt><dd className={data.access?.user?.effective ? "text-green-500" : "text-red-500"}>{data.access?.user?.effective ? "ALLOWED" : "DENIED"}</dd></div></dl></Card><Card title="Project state" icon="lock"><p className="text-xs leading-5 text-text-muted">Locking preserves all data and blocks editor mutations. Archiving removes it from normal active workflows.</p><div className="mt-3 flex gap-2"><Button size="sm" variant="secondary" onClick={() => void request(`/api/projects/${projectId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: project.status === "locked" ? "active" : "locked" }) })}>{project.status === "locked" ? "Unlock" : "Lock project"}</Button></div></Card><Card title="Danger zone" icon="warning" className="border-red-500/25"><p className="text-xs leading-5 text-text-muted">Deletion cascades project-owned memory, graph, sessions, and file indexes. API keys remain intact and become unassigned.</p><Button className="mt-3" size="sm" variant="danger" onClick={async () => { const confirmation = window.prompt(`Type “${project.name}” to permanently delete this project.`); if (!confirmation) return; try { await request(`/api/projects/${projectId}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation }) }, false); window.location.href = "/dashboard/projects"; } catch (deleteError) { setError(deleteError.message); } }}>Delete project</Button></Card></div></div>}
  </div>;
}
