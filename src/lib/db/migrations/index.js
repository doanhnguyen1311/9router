// Migration registry — append new entries when schema changes.
// Each migration: { version: number, name: string, up(db): void }
// Versions MUST be unique and monotonically increasing.
import m001 from "./001-initial.js";
import m002 from "./002-project-memory.js";
import m003 from "./003-project-constraints.js";
import m004 from "./004-protect-usage-api-keys.js";
import m005 from "./005-planning-foundation.js";
import m006 from "./006-planning-approval.js";
import m007 from "./007-codex-execution.js";
import m008 from "./008-chatgpt-connector.js";
import m009 from "./009-automatic-planning-orchestration.js";
import m010 from "./010-planning-self-service.js";

export const MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010].sort((a, b) => a.version - b.version);

export function latestVersion() {
  return MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
}
