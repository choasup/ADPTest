/** 整理 agent — Node Express 侧编排（fs 落盘 + setTimeout 异步整理）。
 *  纯逻辑见 ./organize.mjs（与 Cloudflare Worker 共用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getStore, commit } from './store.mjs';
import {
  createItemFromText,
  createItemFromImage,
  organizeItem,
  adjustSiblingWeights,
  applySignalToItem,
  regenerateItemSummary,
  runInstructionOnItems,
} from './organize.mjs';

const UPLOAD_DIR = path.join(import.meta.dirname, 'data', 'uploads');

/** 整理延迟：受理后 2.5s 完成整理（模拟异步 OCR / 摘要 / 归类）。 */
const ORGANIZE_DELAY_MS = 2500;

function newItemId() {
  const s = getStore();
  const id = 'c' + s.nextId;
  s.nextId += 1;
  return id;
}

/** 受理一批投喂：文本 + 图片（base64）。返回回执文案。 */
export function acceptFeed(text, images) {
  const s = getStore();
  const created = [];

  if (text && text.trim()) {
    const id = newItemId();
    const item = createItemFromText(id, text);
    s.items.unshift(item);
    created.push(item);
  }

  for (const img of images ?? []) {
    const id = newItemId();
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const safe = String(img.name || '截图.png').replace(/[^\w.\-一-龥]/g, '_');
    const file = `${id}-${safe}`;
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(img.data, 'base64'));
    } catch {
      // 落盘失败不阻塞整理
    }
    const item = createItemFromImage(id, img.name, file);
    s.items.unshift(item);
    created.push(item);
  }

  commit();

  for (const item of created) {
    setTimeout(() => organizeById(item.id), ORGANIZE_DELAY_MS + Math.random() * 800);
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

function organizeById(id) {
  const s = getStore();
  const item = s.items.find((i) => i.id === id);
  if (!item) return;

  organizeItem(item);
  const adjusted = adjustSiblingWeights(s.items, item.topic, item.id);

  s.pending += 1;
  s.latestId = item.id;
  s.lastAdjustCount = adjusted;
  commit();
}

// ——— 人类信号（唯一可写） ———

export function applySignal(id, signal) {
  const s = getStore();
  const item = s.items.find((i) => i.id === id);
  if (!item) return null;
  const runLog = applySignalToItem(item, signal);
  if (!runLog) return null;
  commit();
  return runLog;
}

export function regenerateItem(id) {
  const s = getStore();
  const item = s.items.find((i) => i.id === id);
  if (!item) return null;
  const runLog = regenerateItemSummary(item);
  commit();
  return runLog;
}

// ——— 自然语言指令 ———

export function runInstruction(text) {
  const s = getStore();
  const runLog = runInstructionOnItems(s.items, text);
  commit();
  return runLog;
}

// ——— 工具开关 / 提示条 ———

export function toggleTool(id) {
  const s = getStore();
  const tool = s.tools.find((t) => t.id === id);
  if (!tool) return null;
  tool.on = !tool.on;
  commit();
  return tool.on;
}

export function clearPending() {
  const s = getStore();
  s.pending = 0;
  commit();
}
