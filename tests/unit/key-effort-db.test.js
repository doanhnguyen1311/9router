import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TABLES, buildCreateTableSql } from '../../src/lib/db/schema.js';
let dir;
const originalDir = process.env.DATA_DIR;
async function boot() { delete global._dbAdapter; vi.resetModules(); const db = await import('@/lib/db/index.js'); const { getAdapter } = await import('@/lib/db/driver.js'); return { db, adapter: await getAdapter() }; }
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), '9router-effort-')); process.env.DATA_DIR = dir;
  fs.mkdirSync(path.join(dir, 'db'));
  const sqlite = new DatabaseSync(path.join(dir, 'db/data.sqlite'));
  for (const [name, definition] of Object.entries(TABLES)) {
    const def = { ...definition, columns: { ...definition.columns } };
    if (name === 'apiKeys') delete def.columns.effortPolicy;
    sqlite.exec(buildCreateTableSql(name, def));
  }
  sqlite.exec("INSERT INTO _meta VALUES('schemaVersion','1'),('backupSchemaVersion','8'); INSERT INTO apiKeys(id,key,name,isActive,createdAt) VALUES('a','fixture-a','A',1,'2026-01-01'); INSERT INTO usageHistory(timestamp,model) VALUES('2026-01-01','keep-me');");
  sqlite.close();
});
afterEach(() => { global._dbAdapter?.instance?.close(); delete global._dbAdapter; fs.rmSync(dir, { recursive: true, force: true }); if (originalDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDir; });
describe('key effort additive migration and transactional writes', () => {
  it('upgrades schema 8 in place, keeps usage and preserves client access for old/new keys', async () => {
    const { db, adapter } = await boot();
    expect(adapter.all('PRAGMA table_info(apiKeys)').map(c => c.name)).toContain('effortPolicy');
    expect((await db.getApiKeyById('a')).effortPolicy).toEqual({ allowUserChoice: true, effort: null, overrides: [] });
    expect(adapter.get('SELECT model FROM usageHistory').model).toBe('keep-me');
    expect(fs.readdirSync(path.join(dir, 'db/backups')).some(name => name.startsWith('schema-8-to-9'))).toBe(true);
    expect((await db.createApiKey('new', 'machine')).effortPolicy.allowUserChoice).toBe(true);
  });
  it('round-trips policy with backups and keeps it across unrelated key changes', async () => {
    const { db } = await boot(); const policy = { allowUserChoice: false, effort: 'high', overrides: [{ model: 'codex/gpt-6.1-sol', effort: 'low' }] };
    await db.updateApiKey('a', { effortPolicy: policy }); await db.updateApiKey('a', { name: 'renamed' });
    expect((await db.getApiKeyByKey('fixture-a')).effortPolicy).toEqual(policy);
    const backup = await db.exportDb(); expect(backup.apiKeys[0].effortPolicy).toEqual(policy);
    await db.importDb(backup); expect((await db.getApiKeyById('a')).effortPolicy).toEqual(policy);
    const bad = { ...backup, apiKeys: [{ ...backup.apiKeys[0], effortPolicy: { allowUserChoice: false, effort: 'auto' } }] };
    await expect(db.importDb(bad)).rejects.toThrow('effort'); expect((await db.getApiKeyById('a')).effortPolicy).toEqual(policy);
    await db.importDb({ ...backup, apiKeys: backup.apiKeys.map(({ effortPolicy, ...old }) => old) });
    expect((await db.getApiKeyById('a')).effortPolicy.allowUserChoice).toBe(true);
  });
  it('rechecks user effort access atomically and never grants permission from a user update', async () => {
    const { db } = await boot();
    expect((await db.updateApiKey('a', { selectedEffort: 'low' })).effortPolicy.effort).toBe('low');
    await db.updateApiKey('a', { effortPolicy: { allowUserChoice: false, effort: 'high' } });
    await expect(db.updateApiKey('a', { selectedEffort: 'max' })).rejects.toMatchObject({ code: 'KEY_EFFORT_FORBIDDEN' });
    expect((await db.getApiKeyById('a')).effortPolicy).toMatchObject({ allowUserChoice: false, effort: 'high' });
  });
  it('fails closed for corrupt stored JSON', async () => {
    const { db, adapter } = await boot(); adapter.run("UPDATE apiKeys SET effortPolicy='broken'");
    expect((await db.getApiKeyById('a')).effortPolicy).toMatchObject({ allowUserChoice: false, invalid: true });
    await expect(db.updateApiKey('a', { selectedEffort: 'max' })).rejects.toMatchObject({ code: 'KEY_EFFORT_FORBIDDEN' });
  });
});
