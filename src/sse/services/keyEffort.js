import { KEY_EFFORT_DEFAULT } from '@/shared/utils/keyEffort.js';
import { stripThinkingSuffix, extractThinking, parseSuffix } from 'open-sse/translator/concerns/thinkingUnified.js';
import { getEffortCapabilities, normalizeEffortModel } from 'open-sse/providers/effortCapabilities.js';

const requests = globalThis.__keyEffortRequests ||= new WeakMap();
export function setKeyEffortPolicy(request, policy) { requests.set(request, policy || KEY_EFFORT_DEFAULT); }
export function getKeyEffortPolicy(request) { return request ? requests.get(request) || KEY_EFFORT_DEFAULT : KEY_EFFORT_DEFAULT; }
export function effortRoutingModel(model, policy) { return policy.allowUserChoice ? model : stripThinkingSuffix(model); }

export function resolveKeyEffort(policy, body, provider, model) {
  if (policy.invalid) return { error: 'API key effort policy is invalid; contact the administrator' };
  const selected = policy.overrides?.find(o => o.model.toLowerCase() === `${provider}/${normalizeEffortModel(model)}`.toLowerCase())?.effort || policy.effort;
  if (!selected) return { effort: null };
  if (policy.allowUserChoice && (extractThinking(body) || extractThinking(body.params) || body.reasoning?.enabled !== undefined || body.reasoning?.max_tokens !== undefined || parseSuffix(model).override || body.previous_response_id || body.conversation || body.input?.some?.(item => item?.type === 'configuration_update') || body.messages?.some?.(item => item?.output_config?.effort !== undefined || item?.reasoning?.effort !== undefined))) return { effort: null };
  const capability = getEffortCapabilities(provider, model);
  if (!capability.levels.includes(selected)) return { error: `Effort "${selected}" is not supported for ${provider}/${model}. Supported: ${capability.levels.join(', ') || 'not verified'}` };
  return { effort: selected };
}
