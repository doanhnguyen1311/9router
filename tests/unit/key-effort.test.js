import { describe, it, expect } from 'vitest';
import { validateKeyEffortPolicy, keyEffortFromColumn } from '../../src/shared/utils/keyEffort.js';
import { getEffortCapabilities } from '../../open-sse/providers/effortCapabilities.js';
import { prepareKeyEffort, applyKeyEffort } from '../../open-sse/handlers/chatCore/keyEffort.js';
import { resolveKeyEffort, effortRoutingModel } from '../../src/sse/services/keyEffort.js';
const lock = (effort = 'high', overrides = []) => ({ allowUserChoice: false, effort, overrides });

describe('per-key effort contract', () => {
  it('preserves old/new key defaults and fails closed on corrupt policies', () => {
    expect(keyEffortFromColumn(null)).toEqual({ allowUserChoice: true, effort: null, overrides: [] });
    for (const raw of ['broken', '{}', '{"allowUserChoice":false}']) expect(keyEffortFromColumn(raw)).toMatchObject({ allowUserChoice: false, invalid: true });
    expect(keyEffortFromColumn(JSON.stringify(lock()))).toEqual(lock());
  });
  it.each([{ allowUserChoice: false }, { allowUserChoice: 'yes' }, { allowUserChoice: false, effort: 'auto' }, { allowUserChoice: true, effort: 'ultra' }, { allowUserChoice: true, admin: true }, { ...lock(), overrides: [{ model: 'combo', effort: 'high' }] }])('rejects invalid policy %j', input => {
    expect(validateKeyEffortPolicy(input).ok).toBe(false);
  });
  it('bounds and rejects duplicate model overrides', () => {
    expect(validateKeyEffortPolicy(lock('high', Array.from({ length: 51 }, (_, i) => ({ model: 'codex/m' + i, effort: 'low' })))).ok).toBe(false);
    expect(validateKeyEffortPolicy(lock('high', [{ model: 'codex/m', effort: 'low' }, { model: 'CODEX/M', effort: 'high' }])).ok).toBe(false);
  });
  it.each([
    ['codex', 'gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['codex', 'gpt-6.1-terra', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['openai', 'gpt-6.1-terra', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gemini', 'gemini-3.1-pro-preview', ['low', 'medium', 'high']],
    ['gemini', 'gemini-3.8-flash', ['low', 'medium', 'high']],
    ['glm', 'glm-5.3', ['low', 'high', 'max']],
    ['kimi', 'kimi-k3', ['low', 'high', 'max']],
    ['kilocode', 'moonshotai/kimi-k3.1-pro', ['low', 'high', 'max']],
    ['deepseek', 'deepseek-v4-pro', ['none', 'low', 'high', 'max']],
    ['anthropic', 'claude-sonnet-4-6', ['low', 'medium', 'high', 'max']],
  ])('uses verified levels for %s/%s', (provider, model, levels) => expect(getEffortCapabilities(provider, model).levels).toEqual(levels));
  it('does not guess levels for unknown/custom/non-reasoning models', () => {
    expect(getEffortCapabilities('unknown', 'gpt-6.1-sol').levels).toEqual([]);
    expect(getEffortCapabilities('openai', 'gpt-4.1').levels).toEqual([]);
    expect(getEffortCapabilities('kilocode', 'private/new-model').levels).toEqual([]);
    expect(getEffortCapabilities('glm', 'glm-unknown').levels).toEqual([]);
    expect(getEffortCapabilities('openai', 'o1-mini').levels).toEqual([]);
  });
  it('distinguishes native effort from token budget presets and disallows Gemini Pro thinking-off', () => {
    expect(getEffortCapabilities('gemini', 'gemini-2.5-pro')).toMatchObject({ kind: 'budget', levels: ['low', 'medium', 'high', 'xhigh'] });
    expect(getEffortCapabilities('gemini', 'gemini-2.5-flash').levels).not.toContain('xhigh');
    expect(getEffortCapabilities('anthropic', 'claude-sonnet-4-20250514').kind).toBe('budget');
  });
  it('locks per key, preserves client choice when allowed and revalidates every fallback target', () => {
    const body = { reasoning_effort: 'max' };
    expect(resolveKeyEffort(lock('low'), body, 'codex', 'gpt-6.1-sol').effort).toBe('low');
    expect(resolveKeyEffort({ allowUserChoice: true, effort: 'low' }, body, 'codex', 'gpt-6.1-sol').effort).toBeNull();
    expect(resolveKeyEffort(lock('medium'), body, 'kimi', 'kimi-k3').error).toContain('not supported');
    expect(resolveKeyEffort(lock('medium', [{ model: 'kimi/kimi-k3', effort: 'low' }]), body, 'kimi', 'kimi-k3').effort).toBe('low');
    expect(effortRoutingModel('cx/gpt-6.1-sol(max)', lock('low'))).toBe('cx/gpt-6.1-sol');
  });
  it('preserves explicit gateway controls and skips collection work for an unconfigured policy', () => {
    for (const body of [{ reasoning: { enabled: false } }, { reasoning: { max_tokens: 5000 } }, { params: { reasoning_effort: 'low' } }]) {
      expect(resolveKeyEffort({ allowUserChoice: true, effort: 'high' }, body, 'kilocode', 'openai/gpt-5.4').effort).toBeNull();
    }
    const body = { get messages() { throw new Error('should not inspect messages'); } };
    expect(resolveKeyEffort({ allowUserChoice: true, effort: null }, body, 'unknown', 'custom').effort).toBeNull();
  });
});

