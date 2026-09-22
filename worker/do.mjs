/** ContextaLibrary — Durable Object。
 *  单线程事务状态 + alarm 驱动的异步整理（替代 Node 版 setTimeout 流水线，无竞态）。
 *  纯整理逻辑复用 ../server/organize.mjs。
 */
import { DurableObject } from 'cloudflare:workers';
import { SEED_ITEMS, SEED_TOOLS } from '../server/seed.mjs';
import {
  createItemFromText,
  createItemFromImage,
  organizeItem,
  adjustSiblingWeights,
  applySignalToItem,
  regenerateItemSummary,
  runInstructionOnItems,
} from '../server/organize.mjs';

/** 整理延迟：受理后 2.5s 由 alarm 完成整理。 */
const ORGANIZE_DELAY_MS = 2500;

function freshState() {
  return {
    nextId: SEED_ITEMS.length + 1,
    items: structuredClone(SEED_ITEMS),
    tools: structuredClone(SEED_TOOLS),
    pending: 2,
    latestId: null,
    lastAdjustCount: 3,
    organizeQueue: [],
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
    };
  }

  /** 受理投喂：文本 + 图片（base64）。触发 alarm 整理，返回回执。 */
  async feed(text, images) {
    const created = [];

    if (text && text.trim()) {
      const id = this.newItemId();
      const item = createItemFromText(id, text);
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
    if (text && text.trim()) parts.push(`指令「${text.trim()}」将在下一轮整理中执行`);
    return parts.length ? `agent ${parts.join('；')}。` : '';
  }

  async alarm() {
    const queue = this.state.organizeQueue;
    this.state.organizeQueue = [];
    for (const id of queue) {
      const item = this.find(id);
      if (!item) continue;
      organizeItem(item);
      const adjusted = adjustSiblingWeights(this.state.items, item.topic, item.id);
      this.state.pending += 1;
      this.state.latestId = item.id;
      this.state.lastAdjustCount = adjusted;
    }
    this.save();
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
    const runLog = runInstructionOnItems(this.state.items, text);
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
