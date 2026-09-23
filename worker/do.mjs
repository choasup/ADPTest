/** ContextaLibrary — Durable Object。
 *  控制台范式：所有输入先经 LLM 意图路由（llm.mjs），再由 console.mjs
 *  执行确定性 CRUD。图片走 alarm 异步整理。LLM 失败降级规则版。
 */
import { DurableObject } from 'cloudflare:workers';
import { SEED_ITEMS, SEED_TOOLS } from '../server/seed.mjs';
import {
  createItemFromImage,
  organizeItem,
  adjustSiblingWeights,
  applyLLMResult,
  applySignalToItem,
  regenerateItemSummary,
  runInstructionOnItems,
} from '../server/organize.mjs';
import { llmOrganize } from '../server/llm.mjs';
import { runConsole } from '../server/console.mjs';

/** 图片整理延迟：受理后 2.5s 由 alarm 开始。 */
const ORGANIZE_DELAY_MS = 2500;

function dateOnly() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

function nowStamp() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function freshState() {
  return {
    nextId: SEED_ITEMS.length + 1,
    items: structuredClone(SEED_ITEMS),
    tools: structuredClone(SEED_TOOLS),
    pending: 2,
    latestId: null,
    lastAdjustCount: 3,
    organizeQueue: [],
    /** 最近一次 LLM 失败原因（null=正常），随 state 一起返回供诊断。 */
    llmError: null,
  };
}

