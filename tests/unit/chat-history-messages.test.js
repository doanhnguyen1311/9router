import { describe, it, expect } from 'vitest';
import { historyMessages, formatHistoryValue } from '../../src/shared/utils/chatHistoryMessages.js';

describe('readable history message presentation', () => {
  it('keeps request roles, user questions and assistant answers distinct', () => {
    const detail = { request: { messages: [
      { role: 'system', content: 'system instructions' },
      { role: 'developer', content: 'developer instructions' },
      { role: 'user', content: 'bạn là ai vậy' },
    ] }, response: [{ role: 'assistant', content: 'Trợ lý lập trình trong VS Code.' }] };
    const view = historyMessages(detail);
    expect(view.request.map(item => item.role)).toEqual(['system', 'developer', 'user']);
    expect(view.request[2].parts).toEqual([{ kind: 'text', text: 'bạn là ai vậy' }]);
    expect(view.response[0].parts).toEqual([{ kind: 'text', text: 'Trợ lý lập trình trong VS Code.' }]);
  });
  it('renders Anthropic tools and results while keeping binary metadata out of text answers', () => {
    const view = historyMessages({ request: { system: [{ type: 'text', text: 'instructions' }], messages: [
      { role: 'user', content: [{ type: 'text', text: 'read a file' }, { type: 'image', source: '[BINARY OMITTED]' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] },
    ] }, response: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'answer' }] }] });
    expect(view.request.map(item => item.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(view.request[1].parts[1].kind).toBe('attachment');
    expect(view.request[2].parts[0]).toMatchObject({ kind: 'tool_call', name: 'read_file', value: { path: 'a' } });
    expect(view.request[3].parts[0]).toMatchObject({ kind: 'tool_result', id: 't1', value: 'file contents' });
    expect(view.response[0].parts.map(part => part.kind)).toEqual(['reasoning', 'text']);
  });
  it('supports Responses input strings, instructions and function-call outputs', () => {
    const simple = historyMessages({ request: { instructions: 'instructions', input: 'question' }, response: [{ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }] }] });
    expect(simple.request.map(item => item.role)).toEqual(['system', 'user']);
    expect(simple.response[0].parts[0].text).toBe('answer');
    const tools = historyMessages({ request: { input: [{ type: 'function_call', name: 'read', call_id: 'c1', arguments: '{"path":"a"}' }, { type: 'function_call_output', call_id: 'c1', output: 'result' }] } });
    expect(tools.request.map(item => item.role)).toEqual(['assistant', 'tool']);
    expect(tools.request[1].parts[0]).toMatchObject({ kind: 'tool_result', value: 'result' });
  });
  it('supports Gemini parts, model role and function responses', () => {
    const view = historyMessages({ request: { systemInstruction: { parts: [{ text: 'instructions' }] }, contents: [
      { role: 'user', parts: [{ text: 'question' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read', args: { path: 'a' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read', response: { result: 'ok' } } }] },
    ] }, response: [{ candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] } }] }] });
    expect(view.request.map(item => item.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(view.response[0].parts[0].text).toBe('answer');
  });
  it('does not repeat assistant text from native completion envelopes', () => {
    const message = { role: 'assistant', content: 'one answer' };
    const view = historyMessages({ response: [message, { type: 'response.output_item.done', item: { ...message, id: 'm1' } }, { type: 'response.completed', response: { output: [message] } }] });
    expect(view.response).toHaveLength(1);
    const native = historyMessages({ response: [{ type: 'response.output_item.done', item: { ...message, id: 'm1' } }, { type: 'response.completed', response: { output: [{ ...message, id: 'm1' }] } }] });
    expect(native.response).toHaveLength(1);
  });
  it('keeps reasoning, function arguments, tool results and errors readable', () => {
    const view = historyMessages({ response: [{ role: 'assistant', content: 'answer', reasoning_content: 'summary', tool_calls: [{ id: 't1', function: { name: 'read', arguments: '{"path":"a"}' } }] }] });
    expect(view.response[0].parts.map(part => part.kind)).toEqual(['reasoning', 'text', 'tool_call']);
    expect(formatHistoryValue(view.response[0].parts[2].value)).toBe('{\n  "path": "a"\n}');
    expect(historyMessages({ error: { message: 'failed' }, response: [{ error: { message: 'failed' } }] }).response).toEqual([]);
  });
  it('preserves untrusted text literally and tolerates missing or malformed envelopes', () => {
    const markup = '<img src=x onerror=alert(1)>';
    expect(historyMessages({ response: [{ content: markup }] }).response[0].parts[0].text).toBe(markup);
    expect(historyMessages({ request: {}, response: [null, { output: 'bad' }, { candidates: {} }] }).response).toEqual([]);
    expect(formatHistoryValue('ordinary text')).toBe('ordinary text');
  });
});
