const MAX_RESPONSE = 2_000_000;
export function decodeEvents(text) {
  let output = '', usage = {}, completed = false, responseData;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!payload) continue;
    if (payload.trim() === '[DONE]') { completed = true; continue; }
    let event;
    try { event = JSON.parse(payload); } catch { throw new Error('API 返回了无法解析的流式数据'); }
    if (event.error || event.type === 'error' || event.type === 'response.failed') throw new Error(event.error?.message || event.response?.error?.message || event.message || '上游流式生成失败');
    if (event.usage) usage = event.usage;
    if (event.choices?.[0]?.finish_reason === 'length') throw new Error('输出被 Token 上限截断，请提高最大输出 Token');
    if (event.choices?.[0]?.delta?.content) output += event.choices[0].delta.content;
    if (event.type === 'response.output_text.delta') output += event.delta || '';
    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      completed = true; responseData = event.response; usage = event.response?.usage || usage;
    }
  }
  if (!completed) throw new Error('API 流式连接提前断开，未收到完成事件');
  return responseData ? { ...responseData, output_text:output || responseData.output_text, usage }
    : { choices:[{ message:{ content:output }, finish_reason:'stop' }], usage };
}

export function endpoint(baseURL, resource) {
  const url = new URL(baseURL);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 必须是无查询参数和凭据的 HTTP(S) 地址');
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(chat\/completions|responses|models)$/, '');
  url.pathname = `${path || '/v1'}/${resource}`;
  return url.toString();
}

export async function request(config, resource, body, signal) {
  const timeout = AbortSignal.timeout(config.timeoutSeconds * 1000);
  const response = await fetch(endpoint(config.baseURL, resource), {
    method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const reader = response.body.getReader();
  let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error('API 响应超过 2 MB 限制'); }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (response.ok && (response.headers.get('content-type')?.includes('text/event-stream') || /^(?:\s|:[^\n]*\n)*(?:event:|data:)/.test(text))) return decodeEvents(text);
  let json;
  try { json = JSON.parse(text); } catch {
    if ([502, 503, 504, 524].includes(response.status)) throw new Error(`上游网关超时或暂时不可用（HTTP ${response.status}），请检查提供商状态`);
    throw new Error(`API 返回非 JSON 内容（HTTP ${response.status}），请检查 Base URL`);
  }
  if (!response.ok) {
    const message = String(json.error?.message || json.message || response.statusText).replaceAll(config.apiKey, '[已隐藏]');
    throw new Error(`API ${response.status}：${message.slice(0, 300)}`);
  }
  return json;
}

export async function generate(config, prompt, { model = config.model, limit = config.maxOutputTokens, signal } = {}) {
  let body, resource;
  if (config.protocol === 'responses') {
    resource = 'responses';
    body = { model, input: prompt, max_output_tokens: limit, stream: true };
    if (config.effort !== 'default') body.reasoning = { effort: config.effort };
  } else {
    resource = 'chat/completions';
    body = { model, messages: [{ role: 'user', content: prompt }], stream: true, stream_options: { include_usage: true } };
    body[config.tokenParameter] = limit;
    if (config.effort !== 'default') body.reasoning_effort = config.effort;
  }
  const data = await request(config, resource, body, signal);
  let text;
  if (config.protocol === 'responses') {
    if (data.status === 'incomplete' || data.status === 'failed') throw new Error(`生成未完成：${data.incomplete_details?.reason || data.error?.message || data.status}`);
    text = data.output_text || data.output?.flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n');
  } else {
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('输出被 Token 上限截断，请提高最大输出 Token');
    const content = data.choices?.[0]?.message?.content;
    text = Array.isArray(content) ? content.map(c => c.text || '').join('\n') : content;
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('API 没有返回文本内容');
  return { text, usage: {
    input: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0,
    output: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0,
    reasoning: data.usage?.output_tokens_details?.reasoning_tokens ?? data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  } };
}
