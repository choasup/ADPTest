/** 整理 agent — Node Express 侧编排（fs 落盘 + setTimeout 异步整理）。
 *  纯逻辑见 ./organize.mjs（与 Cloudflare Worker 共用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getStore, commit, dateOnly } from './store.mjs';
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
} from './organize.mjs';
import { llmOrganize } from './llm.mjs';

const UPLOAD_DIR = path.join(import.meta.dirname, 'data', 'uploads');

/** 整理延迟：受理后 2.5s 完成整理（模拟异步 OCR / 摘要 / 归类）。 */
const ORGANIZE_DELAY_MS = 2500;

function newItemId() {
  const s = getStore();
  const id = 'c' + s.nextId;
  s.nextId += 1;
  return id;
}

/** 受理一批投喂：文本 + 图片（base64）。文本若为整理指令则直接执行。 */
export async function acceptFeed(text, images) {
  const s = getStore();
  const t = String(text || '').trim();

  if (t && !(images && images.length) && isInstruction(t)) {
    const runLog = await runInstruction(t);
    return runLog;
  }

  const created = [];

  if (t) {
    const id = newItemId();
    const item = createItemFromText(id, t);
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
    setTimeout(() => void organizeById(item.id), ORGANIZE_DELAY_MS + Math.random() * 800);
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

async function organizeById(id) {
  const s = getStore();
  const item = s.items.find((i) => i.id === id);
  if (!item) return;

  const creds = {
    secretId: process.env.ADP_SECRET_ID,
    secretKey: process.env.ADP_SECRET_KEY,
    appKey: process.env.ADP_APP_KEY,
  };
  let viaLLM = false;
  if (creds.secretId && creds.secretKey && creds.appKey) {
    const r = await llmOrganize(item.excerpt, creds);
    if (r.ok) {
      applyLLMResult(item, r.data);
      viaLLM = true;
      item.log.push({ when: dateOnly(), what: '经 ADP LLM 整理（归类 / 摘要 / 实体 / 关系 / 噪声判断）' });
    } else {
      organizeItem(item);
      item.log.push({ when: dateOnly(), what: '规则整理（LLM 不可用，已降级）' });
    }
  } else {
    organizeItem(item);
  }
  void viaLLM;

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

export async function runInstruction(text) {
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
