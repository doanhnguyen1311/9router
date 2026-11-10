import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { v4 as uuidv4 } from "uuid";
import { DATA_DIR } from "@/lib/dataDir.js";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";
import {
  DEFAULT_IGNORE_PARTS,
  FILE_LIMITS,
  SECRET_FILE_PATTERNS,
} from "./config.js";
import {
  projectError,
  requireProjectRole,
  touchProject,
  getProjectSystemSettings,
  getProjectSettings,
} from "./repository.js";
import { upsertEntityInTransaction, upsertRelationInTransaction } from "./graphRepository.js";
import { removeSearchDocumentInTransaction, upsertSearchDocumentInTransaction } from "./searchIndex.js";
import { redactProjectText } from "./privacy.js";

const STORAGE_ROOT = path.join(DATA_DIR, "project-memory", "files");
const PARSER_VERSION = "9router-file-intelligence/1";

const projectImportLocks = new Map();

const LANGUAGE_BY_EXTENSION = Object.freeze({
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".java": "Java", ".go": "Go", ".rs": "Rust", ".php": "PHP",
  ".html": "HTML", ".htm": "HTML", ".css": "CSS", ".scss": "SCSS", ".less": "Less",
  ".json": "JSON", ".jsonc": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
  ".md": "Markdown", ".mdx": "Markdown", ".sql": "SQL", ".xml": "XML", ".svg": "XML",
  ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell", ".ini": "Configuration",
  ".conf": "Configuration", ".properties": "Configuration", ".gradle": "Gradle",
});

const SECRET_PATTERNS = [
  { name: "private-key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: "aws-access-key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: "openai-key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "generic-secret", regex: /\b(api[_-]?key|secret|password|token)\s*[:=]\s*(["']?)[^\s,"']{8,}\2/gi },
  { name: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function normalizeRelativePath(input) {
  if (typeof input !== "string" || !input || input.includes("\0")) throw projectError("INVALID_PATH", "Invalid file path");
  let value = input.replace(/\\/g, "/").replace(/^\.\//, "");
  if (value.length > FILE_LIMITS.maxPathLength || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) throw projectError("INVALID_PATH", "Absolute or oversized paths are not allowed");
  value = path.posix.normalize(value);
  if (!value || value === "." || value === ".." || value.startsWith("../") || value.split("/").includes("..")) throw projectError("INVALID_PATH", "Path traversal is not allowed");
  return value;
}

function globToRegex(rule) {
  const source = rule.replace(/\\/g, "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0/g, ".*");
  return new RegExp(`(?:^|/)${source.replace(/^\//, "")}(?:$|/)`, "i");
}

function shouldIgnore(relativePath, customRules = []) {
  const parts = relativePath.split("/");
  if (parts.some((part) => DEFAULT_IGNORE_PARTS.includes(part))) return { ignored: true, reason: "default-ignore" };
  const name = parts.at(-1);
  if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name))) return { ignored: true, reason: "secret-file" };
  for (const raw of customRules) {
    const rule = String(raw || "").trim();
    if (!rule || rule.startsWith("#") || rule.startsWith("!")) continue;
    try { if (globToRegex(rule).test(relativePath)) return { ignored: true, reason: "project-ignore" }; } catch { /* validated as inert */ }
  }
  return { ignored: false, reason: null };
}

function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  return sample.length > 0 && suspicious / sample.length > 0.12;
}

export function redactSecrets(text) {
  const privacy = redactProjectText(text);
  let output = privacy.text;
  const findings = [...privacy.findings];
  for (const item of SECRET_PATTERNS) {
    output = output.replace(item.regex, (match) => {
      findings.push(item.name);
      const label = match.match(/^\s*([\w-]+\s*[:=])/i)?.[1] || "";
      return `${label}[REDACTED:${item.name}]`;
    });
  }
  return { text: output, findings };
}

