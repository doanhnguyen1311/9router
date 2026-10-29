// Conservative policy catalogue: generic reasoning:true is not a verified effort enum.
// Sources and limitations: docs/key-effort/README.md. Legacy client behavior is unchanged.
import { getCapabilitiesForModel } from './capabilities.js';
import { getProviderModels } from '../config/providerModels.js';
import { resolveKiroEffortPath } from '../config/kiroConstants.js';
import { stripThinkingSuffix } from '../translator/concerns/thinkingUnified.js';
import { LEVEL_TO_BUDGET } from '../translator/concerns/thinking.js';

const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
const FOUR = ['low', 'medium', 'high', 'max'];
const SUPPORTED_PROVIDERS = new Set(['openai', 'codex', 'claude', 'anthropic', 'gemini', 'gemini-cli', 'antigravity', 'kiro', 'kilocode', 'openrouter', 'deepseek', 'glm', 'kimi', 'minimax', 'minimax-code', 'minimax-code-global', 'xai', 'alicode', 'alicode-intl', 'alims-intl', 'alitp-intl']);
const GATEWAYS = new Set(['kilocode', 'openrouter']);
const unknown = reason => ({ kind: 'unknown', levels: [], reason, verified: false });

export function normalizeEffortModel(model) {
  return stripThinkingSuffix(model.replace(/\[1m\]$/i, '')).replace(/\[1m\]$/i, '');
}

export function getEffortCapabilities(provider, model) {
  const base = normalizeEffortModel(model);
  const id = base.toLowerCase().replaceAll('.', '-').split('/').at(-1);
  const caps = getCapabilitiesForModel(provider, base);
  if (!SUPPORTED_PROVIDERS.has(provider)) return unknown('No verified effort contract for this provider');
  if (provider === 'kiro' && !resolveKiroEffortPath(base)) return unknown('This Kiro model has no supported effort field');
  const level = (levels, native) => ({ kind: 'level', levels, native, verified: true });
  const toggle = (canDisable, native = 'thinking') => ({ kind: 'toggle', levels: canDisable ? ['none', 'thinking'] : ['thinking'], native, verified: true });
  const budget = (levels, min, max, canDisable, native) => ({
    kind: 'budget', levels: levels.filter(v => v === 'none' ? canDisable : LEVEL_TO_BUDGET[v] >= min && LEVEL_TO_BUDGET[v] <= max),
    native, budgets: Object.fromEntries(levels.filter(v => v !== 'none').map(v => [v, LEVEL_TO_BUDGET[v]])), verified: true,
  });
  let result;
  if (/^gpt-(?:6-(?:astra|sol|luna)|6-1-(?:sol|terra))(?:-review)?$/.test(id)) {
    const entry = provider === 'codex' ? getProviderModels('cx').find(m => m.id === model) : null;
    result = level(provider === 'codex' || /astra|6-1-sol/.test(id) ? [...FIVE] : ['none', ...FIVE], 'openai');
    if (entry?.thinkingLevels) result.levels = result.levels.filter(l => entry.thinkingLevels.includes(l));
  } else if (/^gpt-5-6-(sol|terra|luna)/.test(id)) result = level(provider === 'kiro' ? ['low', 'medium', 'high', 'xhigh'] : ['none', ...FIVE], 'openai');
  else if (/^gpt-5.*codex/.test(id)) result = level(['low', 'medium', 'high', 'xhigh'], 'openai');
  else if (/^gpt-5-(2|4|5)(?:-|$)/.test(id)) result = level(['none', 'low', 'medium', 'high', 'xhigh'], 'openai');
  else if (/^gpt-5-1(?:-|$)/.test(id)) result = level(['none', 'low', 'medium', 'high'], 'openai');
  else if (/^gpt-5(?:-(mini|nano))?$/.test(id)) result = level(['minimal', 'low', 'medium', 'high'], 'openai');
  else if (/^(o1|o3|o4-mini)(?:-|$)/.test(id) && !/pro|deep-research|^o1-(mini|preview)/.test(id)) result = level(['low', 'medium', 'high'], 'openai');
  else if (/^claude-/.test(id)) {
    if (/-(opus|sonnet)-4-6(?:-|$)/.test(id)) result = level([...FOUR], 'claude');
    else if (/-(opus|sonnet|haiku|fable|mythos)-(5(?:-|$)|4-[78](?:-|$))/.test(id)) result = level([...FIVE], 'claude');
    else if (/-(opus|sonnet|haiku)-(4(?:-|$)|3-7)/.test(id)) result = budget(['none', 'low', 'medium', 'high', 'xhigh', 'max'], caps.thinkingRange?.min ?? 1024, caps.thinkingRange?.max ?? 64000, true, 'claude');
  } else if (/^gemini-/.test(id)) {
    if (/^gemini-(4|3-[78])/.test(id) || /^gemini-3-1-pro/.test(id)) result = level(['low', 'medium', 'high'], 'gemini');
    else if (/^gemini-3-pro/.test(id)) result = level(['low', 'high'], 'gemini');
    else if (/^gemini-3/.test(id)) result = level(/flash-lite-image/.test(id) ? ['minimal', 'high'] : ['minimal', 'low', 'medium', 'high'], 'gemini');
    else if (/^gemini-2-5/.test(id)) result = budget(['none', 'low', 'medium', 'high', 'xhigh'], /pro/.test(id) ? 128 : 512, /pro/.test(id) ? 32768 : 24576, !/pro/.test(id), 'gemini');
  } else if (/^deepseek-(v4|flash)/.test(id)) result = level(['none', 'low', 'high', 'max'], 'deepseek');
  else if (/^glm-5-3/.test(id)) result = level(['low', 'high', 'max'], 'zai');
  else if (/^glm-5-2/.test(id)) result = level(['none', 'high', 'max'], 'zai');
  else if (/^glm-(?:5(?:-1|-turbo)?|4-[67]v?)(?:-flash|-thinking)?$/.test(id)) result = toggle(true, 'zai');
  else if (/^(kimi-)?k3/.test(id)) result = level(['low', 'high', 'max'], 'kimi');
  else if (/^kimi-k2-[56](?:-|$)/.test(id)) result = toggle(!/thinking|code/.test(id));
  else if (/^minimax-m3-1/.test(id)) result = level([...FIVE], 'claude');
  else if (/^minimax-m[23]/.test(id)) result = toggle(/^minimax-m3$/.test(id), 'minimax');
  else if (/^qwen3-8/.test(id)) result = level(['none', 'low', 'medium', 'xhigh'], 'qwen');
  else if (/^qwen3/.test(id)) result = budget(['none', 'low', 'medium', 'high'], caps.thinkingRange?.min ?? 1, caps.thinkingRange?.max ?? 32768, !/thinking/.test(id), 'qwen');
  else if (/^grok-4-[67]/.test(id)) result = level(['low', 'medium', 'high', 'xhigh'], 'openai');
  else if (/^grok-4-5/.test(id)) result = level(['low', 'medium', 'high'], 'openai');
  if (!result) return unknown('No verified effort levels for this model');
  if (GATEWAYS.has(provider)) result = { ...result, native: 'openrouter', gateway: true };
  return result;
}
