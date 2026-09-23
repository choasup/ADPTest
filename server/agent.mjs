/** 整理 agent — Node Express 侧编排（fs 落盘 + setTimeout 异步整理）。
 *  控制台范式：文本输入先经 LLM 意图路由（console.mjs 执行 CRUD）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getStore, commit, dateOnly, nowStamp } from './store.mjs';
import {
  createItemFromImage,
  organizeItem,
  adjustSiblingWeights,
  applyLLMResult,
  applySignalToItem,
  regenerateItemSummary,
  runInstructionOnItems,
} from './organize.mjs';
import { llmOrganize } from './llm.mjs';
import { runConsole } from './console.mjs';

const UPLOAD_DIR = path.join(import.meta.dirname, 'data', 'uploads');

/** 图片整理延迟：受理后 2.5s。 */
const ORGANIZE_DELAY_MS = 2500;

function newItemId() {
  const s = getStore();
  const id = 'c' + s.nextId;
  s.nextId += 1;
  return id;
}

/** 控制台入口：文本 → LLM 意图路由 → console.mjs CRUD；图片 → 异步整理。 */
export async function acceptFeed(text, images) {
  const s = getStore();
  const t = String(text || '').trim();
  const hasImages = !!(images && images.length);

  if (hasImages) {
    const created = [];
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
      created.push(item.id);
    }
    commit();
    for (const id of created) {
      setTimeout(() => void organizeById(id), ORGANIZE_DELAY_MS + Math.random() * 800);
    }
    return `agent 已收下 ${created.length} 张截图，正在 OCR 识别并整理。`;
  }

  if (!t) return '';

  const creds = {
    secretId: process.env.ADP_SECRET_ID,
    secretKey: process.env.ADP_SECRET_KEY,
    appKey: process.env.ADP_APP_KEY,
  };
  if (creds.secretId && creds.secretKey && creds.appKey) {
    const r = await llmOrganize(t, creds);
    if (r.ok) {
      const { runLog, effects } = runConsole(s.items, r.data, {
        nextId: newItemId,
        dateOnly,
        nowStamp,
        rawInput: t,
      });
      if (effects && effects.added && effects.added.length) {
        s.pending += effects.added.length;
        s.latestId = effects.added[0];
      }
      if (effects && effects.queryIds && effects.queryIds.length) {
        s.latestId = effects.queryIds[0];
      }
      commit();
      return runLog;
    }
  }

  // LLM 不可用降级：规则指令
  const runLog = runInstructionOnItems(s.items, t);
  commit();
  return runLog || `已收到「${t.slice(0, 40)}」。`;
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
