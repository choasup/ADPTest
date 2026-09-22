/** 整理 agent 原型。
 *  产品约束：agent 拥有数据——归类、摘要、实体、关系、权重与去留全部在服务端维护，
 *  人只投喂与给信号。本文件用确定性规则模拟 agent 的整理流水线：
 *
 *    投喂受理（state=待确认）→ 异步整理（摘要/归类/实体/关系，state=已整理）
 *    → pending++，同主题旧条目权重微调（「调整了 N 条旧记忆的权重」）
 *
 *  自然语言指令：合成时间线 / 合并重复条目 / 重新抽取所有实体。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getStore, commit, nowStamp, dateOnly } from './store.mjs';

const UPLOAD_DIR = path.join(import.meta.dirname, 'data', 'uploads');

/** 整理延迟：受理后 2.5s 完成整理（模拟异步 OCR / 摘要 / 归类）。 */
const ORGANIZE_DELAY_MS = 2500;

// ——— 知识词典（来自既有 context 的实体沉淀）———

const KNOWN_ENTITIES = [
  { name: '张小林', kind: '人', variants: ['小林'] },
  { name: '周颖', kind: '人', variants: [] },
  { name: 'Aurora', kind: '项目', variants: ['aurora', 'AURORA'] },
  { name: 'MemGPT', kind: '论文', variants: [] },
  { name: 'Rewind', kind: '产品', variants: [] },
  { name: '检索评测集', kind: '产物', variants: ['评测集'] },
  { name: '衰减曲线', kind: '概念', variants: ['时间衰减分', '衰减曲线打分'] },
  { name: '上下文分页', kind: '概念', variants: [] },
  { name: '调度策略', kind: '概念', variants: [] },
  { name: 'embedding 选型', kind: '概念', variants: ['embedding', '向量模型'] },
  { name: '同义词表', kind: '方案', variants: [] },
  { name: '结论卡', kind: '概念', variants: [] },
  { name: '渐进压缩', kind: '概念', variants: [] },
  { name: '数据可导出', kind: '议题', variants: ['导出', '带走'] },
  { name: '上传队列', kind: '模块', variants: [] },
  { name: '并发解析', kind: '故障因', variants: [] },
  { name: '图结构检索', kind: '概念', variants: [] },
];

const TOPIC_RULES = [
  { topic: '项目 · Aurora', conf: 0.86, keys: ['Aurora', 'aurora', '记忆层', '上传队列', '检索评测集'] },
  { topic: '商务', conf: 0.84, keys: ['投资人', '客户', '报价', '商务', '护城河', '迁移走'] },
  { topic: '竞品观察', conf: 0.8, keys: ['竞品', 'Rewind', '界面'] },
  { topic: '个人灵感', conf: 0.72, keys: ['灵感', '想法', '突然想到', '结痂'] },
  { topic: '记忆系统研究', conf: 0.87, keys: ['记忆', 'embedding', '上下文', 'context', 'MemGPT', '论文', '检索', '摘要'] },
];

const TYPE_RULES = [
  { type: '链接剪藏', test: (t) => /https?:\/\/|\b(arxiv|github|notion)\b/i.test(t) },
  { type: '会议纪要', test: (t) => /会议|评审|周会|1:1|站会|讨论纪要/.test(t) },
  { type: '文档', test: (t) => /PDF|阅读笔记|论文阅读|\.pdf/i.test(t) },
  { type: '灵感', test: (t) => /想法|灵感|突然想到|深夜|或许可以/.test(t) || t.length <= 40 },
];

// ——— 整理原语 ———

function classifyTopic(text) {
  for (const rule of TOPIC_RULES) {
    if (rule.keys.some((k) => text.includes(k))) {
      return { topic: rule.topic, conf: rule.conf + (Math.random() - 0.5) * 0.08 };
    }
  }
  // 低置信度 → 待归类 + 待确认（与 c3/c5 语义一致）
  return { topic: '待归类', conf: 0.35 + Math.random() * 0.2 };
}

function classifyType(text) {
  for (const rule of TYPE_RULES) if (rule.test(text)) return rule.type;
  return '对话片段';
}

function makeTitle(text) {
  const firstLine = text.split('\n').find((l) => l.trim()) ?? text;
  const core = firstLine.replace(/^[\s"'「『（(]+|[\s"'」』）)].*$/g, '').trim();
  const candidate = core.length > 24 ? core.slice(0, 24) + '…' : core || '未命名片段';
  return candidate.length < 8 ? candidate + '（新投喂）' : candidate;
}

function summarize(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 110) return flat;
  const cut = flat.slice(0, 110);
  const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('. '));
  return (lastStop > 40 ? cut.slice(0, lastStop + 1) : cut) + '…';
}

