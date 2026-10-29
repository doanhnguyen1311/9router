import { validateKeyEffortPolicy } from '@/shared/utils/keyEffort.js';
import { getModelInfo } from '@/sse/services/model.js';
import { getEffortCapabilities, normalizeEffortModel } from 'open-sse/providers/effortCapabilities.js';

export async function normalizeKeyEffortPolicy(value) {
  const checked = validateKeyEffortPolicy(value);
  if (!checked.ok) return checked;
  const overrides = [], seen = new Set();
  for (const entry of checked.value.overrides) {
    const { provider, model } = await getModelInfo(normalizeEffortModel(entry.model));
    if (!provider) return { ok: false, error: 'Effort overrides must name a concrete provider/model, not a combo' };
    const target = `${provider}/${normalizeEffortModel(model)}`;
    if (seen.has(target.toLowerCase())) return { ok: false, error: 'Duplicate resolved effort override' };
    const cap = getEffortCapabilities(provider, model);
    if (!cap.levels.includes(entry.effort)) return { ok: false, error: `Effort "${entry.effort}" is not supported for ${target}` };
    seen.add(target.toLowerCase()); overrides.push({ model: target, effort: entry.effort });
  }
  return { ok: true, value: { ...checked.value, overrides } };
}
