/** ContextaLibrary — Durable Object。
 *  单线程事务状态 + alarm 驱动的异步整理（替代 Node 版 setTimeout 流水线，无竞态）。
 *  整理优先走 ADP LLM（llm.mjs），失败自动降级规则版（organize.mjs）。
 */
import { DurableObject } from 'cloudflare:workers';
import { SEED_ITEMS, SEED_TOOLS } from '../server/seed.mjs';
import {
  createItemFromText,
  createItemFromImage,
  organizeItem,
  adjustSiblingWeights,
  applyLLMResult,
  isInstruction,
  applySignalToItem,
  regenerateItemSummary,
  runInstructionOnItems,
} from '../server/organize.mjs';
import { llmOrganize } from '../server/llm.mjs';

/** 整理延迟：受理后 2.5s 由 alarm 开始逐条整理（LLM 每条最长 ~30s）。 */
const ORGANIZE_DELAY_MS = 2500;

function dateOnly() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
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

  /** 受理投喂：文本 + 图片（base64）。文本若是整理指令则直接执行。 */
  async feed(text, images) {
    const t = String(text || '').trim();
    if (t && !(images && images.length) && isInstruction(t)) {
      return this.runInstructionText(t);
    }

    const created = [];

    if (t) {
      const id = this.newItemId();
      const item = createItemFromText(id, t);
      this.state.items.unshift(item);
      created.push(item.id);
    }

    for (const img of images ?? []) {
      const id = this.newItemId();
      const safe = String(img.name || '截图.png').replace(/[^\w.\-一-龥]/g, '_');
      const file = `${id}-${safe}`;
      // 图片归档（原 base64 落 SQLite，供后续真实 OCR 使用）
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

    // alarm：取最早的截止时间（不推迟已排定的更早整理）
    const cur = await this.ctx.storage.getAlarm();
    const target = Date.now() + ORGANIZE_DELAY_MS;
    if (cur == null || cur > target) {
      await this.ctx.storage.setAlarm(target);
    }

    const parts = [];
    if (created.length) {
      const imgs = (images ?? []).length;
      const texts = created.length - imgs;
      const seg = [];
      if (texts) seg.push(`${texts} 条文本`);
      if (imgs) seg.push(`${imgs} 张截图`);
      parts.push(`已收下 ${seg.join('、')}，agent 正在整理`);
    }
    if (t) parts.push(`指令「${t}」将在下一轮整理中执行`);
    return parts.length ? `agent ${parts.join('；')}。` : '';
  }

  /** 投喂框指令路由：重新整理 = 全量重跑 LLM；其余走规则指令。 */
  async runInstructionText(t) {
    if (/重新整理/.test(t)) {
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
        const r = await llmOrganize(item.excerpt, creds);
        if (r.ok) {
          applyLLMResult(item, r.data);
          viaLLM = true;
          this.state.llmError = null;
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
}
