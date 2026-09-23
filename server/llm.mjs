/** ADP LLM 整理模块 — WebSocket 通道（Node 18+ / Workers 通用）。
 *
 * 链路（独立站体系，已实测走通）：
 *   TC3 签名 → CreateWebSocketToken(Type=5, AppKey) → Token
 *   → wss://wss.lke.cloud.tencent.com/adp/v2/chat/conn (Socket.IO v4)
 *   → 40{token} 鉴权 → 42["request", {Request}] → text.delta 聚合 → JSON
 *
 * 签名关键：Content-Type 必须是 "application/json; charset=utf-8"
 * （官方 SDK 同款；不带 charset 会 450205 签名不匹配）。
 * 任何失败返回 { ok:false, error }，由调用方降级到规则版 organize.mjs。
 */

const TOKEN_API_HOST = 'capi.adp.tencent.com';
const WS_URL =
  'wss://wss.lke.cloud.tencent.com/adp/v2/chat/conn/?language=zh-CN&EIO=4&transport=websocket';
const CT = 'application/json; charset=utf-8';

// ——— TC3-HMAC-SHA256（service=adp） ———

function hmacSha256(keyBytes, msg) {
  return crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  ).then((k) => crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hex(buf);
}

/** 换 WS Token。返回 {ok:true, token} | {ok:false, error}。 */
export async function getWsToken(secretId, secretKey, appKey, userId = 'contexta-worker') {
  const payload = JSON.stringify({ Type: 5, AppKey: appKey, UserId: userId });
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const action = 'createwebsockettoken';

  const canonical =
    `POST\n/\n\ncontent-type:${CT}\nhost:${TOKEN_API_HOST}\nx-tc-action:${action}\n` +
    `\ncontent-type;host;x-tc-action\n` +
    (await sha256Hex(payload));
  const scope = `${date}/adp/tc3_request`;
  const stringToSign =
    `TC3-HMAC-SHA256\n${ts}\n${scope}\n` + (await sha256Hex(canonical));

  const enc = new TextEncoder();
  const kDate = await hmacSha256(enc.encode('TC3' + secretKey), date);
  const kService = await hmacSha256(new Uint8Array(kDate), 'adp');
  const kSigning = await hmacSha256(new Uint8Array(kService), 'tc3_request');
  const signature = hex(await hmacSha256(new Uint8Array(kSigning), stringToSign));

  const headers = {
    Authorization:
      `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, ` +
      `SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
    'Content-Type': CT,
    'X-TC-Action': 'CreateWebSocketToken',
    'X-TC-Timestamp': String(ts),
    'X-TC-Version': '2026-05-20',
    'X-TC-Region': 'ap-guangzhou',
  };

  try {
    const res = await fetch(`https://${TOKEN_API_HOST}/`, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(20000),
    });
    const resp = await res.json();
    const r = resp.Response || {};
    if (r.Error) {
      return { ok: false, error: `token: ${r.Error.Code} ${r.Error.Message}` };
    }
    return { ok: true, token: r.Token };
  } catch (e) {
    return { ok: false, error: 'token-fetch: ' + String((e && e.message) || e).slice(0, 140) };
  }
}

// ——— WS 对话（Socket.IO v4 over WebSocket） ———

/** UUID（无横线 hex）。 */
function uid() {
  return crypto.randomUUID().replaceAll('-', '');
}

/**
 * WS 通道整理。 Workers/Node 双兼容：优先用标准 WebSocket（Workers 原生），
 * Node ≥22 也有全局 WebSocket；都没有时返回错误（调用方降级）。
 * @returns {Promise<{ok:true, data:object}|{ok:false, error:string}>}
 */
