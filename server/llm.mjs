/** ADP LLM 整理模块 — 平台无关（fetch + crypto，Node 18+ / Workers 通用）。
 *  调用已发布的 ADP 应用对话 API（SSE），把投喂材料整理为结构化 JSON。
 *  任何失败都返回 { ok:false, error }，由调用方降级到规则版 organize.mjs。
 */

const DEFAULT_ENDPOINT = 'https://wss.lke.cloud.tencent.com/adp/v2/chat';

/**
 * @param {string} text 投喂材料原文
 * @param {{endpoint?:string, appKey?:string, visitorId?:string, timeoutMs?:number}} opts
 * @returns {Promise<{ok:true, data:object}|{ok:false, error:string}>}
 */
export async function llmOrganize(text, opts = {}) {
  const appKey = opts.appKey;
  if (!appKey) return { ok: false, error: 'no-key' };
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const visitorId = opts.visitorId || 'contexta-worker';
  const timeoutMs = opts.timeoutMs || 30000;

  const body = {
    RequestId: 'ctxa-' + crypto.randomUUID(),
    // 每次整理用全新会话：整理是单轮任务，不需要上下文串联，也避免会话串扰
    ConversationId: 'ctxa-' + crypto.randomUUID().replaceAll('-', '').slice(0, 24),
    AppKey: appKey,
    VisitorId: visitorId,
    UserId: visitorId,
    Contents: [{ Type: 'text', Text: text }],
    Incremental: true,
    Stream: 'enable',
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    return parseSseResponse(raw);
  } catch (e) {
    return { ok: false, error: 'fetch: ' + String((e && e.message) || e).slice(0, 160) };
  }
}

/** 解析 SSE 响应：聚合 text.delta / 处理 text.replace / 捕获 error 事件。 */
function parseSseResponse(raw) {
  let out = '';
  let sawError = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^data:\s*(\{.*)$/);
    if (!m) continue;
    let evt;
    try {
      evt = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (evt.Type === 'text.delta') {
      out += evt.Text || '';
    } else if (evt.Type === 'text.replace') {
      out = evt.Text || '';
    } else if (evt.Type === 'error') {
      const err = evt.Error || {};
      sawError = (err.Code ?? '?') + ' ' + (err.Message || '');
    }
  }
  if (sawError && !out) return { ok: false, error: 'api: ' + sawError };
  const parsed = extractJson(out);
  if (!parsed) return { ok: false, error: 'bad-json: ' + out.slice(0, 120) };
  return { ok: true, data: normalize(parsed) };
}

/** 从模型输出里抠出 JSON（容忍 markdown 代码块包裹与前后杂文字）。 */
function extractJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

const VALID_TYPES = ['会议纪要', '对话片段', '文档', '链接剪藏', '灵感', '截图'];
const VALID_TOPICS = ['项目 · Aurora', '记忆系统研究', '个人灵感', '竞品观察', '商务', '待归类'];

/** 校验并裁剪模型输出，保证落库字段全部合法。 */
function normalize(d) {
  return {
    type: VALID_TYPES.includes(d.type) ? d.type : null,
    topic: VALID_TOPICS.includes(d.topic) ? d.topic : '待归类',
    conf: Math.max(0, Math.min(0.99, Number(d.conf) || 0.5)),
    title: String(d.title || '').trim().slice(0, 30) || null,
    summary: String(d.summary || '').trim().slice(0, 220),
    entities: Array.isArray(d.entities)
      ? d.entities
          .filter((e) => e && e.name)
          .slice(0, 8)
          .map((e) => ({ name: String(e.name).slice(0, 24), kind: String(e.kind || '概念').slice(0, 10) }))
      : [],
    relations: Array.isArray(d.relations)
      ? d.relations
          .filter((r) => r && r.a && r.b)
          .slice(0, 5)
          .map((r) => ({ a: String(r.a).slice(0, 24), rel: String(r.rel || '关联').slice(0, 12), b: String(r.b).slice(0, 24) }))
      : [],
    noise: !!d.noise,
    noiseReason: d.noise_reason ? String(d.noise_reason).slice(0, 100) : '',
  };
}