function addMatches(out, content, regex, symbolType, nameGroup = 1) {
  for (const match of content.matchAll(regex)) {
    if (out.length >= FILE_LIMITS.maxSymbolsPerFile) break;
    const name = match[nameGroup];
    if (!name) continue;
    const lineStart = content.slice(0, match.index).split("\n").length;
    out.push({ symbolType, name: name.slice(0, 300), qualifiedName: null, lineStart, lineEnd: lineStart, signature: match[0].slice(0, 500), metadata: {} });
  }
}

function addDependencies(out, content, regex, relationType = "IMPORTS", group = 1) {
  for (const match of content.matchAll(regex)) {
    if (out.length >= FILE_LIMITS.maxDependenciesPerFile) break;
    const reference = match[group];
    if (!reference) continue;
    const line = content.slice(0, match.index).split("\n").length;
    out.push({ targetReference: reference.slice(0, 500), relationType, evidenceType: "static-parser", evidenceReference: `line:${line}`, confidence: 1 });
  }
}

export function parseSource(relativePath, content) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const language = LANGUAGE_BY_EXTENSION[extension] || (path.posix.basename(relativePath).includes("Dockerfile") ? "Dockerfile" : null);
  const symbols = [];
  const dependencies = [];
  if ([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    addDependencies(dependencies, content, /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g);
    addDependencies(dependencies, content, /require\s*\(\s*["']([^"']+)["']\s*\)/g);
    addDependencies(dependencies, content, /import\s*\(\s*["']([^"']+)["']\s*\)/g);
    addMatches(symbols, content, /\bclass\s+([A-Za-z_$][\w$]*)/g, "class");
    addMatches(symbols, content, /\binterface\s+([A-Za-z_$][\w$]*)/g, "interface");
    addMatches(symbols, content, /\btype\s+([A-Za-z_$][\w$]*)\s*=/g, "type");
    addMatches(symbols, content, /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, "function");
    addMatches(symbols, content, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, "variable");
  } else if (extension === ".py") {
    addDependencies(dependencies, content, /^\s*from\s+([\w.]+)\s+import\s+/gm);
    addDependencies(dependencies, content, /^\s*import\s+([\w.]+)/gm);
    addMatches(symbols, content, /^\s*class\s+([A-Za-z_]\w*)/gm, "class");
    addMatches(symbols, content, /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm, "function");
  } else if (extension === ".java") {
    addDependencies(dependencies, content, /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/gm);
    addMatches(symbols, content, /\bclass\s+([A-Za-z_]\w*)/g, "class");
    addMatches(symbols, content, /\binterface\s+([A-Za-z_]\w*)/g, "interface");
    addMatches(symbols, content, /\benum\s+([A-Za-z_]\w*)/g, "enum");
  } else if (extension === ".go") {
    addDependencies(dependencies, content, /^\s*import\s+(?:[\w.]+\s+)?["`]([^"`]+)["`]/gm);
    addDependencies(dependencies, content, /import\s*\([\s\S]*?["`]([^"`]+)["`][\s\S]*?\)/g);
    addMatches(symbols, content, /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm, "function");
    addMatches(symbols, content, /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm, "type");
  } else if (extension === ".rs") {
    addDependencies(dependencies, content, /^\s*use\s+([^;]+);/gm);
    addDependencies(dependencies, content, /^\s*mod\s+([A-Za-z_]\w*)\s*;/gm);
    addMatches(symbols, content, /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g, "function");
    addMatches(symbols, content, /\b(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/g, "type");
  } else if (extension === ".php") {
    addDependencies(dependencies, content, /\b(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/g);
    addDependencies(dependencies, content, /^\s*use\s+([^;]+);/gm, "USES");
    addMatches(symbols, content, /\bclass\s+([A-Za-z_]\w*)/g, "class");
    addMatches(symbols, content, /\bfunction\s+([A-Za-z_]\w*)\s*\(/g, "function");
  } else if ([".html", ".htm"].includes(extension)) {
    addDependencies(dependencies, content, /<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/gi, "REFERENCES");
  } else if ([".css", ".scss", ".less"].includes(extension)) {
    addDependencies(dependencies, content, /@(?:import|use)\s+(?:url\()?\s*["']([^"']+)["']/g);
  } else if (extension === ".sql") {
    addMatches(symbols, content, /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([\w.]+)/gi, "table");
    addMatches(symbols, content, /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|VIEW)\s+["`[]?([\w.]+)/gi, "database-object");
  } else if ([".json", ".yaml", ".yml", ".toml", ".ini", ".conf", ".properties"].includes(extension)) {
    addMatches(symbols, content, /^\s*["']?([A-Za-z_][\w.-]*)["']?\s*[:=]/gm, "configuration-key");
  } else if ([".md", ".mdx"].includes(extension)) {
    addMatches(symbols, content, /^#{1,6}\s+(.+)$/gm, "heading");
  }
  return { language, symbols, dependencies };
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crcTable();
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function extractZipEntries(buffer, limits = FILE_LIMITS) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length > limits.maxArchiveBytes) throw projectError("ZIP_LIMIT", "Compressed ZIP size limit exceeded", 413);
  const minEocd = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= minEocd; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw projectError("INVALID_ZIP", "ZIP end-of-directory record not found");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw projectError("ZIP64_UNSUPPORTED", "ZIP64 archives are not supported");
  if (entryCount > limits.maxArchiveEntries || centralOffset + centralSize > buffer.length) throw projectError("ZIP_LIMIT", "ZIP entry or directory limit exceeded");
  const entries = [];
  let offset = centralOffset;
  let expanded = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw projectError("INVALID_ZIP", "Malformed ZIP central directory");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd + extraLength + commentLength > buffer.length) throw projectError("INVALID_ZIP", "Truncated ZIP entry");
    const name = buffer.subarray(offset + 46, nameEnd).toString((flags & 0x800) ? "utf8" : "utf8");
    offset = nameEnd + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw projectError("ZIP_ENCRYPTED", "Encrypted ZIP entries are not supported");
    if (![0, 8].includes(method)) throw projectError("ZIP_METHOD", `Unsupported ZIP compression method ${method}`);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) throw projectError("ZIP_SYMLINK", "ZIP symlinks are not allowed");
    const relativePath = normalizeRelativePath(name);
    if (uncompressedSize > limits.maxArchiveExpandedBytes || (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio)) throw projectError("ZIP_BOMB", "Suspicious ZIP compression ratio or entry size");
    expanded += uncompressedSize;
    if (expanded > limits.maxArchiveExpandedBytes) throw projectError("ZIP_BOMB", "ZIP expanded size limit exceeded");
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw projectError("INVALID_ZIP", "Malformed ZIP local header");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw projectError("INVALID_ZIP", "Truncated ZIP data");
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: uncompressedSize + 1 });
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) throw projectError("INVALID_ZIP", "ZIP size or checksum mismatch");
    entries.push({ relativePath, data });
  }
  return entries;
}

function resolveDependencyTarget(sourcePath, reference, filesByPath) {
  const cleanRef = String(reference || "").split(/[?#]/)[0].replace(/\\/g, "/");
  if (!cleanRef) return null;
  const candidates = [];
  if (cleanRef.startsWith(".")) candidates.push(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), cleanRef)));
  else candidates.push(cleanRef.replace(/^\//, ""));
  const extensions = Object.keys(LANGUAGE_BY_EXTENSION);
  for (const base of [...candidates]) {
    candidates.push(`${base}/index`);
    for (const ext of extensions) candidates.push(`${base}${ext}`, `${base}/index${ext}`);
  }
  for (const candidate of candidates) if (filesByPath.has(candidate)) return filesByPath.get(candidate);
  const refName = path.posix.basename(cleanRef).replace(/\.[^.]+$/, "");
  for (const [filePath, id] of filesByPath) if (path.posix.basename(filePath).replace(/\.[^.]+$/, "") === refName) return id;
  return null;
}

async function resolveProjectDependencies(projectId) {
  const db = await getAdapter();
  const files = db.all("SELECT id, relativePath FROM projectFiles WHERE projectId=?", [projectId]);
  const filesByPath = new Map(files.map((file) => [file.relativePath, file.id]));
  const dependencies = db.all("SELECT id, sourceFileId, targetReference FROM projectFileDependencies WHERE projectId=?", [projectId]);
  const sourcePaths = new Map(files.map((file) => [file.id, file.relativePath]));
  db.transaction(() => {
    for (const dependency of dependencies) {
      const targetId = resolveDependencyTarget(sourcePaths.get(dependency.sourceFileId), dependency.targetReference, filesByPath);
      db.run("UPDATE projectFileDependencies SET targetFileId=?, updatedAt=? WHERE id=?", [targetId, new Date().toISOString(), dependency.id]);
    }
  });
}

function fileRow(row) {
  if (!row) return null;
  return {
    id: row.id, projectId: row.projectId, relativePath: row.relativePath, fileName: row.fileName,
    extension: row.extension, language: row.language, contentHash: row.contentHash,
    fileSize: row.fileSize, lastModified: row.lastModified, indexedAt: row.indexedAt,
    indexingStatus: row.indexingStatus, parserVersion: row.parserVersion,
    secretCount: row.secretCount, error: row.error, version: row.version,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    symbolCount: Number(row.symbolCount || 0), dependencyCount: Number(row.dependencyCount || 0),
  };
}

export async function indexProjectFile({ projectId, relativePath: rawPath, buffer, lastModified = null, sourceType = "upload", deferProjectFinalize = false }, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const relativePath = normalizeRelativePath(rawPath);
  const system = await getProjectSystemSettings();
  const projectSettings = await getProjectSettings(projectId, identity.principalId);
  if (!system.fileIndexingEnabled || !projectSettings.fileIndexingEnabled) throw projectError("FILE_INDEXING_DISABLED", "File indexing is disabled", 403);
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length > system.maxFileBytes) throw projectError("FILE_TOO_LARGE", `File exceeds ${system.maxFileBytes} bytes`, 413);
  const ignored = shouldIgnore(relativePath, projectSettings.ignoreRules);
  if (ignored.ignored) return { ignored: true, relativePath, reason: ignored.reason };
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (!LANGUAGE_BY_EXTENSION[extension] && !["Dockerfile", "Makefile"].includes(path.posix.basename(relativePath))) return { ignored: true, relativePath, reason: "unsupported-type" };
  if (isProbablyBinary(buffer)) return { ignored: true, relativePath, reason: "binary" };

  const db = await getAdapter();
  const totals = db.get("SELECT COUNT(*) AS count, COALESCE(SUM(fileSize),0) AS bytes FROM projectFiles WHERE projectId=?", [projectId]);
  const existing = db.get("SELECT * FROM projectFiles WHERE projectId=? AND relativePath=?", [projectId, relativePath]);
  if (!existing && totals.count >= system.maxFilesPerProject) throw projectError("FILE_LIMIT", "Project file count limit reached", 409);
  const nextBytes = Number(totals.bytes) - Number(existing?.fileSize || 0) + buffer.length;
  if (nextBytes > system.maxProjectBytes) throw projectError("PROJECT_STORAGE_LIMIT", "Project storage limit reached", 409);
  const contentHash = sha256(buffer);
  if (existing?.contentHash === contentHash && ["indexed", "updated"].includes(existing.indexingStatus)) return { ...fileRow(existing), unchanged: true };

  const decoded = buffer.toString("utf8");
  const redacted = redactSecrets(decoded);
  const parsed = parseSource(relativePath, redacted.text);
  const id = existing?.id || uuidv4();
  const now = new Date().toISOString();
  const storageDir = path.join(STORAGE_ROOT, projectId);
  const storagePath = projectSettings.retainSourceContent ? path.join(storageDir, `${id}.txt`) : null;
  if (storagePath) {
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(storagePath, redacted.text, { encoding: "utf8", mode: 0o600 });
  } else if (existing?.storagePath) {
    try { fs.unlinkSync(existing.storagePath); } catch { /* already absent */ }
  }

  db.transaction(() => {
    if (existing) {
      db.run(
        `UPDATE projectFiles SET fileName=?, extension=?, language=?, contentHash=?, fileSize=?, lastModified=?,
          indexedAt=?, indexingStatus='updated', parserVersion=?, redactedContent=?, storagePath=?, secretCount=?, error=NULL,
          version=version+1, updatedAt=? WHERE id=?`,
        [path.posix.basename(relativePath), extension, parsed.language, contentHash, buffer.length, lastModified,
          now, PARSER_VERSION, redacted.text.slice(0, FILE_LIMITS.maxStoredContentBytes), storagePath,
          redacted.findings.length, now, id],
      );
      db.run("DELETE FROM projectSymbols WHERE fileId=?", [id]);
      db.run("DELETE FROM projectFileDependencies WHERE sourceFileId=?", [id]);
    } else {
      db.run(
        `INSERT INTO projectFiles(id, projectId, relativePath, fileName, extension, language, contentHash, fileSize,
          lastModified, indexedAt, indexingStatus, parserVersion, redactedContent, storagePath, secretCount, version, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'indexed', ?, ?, ?, ?, 1, ?, ?)`,
        [id, projectId, relativePath, path.posix.basename(relativePath), extension, parsed.language, contentHash,
          buffer.length, lastModified, now, PARSER_VERSION, redacted.text.slice(0, FILE_LIMITS.maxStoredContentBytes),
          storagePath, redacted.findings.length, now, now],
      );
    }
    for (const symbol of parsed.symbols) {
      db.run(
        `INSERT INTO projectSymbols(id, projectId, fileId, symbolType, name, qualifiedName, lineStart, lineEnd, signature, metadata, createdAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), projectId, id, symbol.symbolType, symbol.name, symbol.qualifiedName, symbol.lineStart,
          symbol.lineEnd, symbol.signature, stringifyJson(symbol.metadata), now],
      );
    }
    for (const dependency of parsed.dependencies) {
      db.run(
        `INSERT OR IGNORE INTO projectFileDependencies(id, projectId, sourceFileId, targetReference, relationType,
          evidenceType, evidenceReference, confidence, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), projectId, id, dependency.targetReference, dependency.relationType, dependency.evidenceType,
          dependency.evidenceReference, dependency.confidence, now, now],
      );
    }
    upsertSearchDocumentInTransaction(db, {
      projectId, kind: "file", refId: id, title: relativePath,
      body: `${parsed.symbols.map((symbol) => symbol.name).join(" ")}\n${redacted.text.slice(0, 100_000)}`,
    });
    const fileEntity = upsertEntityInTransaction(db, {
      projectId, entityType: "file", name: relativePath,
      metadata: { fileId: id, language: parsed.language, contentHash },
      sourceType: "imported-file", confidence: 1,
    });
    for (const symbol of parsed.symbols.slice(0, 500)) {
      const symbolEntity = upsertEntityInTransaction(db, {
        projectId, entityType: symbol.symbolType, name: symbol.name,
        metadata: { fileId: id, relativePath, lineStart: symbol.lineStart },
        sourceType: "imported-file", confidence: 1,
      });
      if (fileEntity && symbolEntity) upsertRelationInTransaction(db, {
        projectId, fromEntityId: fileEntity.id, toEntityId: symbolEntity.id,
        relationType: "DEFINES", evidenceType: "static-parser",
        evidenceReference: `${relativePath}:${symbol.lineStart}`, confidence: 1,
      });
    }
  });
  if (!deferProjectFinalize) {
    await resolveProjectDependencies(projectId);
    await touchProject(projectId);
  }
  return getProjectFile(projectId, id, identity.principalId);
}

