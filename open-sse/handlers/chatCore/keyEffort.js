import { buildKiroAdditionalModelRequestFieldsForModel } from "../../config/kiroConstants.js";
import { getEffortCapabilities } from '../../providers/effortCapabilities.js';
import { stripThinkingSuffix } from '../../translator/concerns/thinkingUnified.js';

const TOP_CONTROLS = ['reasoning_effort', 'thinking', 'thinkingConfig', 'enable_thinking', 'thinking_budget'];
function cleanControls(body, depth = 0) {
  if (depth > 2) throw new Error("Nested effort control containers are not supported");
  const out = { ...body };
  for (const key of TOP_CONTROLS) delete out[key];
  if (out.reasoning && typeof out.reasoning === 'object') {
    out.reasoning = { ...out.reasoning };
    for (const key of ['effort', 'max_tokens', 'enabled']) delete out.reasoning[key];
  }
  if (out.output_config && typeof out.output_config === 'object') { out.output_config = { ...out.output_config }; delete out.output_config.effort; }
  if (out.generationConfig) { out.generationConfig = { ...out.generationConfig }; delete out.generationConfig.thinkingConfig; }
  if (out.request) { out.request = { ...out.request }; if (out.request.generationConfig) { out.request.generationConfig = { ...out.request.generationConfig }; delete out.request.generationConfig.thinkingConfig; } }
  if (out.params) { out.params = { ...out.params }; for (const k of TOP_CONTROLS) delete out.params[k]; delete out.params.reasoning; }
  for (const field of ['messages', 'input']) if (Array.isArray(out[field])) {
    const original = out[field];
    let items = null;
    for (let i = 0; i < original.length; i++) {
      const item = original[i];
      if (item?.type === 'configuration_update') {
        const cleaned = cleanControls(item, depth + 1);
        for (const key of ['reasoning', 'output_config', 'params', 'generationConfig']) {
          if (cleaned[key] && !Object.keys(cleaned[key]).length) delete cleaned[key];
        }
        items ||= original.slice(0, i);
        if (Object.keys(cleaned).some(key => !['type', 'id'].includes(key))) items.push(cleaned);
        continue;
      }
      if (item?.output_config?.effort !== undefined || item?.reasoning?.effort !== undefined) {
        items ||= original.slice(0, i); items.push(cleanControls(item, depth + 1));
      } else if (items) items.push(item);
    }
    if (items) out[field] = items;
  }
  return out;
}

export function prepareKeyEffort(body, effort) {
  if (body.previous_response_id || body.conversation) throw new Error('Admin-locked effort requires explicit conversation messages; stored conversation effort cannot be verified');
  const out = { ...cleanControls(body), model: stripThinkingSuffix(body.model), reasoning_effort: effort };
  if (body.thinking?.display) out.thinking = { type: 'adaptive', display: body.thinking.display };
  return out;
}

// Reapply after translation/token savers, including native passthrough. No DB or I/O.
export function applyKeyEffort(body, provider, model, format, effort) {
  const cap = getEffortCapabilities(provider, model);
  if (!cap.levels.includes(effort)) throw new Error(`Effort "${effort}" is not supported for ${provider}/${model}`);
  const out = cleanControls(body);
  const none = effort === 'none', budget = cap.budgets?.[effort];
  if (cap.native === 'openrouter') {
    out.reasoning = cap.kind === 'toggle' ? { enabled: !none } : cap.kind === 'budget'
      ? (none ? { enabled: false } : { max_tokens: budget, enabled: true })
      : (none ? { enabled: false } : { effort });
  } else if (provider === 'codex' || format === 'openai-responses') {
    out.reasoning = { ...(out.reasoning || {}), effort };
  } else if (format === 'kiro') {
    const fields = buildKiroAdditionalModelRequestFieldsForModel({ reasoning_effort: effort }, model);
    if (!fields) throw new Error('Kiro cannot apply the selected effort');
    out.additionalModelRequestFields = fields;
  } else if (cap.native === 'gemini' && ['gemini', 'gemini-cli', 'antigravity', 'vertex'].includes(format)) {
    const tc = cap.kind === 'budget' ? { thinkingBudget: none ? 0 : budget } : { thinkingLevel: effort };
    const target = out.request || out;
    target.generationConfig = { ...(target.generationConfig || {}), thinkingConfig: tc };
  } else if (cap.native === 'claude' && format === 'claude') {
    if (cap.kind === 'budget') {
      if (!none && Number.isFinite(out.max_tokens) && budget >= out.max_tokens) throw new Error('Locked thinking budget must be smaller than max_tokens');
      out.thinking = none ? { type: 'disabled' } : { type: 'enabled', budget_tokens: budget };
    } else { out.thinking = { type: 'adaptive', ...(body.thinking?.display ? { display: body.thinking.display } : {}) }; out.output_config = { ...(out.output_config || {}), effort }; }
  } else if (cap.native === 'deepseek' || cap.native === 'zai' || cap.native === 'kimi') {
    if (cap.kind !== 'toggle' && !(cap.native === 'zai' && none)) out.reasoning_effort = effort;
    if (cap.native === 'deepseek') out.thinking = { type: none ? 'disabled' : 'enabled' };
    if (cap.native === 'zai') {
      if (none) out.enable_thinking = false;
      else out.thinking = { type: 'enabled' };
    }
  } else if (cap.kind === 'toggle') {
    out.thinking = { type: none ? 'disabled' : cap.native === 'minimax' ? 'adaptive' : 'enabled' };
  } else if (cap.kind === 'budget' && cap.native === 'qwen') {
    out.enable_thinking = !none;
    if (!none) out.thinking_budget = budget;
  } else {
    out.reasoning_effort = effort;
    if (cap.native === 'qwen') out.enable_thinking = !none;
  }
  return out;
}