function extractEntities(text) {
  const found = [];
  for (const e of KNOWN_ENTITIES) {
    const hit = [e.name, ...e.variants].some((v) => text.includes(v));
    if (hit && !found.some((f) => f.name === e.name)) {
      found.push({ name: e.name, kind: e.kind });
    }
  }
  // 引号内容视为概念实体（「…」内的黑话）
  const quoted = text.match(/[「『]([^」』]{2,12})[」』]/g) ?? [];
  for (const q of quoted) {
    const name = q.slice(1, -1);
    if (!found.some((f) => f.name === name)) found.push({ name, kind: '概念' });
  }
  return found.slice(0, 8);
}

function makeRelations(entities, topic) {
  if (entities.length >= 2) {
    return [{ a: entities[0].name, rel: '共现于', b: entities[1].name }];
  }
  if (entities.length === 1 && topic) {
    return [{ a: entities[0].name, rel: '归属', b: topic }];
  }
  return [];
}

function newItemId() {
  const s = getStore();
  const id = 'c' + s.nextId;
  s.nextId += 1;
  return id;
}

// ——— 投喂受理 ———

/** 受理一批投喂：文本 + 图片（base64）。返回回执文案。 */
export function acceptFeed(text, images) {
  const s = getStore();
  const today = dateOnly();
  const created = [];

  if (text && text.trim()) {
    const t = text.trim();
    const { topic, conf } = classifyTopic(t);
    const id = newItemId();
    const item = {
      id,
      type: classifyType(t),
      topic,
      when: nowStamp(),
      source: '手动投喂',
      state: '待确认',
      conf: 0,
      title: makeTitle(t),
      summary: '排队整理中…',
      entities: [],
      relations: [],
      excerpt: t,
      log: [{ when: today, what: '收到投喂，排队整理' }],
      signal: '常规',
      weight: 0.5,
      calls: 0,
      lastCall: '—',
    };
    s.items.unshift(item);
    created.push(item);
  }

  for (const img of images ?? []) {
    const id = newItemId();
    // 图片落盘（agent 归档原文与截图）
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const safe = String(img.name || '截图.png').replace(/[^\w.\-一-龥]/g, '_');
    const file = `${id}-${safe}`;
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(img.data, 'base64'));
    } catch {
      // 落盘失败不阻塞整理
    }
    const { topic, conf } = classifyTopic(img.name || '');
    s.items.unshift({
      id,
      type: '截图',
      topic,
      when: nowStamp(),
      source: `uploads/${file}`,
      state: '待确认',
      conf: 0,
      title: `截图：${img.name || '未命名'}`,
      summary: 'OCR 识别中…',
      entities: [],
      relations: [],
      excerpt: `（截图 ${img.name || '未命名'}，已归档至 uploads/${file}）`,
      log: [{ when: today, what: '收到截图，排队 OCR 识别' }],
      signal: '常规',
      weight: 0.5,
      calls: 0,
      lastCall: '—',
    });
    created.push(s.items[0]);
    void conf;
  }

  commit();

  // 异步整理
  for (const item of created) {
    setTimeout(() => organizeItem(item.id), ORGANIZE_DELAY_MS + Math.random() * 800);
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

// ——— 异步整理 ———

function organizeItem(id) {
  const s = getStore();
  const item = s.items.find((i) => i.id === id);
  if (!item) return;
  const today = dateOnly();

  if (item.type === '截图') {
    // OCR 模拟：从文件名与归档路径生成可读摘要
    item.summary = `agent 已 OCR 识别并归类这张截图（原型模拟）。文件归档于 ${item.source}，识别出的界面文字已并入检索索引。`;
    item.entities = extractEntities(item.excerpt);
  } else {
    item.summary = summarize(item.excerpt);
    item.entities = extractEntities(item.excerpt + ' ' + item.title);
  }

  const { topic, conf } = classifyTopic(item.excerpt);
  item.topic = topic;
  item.conf = Math.max(0, Math.min(0.99, conf));
  item.relations = makeRelations(item.entities, item.topic);
  item.state = item.conf < 0.5 ? '待确认' : '已整理';
  item.log.push({ when: today, what: `生成摘要，抽取 ${item.entities.length} 个实体` });
  item.log.push({ when: today, what: `归入主题「${item.topic}」（置信度 ${item.conf.toFixed(2)}）` });

  // 「并调整了 N 条旧记忆的权重」：同主题旧条目微调
  const siblings = s.items.filter(
    (i) => i.id !== item.id && i.topic === item.topic && i.signal === '常规',
  );
  const adjusted = siblings.slice(0, 3);
  for (const sib of adjusted) {
    const delta = (Math.random() - 0.4) * 0.12; // 整体偏降权（新证据稀释旧权重）
    sib.weight = Math.max(0.02, Math.min(0.98, sib.weight + delta));
    sib.log.push({ when: today, what: 'agent 因新材料入库微调了检索权重' });
  }

  s.pending += 1;
  s.latestId = item.id;
  s.lastAdjustCount = adjusted.length;
  commit();
}

// ——— 人类信号（唯一可写） ———

const SIGNAL_WEIGHT = { 重要: 0.96, 常规: null, 不重要: 0.12, 忘掉: 0.02 };
const SIGNAL_LABEL = { 重要: '很重要', 常规: '常规', 不重要: '不重要了', 忘掉: '可以忘掉' };

export function applySignal(id, signal) {
  const s = getStore();
  const item = s.items.find((i) => i.id === id);
  if (!item || !(signal in SIGNAL_WEIGHT)) return null;
  const w = SIGNAL_WEIGHT[signal];
  item.signal = signal;
  if (w !== null) item.weight = w;
  item.log.push({ when: dateOnly(), what: `人工信号：${SIGNAL_LABEL[signal]}，下一轮将调整保留策略` });
  commit();
  return `已告诉 agent：「${item.title}」${SIGNAL_LABEL[signal]}，它会在下一轮调整权重与保留策略。`;
}

export function regenerateItem(id) {
  const s = getStore();
  const item = s.items.find((i) => i.id === id);
  if (!item) return null;
  if (item.type === '截图') {
    item.summary = `agent 重新跑了一次 OCR 与摘要（原型模拟）：${item.summary}`;
  } else {
    // 换个截取视角：从第二句开始重摘
    const flat = item.excerpt.replace(/\s+/g, ' ').trim();
    const second = flat.slice(Math.min(60, Math.floor(flat.length / 3)));
    item.summary = summarize(second) || item.summary;
  }
  item.entities = extractEntities(item.excerpt + ' ' + item.title);
  item.log.push({ when: dateOnly(), what: '重新生成摘要与实体抽取' });
  commit();
  return `已让 agent 为「${item.title}」重跑一次摘要与实体抽取。`;
}

// ——— 自然语言指令 ———

export function runInstruction(text) {
  const t = (text ?? '').trim();
  if (!t) return '';
  const s = getStore();
  const today = dateOnly();

  if (/时间线/.test(t)) {
    const targets = s.items
      .filter((i) => i.topic.includes('Aurora') && i.type === '会议纪要')
      .sort((a, b) => b.when.localeCompare(a.when));
    for (const i of targets) {
      i.log.push({ when: today, what: '已纳入「Aurora 会议时间线」合成' });
    }
    commit();
    return `agent 已把 ${targets.length} 条 Aurora 会议纪要按时间合成时间线（最新：${targets[0]?.title ?? '无'}），结果已写回各条整理记录。`;
  }

  if (/合并|去重/.test(t)) {
    const seen = new Map();
    const dropped = [];
    for (const i of [...s.items].sort((a, b) => b.when.localeCompare(a.when))) {
      const key = i.title.replace(/\s/g, '');
      if (seen.has(key)) {
        const keep = seen.get(key);
        keep.calls += i.calls;
        keep.log.push({ when: today, what: `与重复条目 ${i.id}「${i.title}」合并（被调用次数累加）` });
        dropped.push(i.id);
      } else {
        seen.set(key, i);
      }
    }
    if (dropped.length) {
      s.items = s.items.filter((i) => !dropped.includes(i.id));
      commit();
      return `agent 合并了 ${dropped.length} 条重复条目（${dropped.join('、')}），调用统计已并入保留条目。`;
    }
    commit();
    return 'agent 扫描了全部条目，本轮没有发现标题完全重复的条目。';
  }

  if (/实体/.test(t)) {
    let changed = 0;
    for (const i of s.items) {
      const before = JSON.stringify(i.entities);
      i.entities = extractEntities(i.excerpt + ' ' + i.title);
      if (JSON.stringify(i.entities) !== before) changed += 1;
    }
    commit();
    return `agent 已对全部 ${s.items.length} 条 context 重跑实体抽取，${changed} 条的实体列表有更新。`;
  }

  return `指令「${t}」已受理，agent 将在下一轮整理中评估执行。`;
}

// ——— 工具开关 ———

export function toggleTool(id) {
  const s = getStore();
  const tool = s.tools.find((t) => t.id === id);
  if (!tool) return null;
  tool.on = !tool.on;
  commit();
  return tool.on;
}

// ——— 提示条 ———

export function clearPending() {
  const s = getStore();
  s.pending = 0;
  commit();
}