export async function llmOrganize(text, opts = {}) {
  const { secretId, secretKey, appKey } = opts;
  if (!secretId || !secretKey || !appKey) return { ok: false, error: 'no-credentials' };
  const timeoutMs = opts.timeoutMs || 90000;

  const tok = await getWsToken(secretId, secretKey, appKey);
  if (!tok.ok) return tok;

  return new Promise((resolve) => {
    let reply = '';
    let settled = false;
    let completedTimer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(result);
    };
    const fail = (msg) => done({ ok: false, error: msg });

    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      return fail('ws-ctor: ' + String((e && e.message) || e).slice(0, 120));
    }

    const timer = setTimeout(() => fail(`ws-timeout(${timeoutMs}ms): ${reply.slice(0, 80)}`), timeoutMs);

    const step = { phase: 0 };
    ws.onopen = () => {};
    ws.onmessage = (ev) => {
      const msg = typeof ev.data === 'string' ? ev.data : '';
      if (!msg) return;
      if (msg.startsWith('2')) { ws.send('3'); return; }          // ping/pong
      if (step.phase === 0 && msg.startsWith('0')) {               // 握手 → 发 token
        step.phase = 1;
        ws.send('40{"token":"' + tok.token + '"}');
        return;
      }
      if (step.phase === 1 && msg.startsWith('40')) {              // 鉴权通过 → 发对话
        step.phase = 2;
        const reqBody = {
          Type: 'request',
          Request: {
            RequestId: uid(),
            ConversationId: uid(),
            Contents: [{ Type: 'text', Text: text }],
            Incremental: true,
            // 非流式：整段一次返回，规避快思考模型的流尾包截断
            Stream: 'disable',
          },
        };
        ws.send('42' + JSON.stringify(['request', reqBody]));
        return;
      }
      if (!msg.startsWith('42')) return;
      let name, payload;
      try {
        [name, payload] = JSON.parse(msg.slice(2));
      } catch {
        return;
      }
      const evt = payload && typeof payload === 'object' ? payload : {};
      const t = evt.Type || name;
      if (t === 'text.delta') {
        reply += evt.Text || '';
      } else if (t === 'text.replace') {
        reply = evt.Text || reply;
      } else if (t === 'error') {
        const err = evt.Error || {};
        fail(`ws-evt: ${err.Code ?? '?'} ${err.Message || ''}`);
      } else if (t === 'response.completed') {
        // 延迟 400ms 收尾：completed 事件可能先于最后几个 text.delta 到达
        // （流式缓冲），先等缓冲排空再解析
        if (completedTimer) clearTimeout(completedTimer);
        completedTimer = setTimeout(() => {
          const parsed = extractJson(reply) || extractJson(repairJson(reply));
          if (parsed) done({ ok: true, data: normalize(parsed.json), reasoning: parsed.reasoning });
          else fail('bad-json: ' + reply.slice(0, 160));
        }, 400);
      }
    };
    ws.onerror = (e) => fail('ws-error: ' + String((e && e.message) || e).slice(0, 120));
    ws.onclose = () => {
      if (!settled) {
        const parsed = extractJson(reply);
        if (parsed) done({ ok: true, data: normalize(parsed.json), reasoning: parsed.reasoning });
        else fail('ws-closed: ' + reply.slice(0, 120));
      }
    };
  });
}

// ——— 截断 JSON 自动修复 ———

/** 模型偶发生成提前 EOS（reply 字符串中途截断）：
 *  逐候选补全（闭字符串→去尾逗号→闭 N 层括号）后尝试解析，
 *  返回可解析的候选文本（失败返回原文）。 */
function repairJson(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const re = /\{\s*"op"\s*:/;
  const m = t.match(re);
  if (!m) return raw;
  t = t.slice(t.indexOf(m[0]));
  // 数未闭合的 { 层数（字符串感知）
  let depth = 0, inStr = false, escape = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { if (inStr) escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  let out = t;
  if (inStr) out += '"';          // 闭字符串
  out = out.replace(/,\s*$/, ''); // 去尾逗号
  out += '}'.repeat(Math.max(0, depth)); // 闭所有层
  // 尝试每一层补全（从全闭到少闭）
  for (let k = Math.max(0, depth); k >= 0; k--) {
    const cand = (inStr ? t + '"' : t).replace(/,\s*$/, '') + '}'.repeat(k);
    try { JSON.parse(cand); return cand; } catch {}
  }
  return out;
}

// ——— JSON 提取与校验（与 SSE 版一致） ———

/** 从模型输出里抠出意图 JSON + 其前的推理过程文本。
 *  兼容多种输出习惯：纯 JSON、思考前缀+JSON、markdown 代码块包裹、
 *  平台注入的前缀内容。返回 { json, reasoning } 或 null。 */
function extractJson(text) {
  const raw = String(text || '');
  if (!raw) return null;
  // 兼容任意空白习惯：{"op" / {"op": / { "op" : 等
  const re = /\{\s*\"op\"\s*:/;
  const m = raw.match(re);
  if (!m) return null;
  const start = raw.indexOf(m[0]);
  if (start < 0) return null;
  // 从该起点做括号平衡（容忍字符串内的括号：用简单状态机跳过字符串字面量）
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { if (inStr) escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const json = JSON.parse(raw.slice(start, i + 1));
          // JSON 之前的正文即模型推理过程（去掉思考标签包裹）
          let reasoning = raw.slice(0, start).trim();
          reasoning = reasoning
            .replace(/<think>[\s\S]*?<\/think>/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          return { json, reasoning };
        } catch {}
        break;
      }
    }
  }
  return null;
}

const VALID_OPS = ['add', 'delete', 'update', 'query', 'stats', 'none'];
const VALID_TYPES = ['会议纪要', '对话片段', '文档', '链接剪藏', '灵感', '截图'];
const VALID_TOPICS = ['项目 · Aurora', '记忆系统研究', '个人灵感', '竞品观察', '商务', '待归类'];

/** 校验意图协议输出：{op, data, reply}。add 的整理字段就地裁剪。 */
function normalize(d) {
  const op = VALID_OPS.includes(d.op) ? d.op : 'none';
  const data = (d.data && typeof d.data === 'object') ? d.data : {};
  if (op === 'add') {
    data.type = VALID_TYPES.includes(data.type) ? data.type : '对话片段';
    data.topic = VALID_TOPICS.includes(data.topic) ? data.topic : '待归类';
    data.conf = Math.max(0, Math.min(0.99, Number(data.conf) || 0.5));
    data.title = String(data.title || '').slice(0, 30);
    data.summary = String(data.summary || '').slice(0, 220);
    data.noise = !!data.noise;
  }
  return { op, data, reply: String(d.reply || '').slice(0, 200) };
}
