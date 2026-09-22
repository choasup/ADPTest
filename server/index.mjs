/** 文境 Contexta — API 服务器。
 *  dev 模式：仅 API（vite 通过 proxy 转发 /api）。
 *  生产模式（npm run build 后 npm start）：同时服务 dist 静态文件。
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { getStore, commit } from './store.mjs';
import {
  acceptFeed,
  applySignal,
  regenerateItem,
  runInstruction,
  toggleTool,
  clearPending,
} from './agent.mjs';

const PORT = Number(process.env.PORT || 8787);
const app = express();

app.use(express.json({ limit: '24mb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ——— 状态（前端轮询） ———
app.get('/api/state', (req, res) => {
  const s = getStore();
  res.json({
    items: s.items,
    tools: s.tools,
    pending: s.pending,
    latestId: s.latestId ?? s.items[0]?.id ?? null,
    adjustCount: s.lastAdjustCount,
  });
});

// ——— 投喂（文本 + 图片 base64） ———
app.post('/api/feed', (req, res) => {
  const { text = '', images = [] } = req.body ?? {};
  if (!text.trim() && !(images && images.length)) {
    return res.status(400).json({ error: '空的投喂' });
  }
  const runLog = acceptFeed(text, images ?? []);
  res.json({ runLog });
});

// ——— 信号写入 ———
app.post('/api/signal', (req, res) => {
  const { id, signal } = req.body ?? {};
  const runLog = applySignal(id, signal);
  if (!runLog) return res.status(404).json({ error: '条目不存在' });
  res.json({ runLog });
});

// ——— 自然语言指令 ———
app.post('/api/instruction', (req, res) => {
  const { text = '' } = req.body ?? {};
  const runLog = runInstruction(text);
  res.json({ runLog });
});

// ——— 重新生成摘要与实体 ———
app.post('/api/regenerate', (req, res) => {
  const { id } = req.body ?? {};
  const runLog = regenerateItem(id);
  if (!runLog) return res.status(404).json({ error: '条目不存在' });
  res.json({ runLog });
});

// ——— 工具启用开关 ———
app.post('/api/tools/toggle', (req, res) => {
  const { id } = req.body ?? {};
  const on = toggleTool(id);
  if (on === null) return res.status(404).json({ error: '工具不存在' });
  res.json({ tools: getStore().tools });
});

// ——— 提示条：已查看 agent 新整理 ———
app.post('/api/pending/clear', (_req, res) => {
  clearPending();
  res.json({ ok: true });
});

// ——— 生产静态服务 ———
const DIST = path.join(import.meta.dirname, '..', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`[contexta] API + 静态服务已启动: http://localhost:${PORT}`);
});
