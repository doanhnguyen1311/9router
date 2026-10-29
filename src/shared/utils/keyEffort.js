// Pure policy contract shared by the DB, management API and dashboard.
export const KEY_EFFORT_VALUES = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'thinking']);
export const KEY_EFFORT_DEFAULT = Object.freeze({ allowUserChoice: true, effort: null, overrides: Object.freeze([]) });
const MAX_OVERRIDES = 50;

export function validateKeyEffortPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'effortPolicy must be an object' };
  if (Object.keys(value).some(k => !['allowUserChoice', 'effort', 'overrides'].includes(k))) return { ok: false, error: 'Unknown effort policy field' };
  if (typeof value.allowUserChoice !== 'boolean') return { ok: false, error: 'allowUserChoice must be a boolean' };
  const effort = value.effort ?? null;
  if (effort !== null && !KEY_EFFORT_VALUES.includes(effort)) return { ok: false, error: 'Invalid effort level' };
  if (!value.allowUserChoice && effort === null) return { ok: false, error: 'Admin-locked keys require a default effort' };
  const overrides = value.overrides ?? [];
  if (!Array.isArray(overrides) || overrides.length > MAX_OVERRIDES) return { ok: false, error: 'At most 50 model effort overrides are allowed' };
  const seen = new Set(), normalized = [];
  for (const item of overrides) {
    if (!item || Object.keys(item).some(k => !['model', 'effort'].includes(k)) || typeof item.model !== 'string' || item.model.length > 256 || !item.model.includes('/') || !KEY_EFFORT_VALUES.includes(item.effort)) return { ok: false, error: 'Each override requires provider/model and a valid effort' };
    const model = item.model.trim();
    if (!model || seen.has(model.toLowerCase())) return { ok: false, error: 'Duplicate model effort override' };
    seen.add(model.toLowerCase()); normalized.push({ model, effort: item.effort });
  }
  return { ok: true, value: { allowUserChoice: value.allowUserChoice, effort, overrides: normalized } };
}

export function keyEffortFromColumn(column) {
  if (column == null || column === '') return { ...KEY_EFFORT_DEFAULT, overrides: [] };
  try {
    const checked = validateKeyEffortPolicy(typeof column === 'string' ? JSON.parse(column) : column);
    if (checked.ok) return checked.value;
  } catch { /* corrupt stored restrictions must not grant client control */ }
  return { allowUserChoice: false, effort: null, overrides: [], invalid: true };
}
