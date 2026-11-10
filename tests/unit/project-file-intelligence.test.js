import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const owner = { principalId: "local-admin", displayName: "Local Admin" };

async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const repository = await import("@/lib/projectMemory/repository.js");
  const files = await import("@/lib/projectMemory/fileIntelligence.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  return { repository, files, adapter: await getAdapter() };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let centralSize = 0;
  for (const entry of entries) {
    const fileName = Buffer.from(entry.name);
    const data = Buffer.from(entry.content);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(localOffset, 42);
    localParts.push(local, fileName, data);
    centralParts.push(central, fileName);
    localOffset += local.length + fileName.length + data.length;
    centralSize += central.length + fileName.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function storedZip(name, content) {
  return storedZipEntries([{ name, content }]);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-file-intelligence-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Project file intelligence", () => {
  it("blocks traversal and malicious ZIP entry names", async () => {
    const { files } = await boot();
    for (const invalid of ["../secret.txt", "/etc/passwd", "C:\\secret.txt", "src/../../secret.txt", "x\0y"]) {
      expect(() => files.normalizeRelativePath(invalid)).toThrow();
    }
    expect(() => files.extractZipEntries(storedZip("../escape.js", "export default 1")))
      .toThrowError(expect.objectContaining({ code: "INVALID_PATH" }));
  });

  it("redacts common secrets and extracts symbols plus static dependencies", async () => {
    const { files } = await boot();
    const redacted = files.redactSecrets('const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";\napi_key=supersecretvalue\nowner=developer@example.com');
    expect(redacted.findings.length).toBeGreaterThanOrEqual(3);
    expect(redacted.text).not.toContain("supersecretvalue");
    expect(redacted.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted.text).not.toContain("developer@example.com");

    const parsed = files.parseSource("src/router.ts", 'import { db } from "./db";\nexport class Router {}\nexport function route() {}');
    expect(parsed.language).toBe("TypeScript");
    expect(parsed.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ targetReference: "./db" })]));
    expect(parsed.symbols.map((item) => item.name)).toEqual(expect.arrayContaining(["Router", "route"]));
  });

  it("indexes incrementally, resolves related files, and never stores plaintext secrets", async () => {
    const { repository, files, adapter } = await boot();
    const project = await repository.createProject({ name: "Indexed" }, owner);
    const dependency = await files.indexProjectFile({
      projectId: project.id,
      relativePath: "src/db.ts",
      buffer: Buffer.from("export function connect() { return true; }"),
    }, owner);
    const sourceText = 'import { connect } from "./db";\nconst api_key=supersecretvalue;\nexport function start() { return connect(); }';
    const source = await files.indexProjectFile({
      projectId: project.id,
      relativePath: "src/app.ts",
      buffer: Buffer.from(sourceText),
    }, owner);
    const dependencyStoragePath = adapter.get("SELECT storagePath FROM projectFiles WHERE id=?", [dependency.id]).storagePath;
    const unchanged = await files.indexProjectFile({
      projectId: project.id,
      relativePath: "src/app.ts",
      buffer: Buffer.from(sourceText),
    }, owner);

    expect(unchanged.unchanged).toBe(true);
    const stored = adapter.get("SELECT redactedContent, storagePath, secretCount FROM projectFiles WHERE id=?", [source.id]);
    expect(stored.secretCount).toBeGreaterThan(0);
    expect(stored.redactedContent).not.toContain("supersecretvalue");
    expect(fs.readFileSync(stored.storagePath, "utf8")).not.toContain("supersecretvalue");

    const related = await files.getRelatedFiles(project.id, source.id, owner.principalId, 2);
    expect(related.files).toEqual(expect.arrayContaining([expect.objectContaining({ id: dependency.id })]));
    expect(related.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFileId: source.id, targetFileId: dependency.id, evidenceType: "static-parser" }),
    ]));

    const secondProject = await repository.createProject({ name: "Isolated files" }, owner);
    expect(await files.listProjectFiles(secondProject.id, owner.principalId)).toEqual([]);
    expect(await files.removeProjectFile(project.id, source.id, owner)).toBe(true);
    expect(adapter.get("SELECT COUNT(*) AS count FROM memoryEntities WHERE projectId=?", [project.id]).count)
      .toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(dependencyStoragePath)).toBe(true);
    expect(await repository.deleteProject(project.id, owner, project.name)).toBe(true);
    expect(fs.existsSync(dependencyStoragePath)).toBe(false);
  });

  it("imports a valid ZIP but ignores secret files", async () => {
    const { repository, files } = await boot();
    const project = await repository.createProject({ name: "ZIP" }, owner);
    const valid = files.extractZipEntries(storedZip("src/index.js", "export const value = 1;"));
    expect(valid).toHaveLength(1);
    expect(valid[0].relativePath).toBe("src/index.js");

    const ignored = await files.indexProjectFile({
      projectId: project.id,
      relativePath: ".env",
      buffer: Buffer.from("TOKEN=should-never-be-read"),
    }, owner);
    expect(ignored).toMatchObject({ ignored: true, reason: "secret-file" });
    const result = await files.importProjectZip({ projectId: project.id, buffer: storedZip("src/index.js", "export const value = 1;") }, owner);
    expect(result).toMatchObject({ total: 1, indexed: 1, failed: 0 });
  });

  it("bulk imports resolve dependencies once at completion and remain incremental", async () => {
    const { repository, files, adapter } = await boot();
    const project = await repository.createProject({ name: "Bulk ZIP" }, owner);
    const archive = storedZipEntries([
      { name: "src/db.ts", content: "export function connect() { return true; }" },
      { name: "src/app.ts", content: 'import { connect } from "./db"; export function start() { return connect(); }' },
      { name: "src/ignored.log", content: "ignored" },
    ]);

    const first = await files.importProjectZip({ projectId: project.id, buffer: archive }, owner);
    const dependency = adapter.get(
      "SELECT targetFileId FROM projectFileDependencies WHERE projectId=? AND targetReference='./db'",
      [project.id],
    );
    const second = await files.importProjectZip({ projectId: project.id, buffer: archive }, owner);

    expect(first).toMatchObject({ total: 3, indexed: 2, ignored: 1, failed: 0 });
    expect(dependency.targetFileId).toBeTruthy();
    expect(second.results.filter((item) => item.unchanged)).toHaveLength(2);
    expect(adapter.get("SELECT COUNT(*) AS count FROM projectFiles WHERE projectId=?", [project.id]).count).toBe(2);
    expect(adapter.get("SELECT COUNT(*) AS count FROM projectFileDependencies WHERE projectId=?", [project.id]).count).toBe(1);
  });

  it("serializes same-project ZIP imports and releases the queue after failure", async () => {
    const { repository, files, adapter } = await boot();
    const project = await repository.createProject({ name: "Concurrent ZIP" }, owner);
    await expect(files.importProjectZip({ projectId: project.id, buffer: Buffer.from("not-a-zip") }, owner))
      .rejects.toMatchObject({ code: "INVALID_ZIP" });

    const [first, second] = await Promise.all([
      files.importProjectZip({ projectId: project.id, buffer: storedZip("src/a.ts", "export const a = 1;") }, owner),
      files.importProjectZip({ projectId: project.id, buffer: storedZip("src/b.ts", 'import { a } from "./a"; export const b = a;') }, owner),
    ]);

    expect(first.failed).toBe(0);
    expect(second.failed).toBe(0);
    expect(adapter.get("SELECT COUNT(*) AS count FROM projectFiles WHERE projectId=?", [project.id]).count).toBe(2);
    expect(adapter.get("SELECT targetFileId FROM projectFileDependencies WHERE projectId=?", [project.id]).targetFileId).toBeTruthy();
  });
});