export class ContextaLibrary extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS library (
           k TEXT PRIMARY KEY,
           v TEXT NOT NULL
         )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS images (
           id TEXT PRIMARY KEY,
           name TEXT,
           data TEXT
         )`,
      );
      const row = this.ctx.storage.sql
        .exec('SELECT v FROM library WHERE k = ?', 'state')
        .toArray();
      this.state = row.length ? JSON.parse(row[0].v) : null;
      if (!this.state) {
        this.state = freshState();
        this.save();
      }
    });
  }

  save() {
    this.ctx.storage.sql.exec(
      'INSERT INTO library (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      'state',
      JSON.stringify(this.state),
    );
  }

  find(id) {
    return this.state.items.find((i) => i.id === id);
  }

  newItemId() {
    const id = 'c' + this.state.nextId;
    this.state.nextId += 1;
    return id;
  }

  // ——— RPC ———

  async getState() {
    return {
      items: this.state.items,
      tools: this.state.tools,
      pending: this.state.pending,
      latestId: this.state.latestId ?? this.state.items[0]?.id ?? null,
      adjustCount: this.state.lastAdjustCount,
      llm: {
        on: !!(this.env.ADP_SECRET_ID && this.env.ADP_SECRET_KEY && this.env.ADP_APP_KEY),
        lastError: this.state.llmError || null,
      },
    };
  }

  /** 控制台入口：文本走 LLM 意图路由 → console.mjs 执行 CRUD；
   *  图片走 alarm 异步整理（图片无文本可路由）。 */
  async feed(text, images) {
    const t = String(text || '').trim();
    const hasImages = !!(images && images.length);

    // 图片：归档 + 排队异步整理
    if (hasImages) {
      const created = [];
      for (const img of images ?? []) {
        const id = this.newItemId();
        const safe = String(img.name || '截图.png').replace(/[^\w.\-一-龥]/g, '_');
        const file = `${id}-${safe}`;
        this.ctx.storage.sql.exec(
          'INSERT INTO images (id, name, data) VALUES (?, ?, ?)',
          id,
          img.name ?? '截图.png',
          img.data ?? '',
        );
        const item = createItemFromImage(id, img.name, file);
        this.state.items.unshift(item);
        created.push(item.id);
      }
      this.state.organizeQueue.push(...created);
      this.save();
      const cur = await this.ctx.storage.getAlarm();
      const target = Date.now() + ORGANIZE_DELAY_MS;
      if (cur == null || cur > target) {
        await this.ctx.storage.setAlarm(target);
      }
      const imgNote = `已收下 ${created.length} 张截图，agent 正在 OCR 识别并整理`;
      if (!t) return `agent ${imgNote}。`;
      return `agent ${imgNote}；文本部分将一并处理。`;
    }

    if (!t) return '';

    // 系统级指令：重新整理 = 全量重排 LLM（不进 LLM 路由，避免被理解为澄清提问）
    if (/重新整理|重新组织/.test(t)) {
      return this.runInstructionText('重新整理');
    }

    // 文本：LLM 意图路由（控制台核心链路）
    const creds = {
      secretId: this.env.ADP_SECRET_ID,
      secretKey: this.env.ADP_SECRET_KEY,
      appKey: this.env.ADP_APP_KEY,
    };

    // 兜底指令（LLM 不可用时保持可用性）：重新整理 / 规则指令
    const fallback = () => {
      if (/重新整理/.test(t)) return this.runInstructionText(t);
      const runLog = runInstructionOnItems(this.state.items, t);
      this.save();
      return runLog || `已收到「${t.slice(0, 40)}」（LLM 不可用，按普通文本处理）。`;
    };

    if (!(creds.secretId && creds.secretKey && creds.appKey)) {
      return fallback();
    }

    const r = await llmOrganize(t, creds);
    if (!r.ok) {
      this.state.llmError = r.error;
      return fallback();
    }
    this.state.llmError = null;

    // console.mjs 执行意图（CRUD）
    const ctx = {
      nextId: () => this.newItemId(),
      dateOnly,
      nowStamp,
      rawInput: t,
    };
    const { runLog, effects } = runConsole(this.state.items, r.data, ctx);

    // 新增条目 → 排队做后续精整（摘要微调走 alarm，保持 add 即时可见）
    if (effects && effects.added && effects.added.length) {
      this.state.pending += effects.added.length;
      this.state.latestId = effects.added[0];
      this.state.lastAdjustCount = 0;
    }
    // 查询结果 → 前端定位选中
    if (effects && effects.queryIds && effects.queryIds.length) {
      this.state.latestId = effects.queryIds[0];
    }

    this.save();
    return runLog;
  }

  /**
   * 腾讯会议批量导入：按 meeting_id 去重，纪要文本建条目后排队 LLM 整理。
   * @param {Array<{meeting_id:string, subject:string, start_time:string, minutes_text:string}>} meetings
   */
  async importMeetings(meetings) {
    if (!this.state.syncedMeetingIds) this.state.syncedMeetingIds = [];
    const synced = new Set(this.state.syncedMeetingIds);
    const imported = [];
    const skipped = [];

    for (const m of meetings ?? []) {
      if (!m || !m.minutes_text || !m.minutes_text.trim()) {
        skipped.push(m?.meeting_id ?? '(无内容)');
        continue;
      }
      if (synced.has(m.meeting_id)) {
        skipped.push(m.meeting_id);
        continue;
      }
      const id = this.newItemId();
      const when = (m.start_time || '').replace('T', ' ').slice(5, 16) || nowStamp();
      const item = {
        id,
        type: '会议纪要',
        topic: '待归类',
        when,
        source: `腾讯会议 · ${m.subject || '未命名会议'}`,
        state: '待确认',
        conf: 0,
        title: String(m.subject || '未命名会议').slice(0, 30),
        summary: '腾讯会议纪要导入，LLM 整理中…',
        entities: [],
        relations: [],
        excerpt: `【腾讯会议纪要】${m.subject || ''}（${m.start_time || ''}）\n\n${String(m.minutes_text).slice(0, 4000)}`,
        log: [{ when: dateOnly(), what: `从腾讯会议同步（meeting_id ${m.meeting_id}）` }],
        signal: '常规',
        weight: 0.5,
        calls: 0,
        lastCall: '—',
      };
      this.state.items.unshift(item);
      this.state.organizeQueue.push(id);
      synced.add(m.meeting_id);
      this.state.syncedMeetingIds.push(m.meeting_id);
      imported.push(m.meeting_id);
    }

    if (imported.length) {
      const cur = await this.ctx.storage.getAlarm();
      const target = Date.now() + 500;
      if (cur == null || cur > target) {
        await this.ctx.storage.setAlarm(target);
      }
    }
    this.save();
    return {
      imported: imported.length,
      skipped: skipped.length,
      total: (meetings ?? []).length,
      runLog: imported.length
        ? `已从腾讯会议导入 ${imported.length} 场会议纪要${skipped.length ? `（跳过 ${skipped.length} 场：已导入或无纪要）` : ''}，LLM 正在逐场整理。`
        : `没有新会议可导入${skipped.length ? `（${skipped.length} 场已导入过或无纪要）` : ''}。`,
    };
  }

  /** 投喂框指令路由：重新整理 = 全量重跑 LLM；其余走规则指令。 */
  async runInstructionText(t) {    if (/重新整理/.test(t)) {
      const ids = this.state.items.map((i) => i.id);
      this.state.organizeQueue.push(...ids);
      const cur = await this.ctx.storage.getAlarm();
      const target = Date.now() + 500;
      if (cur == null || cur > target) {
        await this.ctx.storage.setAlarm(target);
      }
      this.save();
      return `agent 将对全部 ${ids.length} 条 context 重新跑 LLM 整理（逐条进行，稍候逐条生效）。`;
    }
    const runLog = runInstructionOnItems(this.state.items, t);
    this.save();
    return runLog;
  }

  /**
   * alarm 逐条整理（每次 tick 处理一条，处理后如队列非空则 100ms 后续跑）：
   * LLM 优先（ADP 对话 API，每条 ≤30s），失败降级规则版并记录 llmError。
   */
  async alarm() {
    const queue = this.state.organizeQueue;
    if (!queue || !queue.length) return;
    const id = queue.shift();
    const item = this.find(id);

    if (item) {
      const when = dateOnly();
      const creds = {
        secretId: this.env.ADP_SECRET_ID,
        secretKey: this.env.ADP_SECRET_KEY,
        appKey: this.env.ADP_APP_KEY,
      };
      let viaLLM = false;

      if (creds.secretId && creds.secretKey && creds.appKey) {
        // 长文本（会议纪要）思考久，超时放宽到 180s
        const r = await llmOrganize(item.excerpt, { ...creds, timeoutMs: 300000 });
        // 意图协议：add 的 data 里是整理字段；其余 op 不适用于后台整理
        if (r.ok && r.data && r.data.op === 'add' && r.data.data) {
          applyLLMResult(item, r.data.data);
          viaLLM = true;
          this.state.llmError = null;
        } else if (r.ok) {
          organizeItem(item);
        } else {
          organizeItem(item);
          this.state.llmError = r.error;
        }
      } else {
        organizeItem(item);
      }

      if (viaLLM) {
        item.log.push({ when, what: '经 ADP LLM 整理（归类 / 摘要 / 实体 / 关系 / 噪声判断）' });
      } else {
        item.log.push({
          when,
          what: '规则整理' + (this.state.llmError ? '（LLM 不可用，已降级）' : ''),
        });
      }

      const adjusted = adjustSiblingWeights(this.state.items, item.topic, item.id);
      this.state.pending += 1;
      this.state.latestId = item.id;
      this.state.lastAdjustCount = adjusted;
      this.save();
    }

    if (queue.length) {
      await this.ctx.storage.setAlarm(Date.now() + 100);
    }
  }

  async signal(id, sig) {
    const item = this.find(id);
    if (!item) return null;
    const runLog = applySignalToItem(item, sig);
    if (!runLog) return null;
    this.save();
    return runLog;
  }

  async regenerate(id) {
    const item = this.find(id);
    if (!item) return null;
    const runLog = regenerateItemSummary(item);
    this.save();
    return runLog;
  }

  async instruction(text) {
    const t = String(text || '').trim();
    if (/重新整理/.test(t)) return this.runInstructionText(t);
    const runLog = runInstructionOnItems(this.state.items, t);
    this.save();
    return runLog;
  }

  async toggleTool(id) {
    const tool = this.state.tools.find((t) => t.id === id);
    if (!tool) return null;
    tool.on = !tool.on;
    this.save();
    return this.state.tools;
  }

  async clearPending() {
    this.state.pending = 0;
    this.save();
    return { ok: true };
  }

  /**
   * 重置数据：清掉 mock/测试数据，可选保留指定 id 的条目。
   * mode: 'seed'（回种子）| 'empty'（清空）| 'keep'（只留 keepIds + 种子）。
   * 工具列表同步重置为种子（当前为空）。
   */
  async reset(mode = 'seed', keepIds = []) {
    const s = this.state;
    const keep = (keepIds || [])
      .map((id) => s.items.find((i) => i.id === id))
      .filter(Boolean);
    const fresh = freshState();
    s.items = mode === 'empty' ? keep : [...keep, ...fresh.items];
    s.tools = structuredClone(fresh.tools);
    // 重排 id 空间，避免与保留条目冲突
    let maxNum = 0;
    for (const i of s.items) {
      const n = Number(String(i.id).replace(/^c/, ''));
      if (Number.isFinite(n) && n > maxNum) maxNum = n;
    }
    s.nextId = Math.max(maxNum + 1, fresh.nextId);
    s.pending = 0;
    s.latestId = keep[0]?.id ?? null;
    s.lastAdjustCount = 0;
    s.organizeQueue = [];
    s.llmError = null;
    s.syncedMeetingIds = [];
    this.save();
    return { ok: true, count: s.items.length, kept: keep.map((i) => i.id) };
  }
}
