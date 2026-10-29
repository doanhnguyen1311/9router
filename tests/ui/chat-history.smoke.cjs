// Run against an isolated standalone instance; never accepts a production data dir.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { chromium } = require('playwright-core');
const baseURL = process.env.HISTORY_TEST_BASE_URL;
const password = process.env.HISTORY_TEST_PASSWORD;
const dir = path.resolve(process.env.HISTORY_TEST_DATA_DIR || '.');
if (!baseURL || !password || !dir.startsWith(path.join(os.tmpdir(), '9router-history-detail-'))) throw new Error('Supply a temporary HISTORY_TEST_DATA_DIR, HISTORY_TEST_BASE_URL and HISTORY_TEST_PASSWORD');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function seedConversation(ownerId) {
  const root = path.resolve(__dirname, '../..');
  const { createCollector } = await import(pathToFileURL(path.join(root, 'src/lib/chatHistory/collector.js')).href);
  const { historyConfig } = await import(pathToFileURL(path.join(root, 'src/lib/chatHistory/config.js')).href);
  const worker = new Worker(path.join(root, 'src/lib/chatHistory/worker.cjs'), { workerData: { file: path.join(dir, 'db/chat-history.sqlite') } });
  let recordJson, recordId;
  try {
    await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    const collector = createCollector({
      body: { model: 'fixture/model', messages: [
        { role: 'system', content: 'SYSTEM_CONTEXT_MARKER ' + 'long instructions '.repeat(100000) },
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'bạn là ai vậy' },
      ] }, endpoint: '/v1/chat/completions', config: historyConfig({ chatHistoryEnabled: true }), enqueue: value => { recordJson = JSON.stringify(value); recordId = value.id; },
    });
    collector.identify(ownerId); collector.attempt('fixture', 'model');
    await collector.wrap(Response.json({ choices: [{ message: { role: 'assistant', content: 'Trợ lý lập trình trong VS Code.\n<img src=x onerror="window.__historyXSS=1">', reasoning_content: 'REASONING_MARKER', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/index.js"}' } }] } }], usage: { prompt_tokens: 8, completion_tokens: 7 } })).text();
    await new Promise((resolve, reject) => {
      worker.once('message', result => result.saved === 1 ? resolve() : reject(new Error('Fixture record was dropped')));
      worker.once('error', reject);
      worker.postMessage({ type: 'batch', records: [Buffer.from(recordJson)] });
    });
    return recordId;
  } finally { await worker.terminate(); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.HISTORY_BROWSER_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1100 } });
    const api = context.request;
    let response = await api.post('/api/auth/login', { data: { password } }); assert.equal(response.status(), 200);
    response = await api.patch('/api/settings', { data: { chatHistoryEnabled: false, chatHistoryRetentionDays: 30 } }); assert.equal(response.status(), 200);
    const settings = async () => (await api.get('/api/settings')).json();
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const delayedLoad = async route => { if (route.request().method() === 'GET') await gate; await route.continue(); };
    await page.route('**/api/settings', delayedLoad);
    await page.goto('/dashboard/profile', { waitUntil: 'domcontentloaded' });
    const card = page.getByTestId('chat-history-settings'); const toggle = card.getByRole('switch');
    await toggle.waitFor(); assert.equal(await toggle.isDisabled(), true);
    release(); await page.waitForFunction(() => !document.querySelector('[data-testid="chat-history-settings"] [role="switch"]').disabled);
    await page.unroute('**/api/settings', delayedLoad);
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await card.getByText('Retention (days)', { exact: true }).locator('input').fill('45');
    let patch;
    const delayWrite = async route => {
      if (route.request().method() === 'PATCH') { patch = route.request().postDataJSON(); await pause(500); }
      await route.continue();
    };
    await page.route('**/api/settings', delayWrite);
    await toggle.click();
    await page.goto('/dashboard/chat-history', { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 20 && !(await settings()).chatHistoryEnabled; i++) await pause(100);
    assert.equal((await settings()).chatHistoryEnabled, true, 'Toggle must persist even during immediate navigation');
    assert.deepEqual(patch, { chatHistoryEnabled: true }, 'Toggle must not save numeric drafts');
    assert.equal((await settings()).chatHistoryRetentionDays, 30);
    await page.unroute('**/api/settings', delayWrite);
    await page.goto('/dashboard/profile'); await toggle.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-history-settings"] [role="switch"]').getAttribute('aria-checked') === 'true');
    const other = await context.newPage(); await other.goto('/dashboard/profile');
    await other.waitForFunction(() => document.querySelector('[data-testid="chat-history-settings"] [role="switch"]').getAttribute('aria-checked') === 'true');
    await other.close();
    await toggle.click(); await card.getByText('Chat History disabled. Saved automatically.', { exact: true }).waitFor();
    assert.equal((await settings()).chatHistoryEnabled, false);
    await page.reload(); await toggle.waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-testid="chat-history-settings"] [role="switch"]').disabled);
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await page.route('**/api/settings', async route => {
      if (route.request().method() === 'PATCH') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated settings failure' }) });
      else await route.continue();
    }, { times: 1 });
    await toggle.click(); await card.getByRole('alert').waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'Failed save must roll back');
    assert.equal((await settings()).chatHistoryEnabled, false);
    await toggle.click(); await card.getByText('Chat History enabled. Saved automatically.', { exact: true }).waitFor();
    await card.getByText('Retention (days)', { exact: true }).locator('input').fill('45');
    await card.getByRole('button', { name: 'Save history settings', exact: true }).click();
    await card.getByText('History settings saved.', { exact: true }).waitFor();
    assert.equal((await settings()).chatHistoryRetentionDays, 45);
    await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: '/tmp/9router-history-autosave.png' });
    response = await api.post('/api/keys', { data: { name: 'History UI · Doanh' } }); assert.equal(response.status(), 201);
    const owner = await response.json();
    const id = await seedConversation(owner.id);
    const ownerContext = await browser.newContext({ baseURL });
    const ownerResult = await ownerContext.request.get('/api/chat-history', { headers: { Authorization: 'Bearer ' + owner.key } });
    assert.equal(ownerResult.status(), 200);
    const ownHistory = await ownerResult.json();
    assert.deepEqual(ownHistory.items.map(item => item.id), [id]);
    assert.equal(ownHistory.items[0].apiKey.name, owner.name);
    assert.equal(JSON.stringify(ownHistory).includes(owner.key), false);
    await page.goto('/dashboard/chat-history');
    await page.getByRole('columnheader', { name: 'API key', exact: true }).waitFor();
    const row = page.getByRole('row').filter({ hasText: 'ID: ' + owner.id.slice(0, 8) });
    await row.getByText(owner.name, { exact: true }).waitFor();
    await row.getByRole('button', { name: 'View detail', exact: true }).click();
    const sent = page.getByRole('region', { name: 'Sent to AI', exact: true });
    const answer = page.getByRole('region', { name: 'AI response', exact: true });
    await sent.getByText('bạn là ai vậy', { exact: true }).waitFor();
    await page.getByRole('group', { name: 'Request API key', exact: true }).getByText(owner.name, { exact: true }).waitFor();
    assert.match(await answer.innerText(), /Trợ lý lập trình trong VS Code/);
    assert.match(await answer.innerText(), /read_file/);
    assert.match(await answer.innerText(), /src\/index\.js/);
    assert.equal(await page.getByText('REASONING_MARKER', { exact: true }).isVisible(), false);
    await answer.getByText('Reasoning / thinking', { exact: true }).click();
    await page.getByText('REASONING_MARKER', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__historyXSS), undefined);
    await page.screenshot({ path: '/tmp/9router-history-conversation.png' });
    await page.getByRole('button', { name: 'Close', exact: true }).last().click();
    response = await api.delete('/api/keys/' + owner.id); assert.equal(response.status(), 200);
    response = await ownerContext.request.get('/api/chat-history', { headers: { Authorization: 'Bearer ' + owner.key } });
    assert.equal(response.status(), 401);
    await ownerContext.close();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await row.getByText('Deleted API key', { exact: true }).waitFor();
    await page.route('**/api/chat-history?id=*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated detail failure' }) }), { times: 1 });
    await row.getByRole('button', { name: 'View detail', exact: true }).click();
    await page.getByRole('button', { name: 'Retry detail', exact: true }).click();
    await sent.getByText('bạn là ai vậy', { exact: true }).waitFor();
    await page.getByRole('group', { name: 'Request API key', exact: true }).getByText('Deleted API key', { exact: true }).waitFor();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete record', exact: true }).click();
    await page.getByRole('heading', { name: 'Conversation detail', exact: true }).waitFor({ state: 'hidden' });
    response = await api.get('/api/chat-history?id=' + id); assert.equal(response.status(), 404);
    assert.deepEqual(errors, []);
    console.log('PASS: loading guard, immediate navigation, new tab, reload, disable persistence, failed-save rollback, numeric drafts, readable user/AI/tool detail, API key names/owner scope/deleted-key fallback, XSS safety, retry and deletion.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