async function importProjectZipUnlocked({ projectId, buffer, sourceName = "archive.zip" }, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const entries = extractZipEntries(buffer);
  const gitignore = entries.find((entry) => entry.relativePath === ".gitignore");
  let rules = [];
  if (gitignore && !isProbablyBinary(gitignore.data)) rules = gitignore.data.toString("utf8").split(/\r?\n/).filter(Boolean).slice(0, 500);
  const results = [];
  for (const entry of entries) {
    if (shouldIgnore(entry.relativePath, rules).ignored) {
      results.push({ ignored: true, relativePath: entry.relativePath, reason: "gitignore" });
      continue;
    }
    try {
      results.push(await indexProjectFile({
        projectId,
        relativePath: entry.relativePath,
        buffer: entry.data,
        sourceType: `zip:${sourceName}`,
        deferProjectFinalize: true,
      }, identity));
    } catch (error) {
      results.push({ relativePath: entry.relativePath, error: error.message, code: error.code || "INDEX_ERROR" });
    }
  }
  if (results.some((item) => item?.indexingStatus && !item?.unchanged && !item?.error)) {
    await resolveProjectDependencies(projectId);
    await touchProject(projectId);
  }
  return {
    total: entries.length,
    indexed: results.filter((item) => item?.indexingStatus && !item.error).length,
    ignored: results.filter((item) => item?.ignored).length,
    failed: results.filter((item) => item?.error).length,
    results,
  };
}

