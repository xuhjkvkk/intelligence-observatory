import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSVG } from '../lib/svg.mjs';
import { endpoint, decodeEvents } from '../lib/provider.mjs';
import { startServer } from '../server.mjs';
import { scheduleInfo } from '../lib/observatory.mjs';

function svg(challenge) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 600"><desc>${challenge}</desc><rect width="960" height="600" fill="#e8eee7"/><circle cx="400" cy="400" r="60"><animateTransform attributeName="transform" type="rotate" from="0 400 400" to="360 400 400" dur="3s" repeatCount="indefinite"/></circle></svg>`;
}

test('北京时间昼夜调度：08:00–23:00 使用基础间隔，夜间翻倍', () => {
  const utc = value => Date.parse(`${value}Z`);
  assert.deepEqual(scheduleInfo(utc('2026-09-16T00:00:00'), 30), { period:'day', effectiveIntervalMinutes:30 });
  assert.deepEqual(scheduleInfo(utc('2026-09-16T14:59:59'), 30), { period:'day', effectiveIntervalMinutes:30 });
  assert.deepEqual(scheduleInfo(utc('2026-09-16T15:00:00'), 30), { period:'night', effectiveIntervalMinutes:60 });
  assert.deepEqual(scheduleInfo(utc('2026-09-16T23:59:59'), 30), { period:'night', effectiveIntervalMinutes:60 });
});

test('SVG 检查：拒绝脚本、事件、外链、无动画、错误校验码和畸形 XML', () => {
  assert.equal(inspectSVG(svg('check-valid'), 'check-valid').valid, true);
  const unsafe = svg('check-valid').replace('</svg>', '<script>alert(1)</script><foreignObject><div>unsafe</div></foreignObject><use href="https://evil.invalid/a" onload="x()"/><style>@import "https://evil.invalid/a";</style></svg>');
  const checked = inspectSVG(unsafe, 'check-valid');
  assert.equal(checked.valid, false);
  assert.ok(!/script|foreignObject|evil.invalid|onload/.test(checked.svg));
  assert.equal(inspectSVG(svg('old'), 'new').valid, false);
  assert.equal(inspectSVG('<svg><circle/></svg>').valid, false);
  assert.equal(inspectSVG('<svg><g></svg>').valid, false);
  assert.equal(inspectSVG('not svg').valid, false);
});

test('API 路径：兼容根地址、/v1 和完整调用地址', () => {
  assert.equal(endpoint('https://example.com', 'models'), 'https://example.com/v1/models');
  assert.equal(endpoint('https://example.com/v1/', 'chat/completions'), 'https://example.com/v1/chat/completions');
  assert.equal(endpoint('https://example.com/openai/v1/responses', 'models'), 'https://example.com/openai/v1/models');
  assert.throws(() => endpoint('file:///etc/passwd', 'models'));
  assert.throws(() => endpoint('https://user:password@example.com', 'models'));
});

test('SSE：合并文本和用量，拒绝被截断的连接，处理 Responses 事件', () => {
  const chat = 'data: {"choices":[{"delta":{"content":"<svg>"}}]}\n\ndata: {"choices":[{"delta":{"content":"</svg>"}}],"usage":{"completion_tokens":10}}\n\ndata: [DONE]\n\n';
  assert.equal(decodeEvents(chat).choices[0].message.content, '<svg></svg>');
  assert.equal(decodeEvents(chat).usage.completion_tokens, 10);
  assert.throws(() => decodeEvents(chat.replace('data: [DONE]\n\n', '')), /提前断开/);
  const responses = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":8}}}\n\n';
  assert.equal(decodeEvents(responses).output_text, 'hello');
  assert.equal(decodeEvents(responses).usage.output_tokens, 8);
});

