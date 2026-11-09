"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card } from "@/shared/components";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function EmptyState({ onCreate, disabled }) {
  return <Card className="flex flex-col items-center px-6 py-16 text-center">
    <span className="material-symbols-outlined text-[44px] text-brand-500/70">account_tree</span>
    <h2 className="mt-4 text-lg font-semibold text-text-main">Give your AI a durable project memory</h2>
    <p className="mt-2 max-w-lg text-sm leading-6 text-text-muted">Projects connect structured decisions, source files, dependencies, sessions, and relevant context across providers—without changing unassigned API keys.</p>
    <Button className="mt-6" icon="add" onClick={onCreate} disabled={disabled}>Create your first project</Button>
  </Card>;
}

export default function ProjectsPageClient() {
  const [projects, setProjects] = useState([]);
  const [access, setAccess] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [saving, setSaving] = useState(false);
  const [apiKeys, setApiKeys] = useState([]);
  const [adminOpen, setAdminOpen] = useState(false);
  const [permissionPrincipal, setPermissionPrincipal] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const accessResponse = await fetch("/api/projects/access", { cache: "no-store" });
      const accessData = await accessResponse.json();
      if (!accessResponse.ok) throw new Error(accessData.error || "Could not load project access.");
      let projectData = { projects: [] };
      if (accessData.user?.effective) {
        const params = new URLSearchParams();
        if (accessData.admin) params.set("scope", "all");
        if (query) params.set("q", query);
        const projectsResponse = await fetch(`/api/projects${params.size ? `?${params}` : ""}`, { cache: "no-store" });
        projectData = await projectsResponse.json();
        if (!projectsResponse.ok) throw new Error(projectData.error || "Could not load projects.");
      }
      let keys = [];
      if (accessData.admin) {
        const keysResponse = await fetch("/api/keys", { cache: "no-store" });
        const keysData = await keysResponse.json();
        if (!keysResponse.ok) throw new Error(keysData.error || "Could not load API keys.");
        keys = keysData.keys || [];
      }
      setProjects(projectData.projects || []); setAccess(accessData); setApiKeys(keys);
    } catch (loadError) { setError(loadError.message || "Could not load projects."); }
    finally { setLoading(false); }
  }, [query]);

  useEffect(() => { const timer = setTimeout(() => void load(), 180); return () => clearTimeout(timer); }, [load]);

  async function create(event) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create project.");
      setShowCreate(false); setForm({ name: "", description: "" }); await load();
    } catch (createError) { setError(createError.message || "Could not create project."); }
    finally { setSaving(false); }
  }

  async function updateAccess(scope, payload) {
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/projects/access", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, ...payload }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not update access.");
      await load();
    } catch (accessError) { setError(accessError.message || "Could not update access."); }
    finally { setSaving(false); }
  }

  const enabled = access?.user?.effective !== false;
  return <div className="space-y-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-brand-500"><span className="material-symbols-outlined text-[16px]">memory</span>Persistent AI Project Intelligence</div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text-main">Projects</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-text-muted">Shared structured memory, file intelligence, and provider-independent sessions. API keys remain standard until you explicitly assign a project.</p>
      </div>
      <div className="flex gap-2">{access?.admin && <Button variant="secondary" icon="admin_panel_settings" onClick={() => setAdminOpen((value) => !value)}>Access control</Button>}<Button icon="add" onClick={() => setShowCreate(true)} disabled={!enabled}>New project</Button></div>
    </div>

    {access && !enabled && <Card className="border-amber-500/30 bg-amber-500/5"><div className="flex gap-3"><span className="material-symbols-outlined text-amber-500">lock</span><div><h2 className="font-semibold text-text-main">Project Access is off</h2><p className="mt-1 text-sm text-text-muted">Existing data is preserved. Re-enable global or user access to manage projects and retrieve memory.</p></div></div></Card>}
    {adminOpen && access?.admin && <Card title="Project Access" subtitle="Effective Permission = Global AND User AND API Key" icon="admin_panel_settings" action={<span className="text-[10px] uppercase text-text-muted">Data is retained when disabled</span>}>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><div><h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Global and current user</h3><div className="mt-2 divide-y divide-border-subtle rounded-xl bg-surface-2 px-3">{[["enabled","Global Project feature"],["extractionEnabled","Automatic extraction"],["retrievalEnabled","Automatic retrieval"],["fileIndexingEnabled","File intelligence"]].map(([key, label]) => <label key={key} className="flex items-center justify-between py-3 text-sm"><span>{label}</span><input type="checkbox" disabled={saving} checked={access.system[key]} onChange={(event) => void updateAccess("global", { settings: { [key]: event.target.checked } })} className="size-4 accent-brand-500" /></label>)}<label className="flex items-center justify-between py-3 text-sm"><span>Current user access</span><input type="checkbox" disabled={saving} checked={access.user.userEnabled} onChange={(event) => void updateAccess("user", { principalId: access.principalId, enabled: event.target.checked })} className="size-4 accent-brand-500" /></label></div></div><div><h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">API key access</h3><div className="mt-2 max-h-72 divide-y divide-border-subtle overflow-y-auto rounded-xl bg-surface-2 px-3">{apiKeys.map((key) => <label key={key.id} className="flex items-center justify-between gap-3 py-3"><span className="min-w-0"><span className="block truncate text-sm text-text-main">{key.name || key.id}</span><span className="block text-[10px] text-text-muted">{key.isActive ? "Active" : "Inactive"}</span></span><input type="checkbox" disabled={saving} checked={key.projectAccess !== false} onChange={(event) => void updateAccess("apiKey", { apiKeyId: key.id, enabled: event.target.checked })} className="size-4 accent-brand-500" /></label>)}</div></div></div>
      <div className="mt-4 grid gap-4 border-t border-border-subtle pt-4 xl:grid-cols-2"><div><h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">User-level access</h3><div className="mt-2 flex flex-col gap-2 rounded-xl bg-surface-2 p-3 sm:flex-row"><input value={permissionPrincipal} onChange={(event) => setPermissionPrincipal(event.target.value)} placeholder="Stable principal ID" className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-xs outline-none focus:border-brand-500/60" /><Button size="sm" disabled={!permissionPrincipal.trim() || saving} onClick={() => void updateAccess("user", { principalId: permissionPrincipal.trim(), enabled: true })}>Grant</Button><Button size="sm" variant="danger" disabled={!permissionPrincipal.trim() || saving} onClick={() => void updateAccess("user", { principalId: permissionPrincipal.trim(), enabled: false })}>Revoke</Button></div></div><div><h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Project and file limits</h3><div className="mt-2 grid grid-cols-2 gap-2 rounded-xl bg-surface-2 p-3">{[["maxProjectsPerUser","Projects / user"],["maxFilesPerProject","Files / project"],["maxProjectBytes","Project bytes"],["maxFileBytes","File bytes"]].map(([key, label]) => <label key={`${key}-${access.system.updatedAt}`} className="text-[10px] text-text-muted">{label}<input type="number" min="1" defaultValue={access.system[key]} disabled={saving} onBlur={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value > 0 && value !== access.system[key]) void updateAccess("global", { settings: { [key]: value } }); }} className="mt-1 h-9 w-full rounded-lg border border-border bg-surface px-2 text-xs text-text-main" /></label>)}</div></div></div>
    </Card>}
    {error && <div role="alert" className="flex items-center justify-between rounded-xl border border-red-500/25 bg-red-500/5 p-4 text-sm text-red-500"><span>{error}</span><Button size="sm" variant="secondary" onClick={load}>Retry</Button></div>}

    <Card padding="sm"><div className="relative"><span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-text-muted">search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" className="h-10 w-full rounded-[10px] border border-border bg-surface-2 pl-10 pr-3 text-sm text-text-main outline-none focus:border-brand-500/60" /></div></Card>

    {loading ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0,1,2].map((item) => <Card key={item} className="h-52 animate-pulse bg-surface-2" />)}</div>
      : projects.length === 0 ? <EmptyState onCreate={() => setShowCreate(true)} disabled={!enabled} />
      : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{projects.map((project) => <Link href={`/dashboard/projects/${project.id}`} key={project.id} className="group"><Card hover className="h-full">
        <div className="flex items-start justify-between gap-3"><div className="flex size-11 items-center justify-center rounded-xl bg-brand-500/10 text-brand-500"><span className="material-symbols-outlined">account_tree</span></div><span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${project.status === "active" ? "bg-green-500/10 text-green-500" : "bg-amber-500/10 text-amber-500"}`}>{project.status}</span></div>
        <h2 className="mt-4 truncate text-lg font-semibold text-text-main group-hover:text-brand-500">{project.name}</h2>
        <p className="mt-1 line-clamp-2 min-h-10 text-sm leading-5 text-text-muted">{project.description || "No description yet."}</p>
        <div className="mt-5 grid grid-cols-3 gap-2 border-t border-border-subtle pt-4 text-center"><div><p className="font-semibold text-text-main">{compact.format(project.stats.memories)}</p><p className="text-[10px] uppercase text-text-muted">Memory</p></div><div><p className="font-semibold text-text-main">{compact.format(project.stats.files)}</p><p className="text-[10px] uppercase text-text-muted">Files</p></div><div><p className="font-semibold text-text-main">{compact.format(project.stats.entities)}</p><p className="text-[10px] uppercase text-text-muted">Entities</p></div></div>
        <div className="mt-4 flex items-center justify-between gap-3 text-[11px] text-text-muted"><span className="min-w-0 truncate capitalize">{project.role || `Owner ${project.ownerId}`}</span><span className="shrink-0">Updated {new Date(project.updatedAt).toLocaleDateString()}</span></div>
      </Card></Link>)}</div>}

    {showCreate && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCreate(false); }}><Card className="w-full max-w-lg" elev>
      <div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold text-text-main">Create project</h2><p className="mt-1 text-sm text-text-muted">You can assign API keys after creation.</p></div><button onClick={() => setShowCreate(false)} className="rounded-lg p-2 text-text-muted hover:bg-surface-2"><span className="material-symbols-outlined">close</span></button></div>
      <form onSubmit={create} className="mt-5 space-y-4"><label className="block text-xs font-semibold text-text-main">Name<input autoFocus required maxLength={120} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} className="mt-1.5 h-10 w-full rounded-[10px] border border-border bg-surface-2 px-3 text-sm outline-none focus:border-brand-500/60" placeholder="E-commerce platform" /></label><label className="block text-xs font-semibold text-text-main">Description<textarea maxLength={4000} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} className="mt-1.5 min-h-28 w-full rounded-[10px] border border-border bg-surface-2 p-3 text-sm outline-none focus:border-brand-500/60" placeholder="What this project does and what your AI collaborators should know." /></label><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button><Button type="submit" loading={saving} disabled={!form.name.trim()}>Create project</Button></div></form>
    </Card></div>}
  </div>;
}