export async function importProjectZip(options, identity) {
  const previous = projectImportLocks.get(options.projectId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  projectImportLocks.set(options.projectId, current);
  await previous;
  try {
    return await importProjectZipUnlocked(options, identity);
  } finally {
    release();
    if (projectImportLocks.get(options.projectId) === current) projectImportLocks.delete(options.projectId);
  }
}

export async function listProjectFiles(projectId, principalId, { q = "", status = "", limit = 200, offset = 0 } = {}) {
  await requireProjectRole(projectId, principalId);
  const db = await getAdapter();
  const where = ["pf.projectId=?"];
  const params = [projectId];
  if (status) { where.push("pf.indexingStatus=?"); params.push(status); }
  if (q) {
    const term = `%${String(q).slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(pf.relativePath LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM projectSymbols ps WHERE ps.fileId=pf.id AND ps.name LIKE ? ESCAPE '\\'))");
    params.push(term, term);
  }
  params.push(Math.max(1, Math.min(Number(limit) || 200, 1000)), Math.max(0, Number(offset) || 0));
  return db.all(
    `SELECT pf.*,
      (SELECT COUNT(*) FROM projectSymbols ps WHERE ps.fileId=pf.id) AS symbolCount,
      (SELECT COUNT(*) FROM projectFileDependencies pd WHERE pd.sourceFileId=pf.id OR pd.targetFileId=pf.id) AS dependencyCount
     FROM projectFiles pf WHERE ${where.join(" AND ")} ORDER BY pf.updatedAt DESC LIMIT ? OFFSET ?`,
    params,
  ).map(fileRow);
}

export async function getProjectFile(projectId, fileId, principalId) {
  await requireProjectRole(projectId, principalId);
  const db = await getAdapter();
  const row = db.get(
    `SELECT pf.*,
      (SELECT COUNT(*) FROM projectSymbols ps WHERE ps.fileId=pf.id) AS symbolCount,
      (SELECT COUNT(*) FROM projectFileDependencies pd WHERE pd.sourceFileId=pf.id OR pd.targetFileId=pf.id) AS dependencyCount
     FROM projectFiles pf WHERE pf.projectId=? AND pf.id=?`,
    [projectId, fileId],
  );
  if (!row) throw projectError("FILE_NOT_FOUND", "File not found", 404);
  return {
    ...fileRow(row),
    symbols: db.all("SELECT id, symbolType, name, qualifiedName, lineStart, lineEnd, signature, metadata FROM projectSymbols WHERE fileId=? ORDER BY lineStart LIMIT 2000", [fileId]).map((item) => ({ ...item, metadata: parseJson(item.metadata, {}) })),
  };
}

export async function getRelatedFiles(projectId, fileId, principalId, depth = 1) {
  await requireProjectRole(projectId, principalId);
  const db = await getAdapter();
  const source = db.get("SELECT id, relativePath FROM projectFiles WHERE projectId=? AND id=?", [projectId, fileId]);
  if (!source) throw projectError("FILE_NOT_FOUND", "File not found", 404);
  const maxDepth = Math.max(1, Math.min(Number(depth) || 1, 4));
  const seen = new Set([fileId]);
  let frontier = [fileId];
  const relationships = [];
  for (let level = 1; level <= maxDepth && frontier.length; level += 1) {
    const placeholders = frontier.map(() => "?").join(",");
    const rows = db.all(
      `SELECT d.*, sf.relativePath AS sourcePath, tf.relativePath AS targetPath
       FROM projectFileDependencies d JOIN projectFiles sf ON sf.id=d.sourceFileId
       LEFT JOIN projectFiles tf ON tf.id=d.targetFileId
       WHERE d.projectId=? AND (d.sourceFileId IN (${placeholders}) OR d.targetFileId IN (${placeholders}))`,
      [projectId, ...frontier, ...frontier],
    );
    const next = [];
    for (const row of rows) {
      relationships.push({ ...row, depth: level });
      for (const id of [row.sourceFileId, row.targetFileId]) if (id && !seen.has(id)) { seen.add(id); next.push(id); }
    }
    frontier = [...new Set(next)];
  }
  const relatedIds = [...seen].filter((id) => id !== fileId);
  const files = relatedIds.length ? db.all(`SELECT id, relativePath, language, indexingStatus FROM projectFiles WHERE projectId=? AND id IN (${relatedIds.map(() => "?").join(",")})`, [projectId, ...relatedIds]) : [];
  return { source, files, relationships };
}

export async function removeProjectFile(projectId, fileId, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  const row = db.get("SELECT storagePath, relativePath FROM projectFiles WHERE projectId=? AND id=?", [projectId, fileId]);
  if (!row) return false;
  db.transaction(() => {
    const entityIds = db.all("SELECT id, metadata FROM memoryEntities WHERE projectId=?", [projectId])
      .filter((entity) => parseJson(entity.metadata, {}).fileId === fileId)
      .map((entity) => entity.id);
    if (entityIds.length) {
      db.run(`DELETE FROM memoryEntities WHERE projectId=? AND id IN (${entityIds.map(() => "?").join(",")})`, [projectId, ...entityIds]);
    }
    db.run("DELETE FROM projectFiles WHERE projectId=? AND id=?", [projectId, fileId]);
    removeSearchDocumentInTransaction(db, projectId, "file", fileId);
  });
  if (row.storagePath && path.dirname(row.storagePath) === path.join(STORAGE_ROOT, projectId)) {
    try { fs.unlinkSync(row.storagePath); } catch { /* already absent */ }
  }
  await resolveProjectDependencies(projectId);
  await touchProject(projectId);
  return true;
}

export async function reindexProjectFile(projectId, fileId, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  const row = db.get("SELECT * FROM projectFiles WHERE projectId=? AND id=?", [projectId, fileId]);
  if (!row) throw projectError("FILE_NOT_FOUND", "File not found", 404);
  if (!row.storagePath || !fs.existsSync(row.storagePath)) throw projectError("SOURCE_NOT_RETAINED", "A retained source snapshot is required to re-index", 409);
  const buffer = fs.readFileSync(row.storagePath);
  db.run("UPDATE projectFiles SET contentHash='', indexingStatus='processing', updatedAt=? WHERE id=?", [new Date().toISOString(), fileId]);
  return indexProjectFile({ projectId, relativePath: row.relativePath, buffer, lastModified: row.lastModified, sourceType: "reindex" }, identity);
}

export async function cancelProjectFileIndexing(projectId, fileId, identity) {
  await requireProjectRole(projectId, identity.principalId, ["owner", "editor"]);
  const db = await getAdapter();
  const result = db.run("UPDATE projectFiles SET indexingStatus='ignored', error='Cancelled by user', updatedAt=? WHERE projectId=? AND id=? AND indexingStatus IN ('pending','processing')", [new Date().toISOString(), projectId, fileId]);
  return (result?.changes || 0) > 0;
}

export const __test__ = {
  isProbablyBinary, shouldIgnore, resolveDependencyTarget, crc32, LANGUAGE_BY_EXTENSION,
};