describe('effort enforcement across protocol control fields', () => {
  it('removes body/suffix/budget/per-message controls without cloning message content or changing source', () => {
    const user = { role: 'user', content: 'keep tools and source code' };
    const body = { model: 'gpt-6.1-sol(max)', reasoning: { effort: 'max', summary: 'auto', max_tokens: 999999, enabled: false }, thinking: { type: 'enabled', budget_tokens: 999999 }, output_config: { effort: 'max', format: { type: 'json_schema' } }, generationConfig: { thinkingConfig: { thinkingLevel: 'high' }, temperature: 1 }, input: [{ type: 'configuration_update', reasoning: { effort: 'max' } }, user], messages: [{ role: 'assistant', content: 'ok', output_config: { effort: 'max' } }, user] };
    const out = prepareKeyEffort(body, 'low');
    expect(out.model).toBe('gpt-6.1-sol'); expect(out.reasoning_effort).toBe('low');
    expect(out.reasoning).toEqual({ summary: 'auto' }); expect(out.output_config).toEqual({ format: { type: 'json_schema' } });
    expect(out.generationConfig).toEqual({ temperature: 1 }); expect(out.input).toEqual([user]); expect(out.input[0]).toBe(user);
    expect(out.messages[0].output_config).not.toHaveProperty('effort'); expect(out.messages[1]).toBe(user);
    expect(body.model).toContain('(max)'); expect(body.input).toHaveLength(2);
  });
  it('refuses opaque stored conversation state that could contain effort updates', () => {
    expect(() => prepareKeyEffort({ previous_response_id: 'resp_old' }, 'high')).toThrow('explicit conversation');
    expect(() => prepareKeyEffort({ conversation: 'conv_old' }, 'high')).toThrow('explicit conversation');
  });
  it('preserves unrelated structured output configuration in conversation updates', () => {
    const update = { type: 'configuration_update', reasoning: { effort: 'max', summary: 'auto' }, text: { format: { type: 'json_object' } } };
    const out = prepareKeyEffort({ input: [update] }, 'low');
    expect(out.input).toEqual([{ type: 'configuration_update', reasoning: { summary: 'auto' }, text: update.text }]);
    expect(update.reasoning.effort).toBe('max');
  });
  it('keeps Codex reasoning metadata but forces the exact supported effort', () => {
    expect(applyKeyEffort({ model: 'gpt-6.1-sol', reasoning: { effort: 'max', summary: 'auto' } }, 'codex', 'gpt-6.1-sol', 'openai-responses', 'low').reasoning).toEqual({ effort: 'low', summary: 'auto' });
  });
  it('sends the correct Kilo gateway shape and native DeepSeek low without silent conversion', () => {
    expect(applyKeyEffort({}, 'kilocode', 'moonshotai/kimi-k3', 'openai', 'low')).toEqual({ reasoning: { effort: 'low' } });
    expect(applyKeyEffort({}, 'deepseek', 'deepseek-v4-pro', 'openai', 'low').reasoning_effort).toBe('low');
    expect(applyKeyEffort({}, 'kilocode', 'z-ai/glm-4.7', 'openai', 'thinking')).toEqual({ reasoning: { enabled: true } });
    expect(applyKeyEffort({}, 'glm', 'glm-4.7', 'openai', 'none')).toEqual({ enable_thinking: false });
    expect(applyKeyEffort({}, 'glm', 'glm-5.3', 'openai', 'low')).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  });
  it('enforces Anthropic/Gemini fields and preserves output schemas', () => {
    const out = applyKeyEffort({ output_config: { format: { type: 'json_schema' }, effort: 'max' } }, 'anthropic', 'claude-sonnet-4-6', 'claude', 'low');
    expect(out.output_config).toEqual({ format: { type: 'json_schema' }, effort: 'low' });
    expect(applyKeyEffort({}, 'gemini', 'gemini-3.1-pro-preview', 'gemini', 'low').generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    expect(() => applyKeyEffort({}, 'gemini', 'gemini-3.1-pro-preview', 'gemini', 'minimal')).toThrow('not supported');
  });
  it('bounds manual thinking budgets by the explicit output limit instead of silently clamping', () => {
    expect(() => applyKeyEffort({ max_tokens: 1000 }, 'anthropic', 'claude-sonnet-4-20250514', 'claude', 'high')).toThrow('max_tokens');
  });
});