test('真实 HTTP 流程：配置保密、生成、重试、AI 复核、持久化、保留 13 次和跨站保护', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intelligence-test-'));
  let failNext = false, reviewFail = false, lastRequest, requests = 0;
  const upstream = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer local-test-secret') { res.writeHead(401); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data:[{ id:'test-model' }] })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); lastRequest = { path:req.url, body }; requests++;
    if (failNext) { failNext = false; res.writeHead(503); res.end(JSON.stringify({ error:{ message:'temporary upstream failure' } })); return; }
    const prompt = body.input || body.messages[0].content;
    const isReview = prompt.startsWith('You are reviewing');
    const challenge = prompt.match(/check-[\w-]+/)?.[0];
    const text = isReview ? JSON.stringify({ passed:!reviewFail, summary:'本地模拟复核结果', checks:{ animal:true, bicycle:true, motion:!reviewFail, scene:true, style:true } }) : svg(challenge);
    const usage = { prompt_tokens:42, completion_tokens:100, completion_tokens_details:{ reasoning_tokens:10 } };
    if (req.url === '/v1/responses') res.end(JSON.stringify({ status:'completed', output:[{ content:[{ type:'output_text', text }] }], usage:{ input_tokens:42, output_tokens:100 } }));
    else res.end(JSON.stringify({ choices:[{ message:{ content:text }, finish_reason:'stop' }], usage }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let app = await startServer({ port:0, dataDir:directory, env:{} });
  const call = async (path, method='GET', body) => {
    const r = await fetch(app.origin + path, { method, headers:body ? { 'Content-Type':'application/json' } : {}, body:body ? JSON.stringify(body) : undefined });
    return { status:r.status, data:await r.json() };
  };
  const run = async () => {
    const response = await call('/api/run', 'POST', {}); assert.equal(response.status, 202);
    await app.observatory.task; return app.observatory.items[0];
  };
  try {
    assert.equal((await call('/api/run', 'POST', {})).status, 400);
    const config = await call('/api/config', 'PUT', { baseURL:`http://127.0.0.1:${upstream.address().port}/v1`, apiKey:'local-test-secret', model:'test-model', effort:'default', retries:1 });
    assert.equal(config.status, 200); assert.equal(config.data.hasKey, true); assert.equal('apiKey' in config.data, false);
    assert.equal((await call('/api/state')).data.config.hasKey, true);
    assert.equal(JSON.stringify((await call('/api/state')).data).includes('local-test-secret'), false);
    assert.deepEqual((await call('/api/models')).data.models, ['test-model']);
    await call('/api/config', 'PUT', { apiKey:'' }); assert.equal(app.observatory.config.apiKey, 'local-test-secret');
    failNext = true;
    const observation = await run();
    assert.equal(observation.status, 'succeeded'); assert.equal(observation.attempts.length, 2);
    assert.equal(observation.attempts[0].status, 'failed'); assert.ok(observation.attempts[0].error.includes('503'));
    assert.equal(observation.inputTokens, 42); assert.equal(observation.outputTokens, 100);
    assert.notEqual(observation.attempts[0].challenge, observation.attempts[1].challenge);
    assert.equal('reasoning_effort' in lastRequest.body, false);
    assert.equal((await call(`/api/observations/${observation.id}`)).data.attempts.length, 2);
    assert.equal((await call('/api/config', 'PUT', { aiReview:true, reviewModel:'review-model', retries:0 })).status, 200);
    const reviewed = await run();
    assert.equal(reviewed.status, 'succeeded'); assert.equal(reviewed.review.status, 'passed'); assert.equal(reviewed.outputTokens, 200);
    assert.equal(lastRequest.body.model, 'review-model');
    reviewFail = true;
    const flagged = await run(); assert.equal(flagged.status, 'flagged'); assert.equal(flagged.review.status, 'failed');
    await call('/api/config', 'PUT', { aiReview:false, protocol:'responses', effort:'high' });
    assert.equal((await run()).status, 'succeeded');
    assert.equal(lastRequest.path, '/v1/responses'); assert.deepEqual(lastRequest.body.reasoning, { effort:'high' });
    for (let i=0; i<11; i++) await run();
    assert.equal(app.observatory.items.length, 13);
    const stored = JSON.parse(await readFile(join(directory, 'observations.json'), 'utf8'));
    assert.equal(stored.length, 13); assert.equal(stored[0].status, 'succeeded');
    const attack = await fetch(app.origin + '/api/run', { method:'POST', headers:{ 'Content-Type':'application/json', Origin:'https://evil.invalid' }, body:'{}' });
    assert.equal(attack.status, 403);
    assert.equal((await fetch(app.origin + '/.data/config.json')).status, 404);
    assert.equal((await fetch(app.origin + '/.env')).status, 404);
    const invalid = await call('/api/config', 'PUT', { intervalMinutes:0 }); assert.equal(invalid.status, 400);
    await app.close(); app = await startServer({ port:0, dataDir:directory, env:{} });
    assert.equal(app.observatory.items.length, 13); assert.equal(app.observatory.config.hasKey, undefined);
    assert.equal((await call('/api/state')).data.config.hasKey, true);
    await call('/api/config', 'PUT', { clearKey:true });
    assert.equal((await call('/api/state')).data.config.hasKey, false);
    assert.ok(requests >= 18);
  } finally {
    await app.close(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive:true, force:true });
  }
});
