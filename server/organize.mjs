/** 平台无关的整理逻辑 — Node Express 与 Cloudflare Worker(DO) 共用。
 *  不含任何 Node 内建（fs/timer）或 Workers API；副作用只通过参数与返回值。
 */

// ——— 词典与规则（来自既有 context 的实体沉淀）———

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

// ——— 时间 ———

export function nowStamp() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function dateOnly() {
  return nowStamp().slice(0, 5);
}

// ——— 整理原语 ———

export function classifyTopic(text) {
  for (const rule of TOPIC_RULES) {
    if (rule.keys.some((k) => text.includes(k))) {
      return { topic: rule.topic, conf: rule.conf + (Math.random() - 0.5) * 0.08 };
    }
  }
  return { topic: '待归类', conf: 0.35 + Math.random() * 0.2 };
}

export function classifyType(text) {
  for (const rule of TYPE_RULES) if (rule.test(text)) return rule.type;
  return '对话片段';
}

export function makeTitle(text) {
  const firstLine = text.split('\n').find((l) => l.trim()) ?? text;
  const core = firstLine.replace(/^[\s"'「『（(]+|[\s"'」』）)].*$/g, '').trim();
  const candidate = core.length > 24 ? core.slice(0, 24) + '…' : core || '未命名片段';
  return candidate.length < 8 ? candidate + '（新投喂）' : candidate;
}

export function summarize(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 110) return flat;
  const cut = flat.slice(0, 110);
  const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('. '));
  return (lastStop > 40 ? cut.slice(0, lastStop + 1) : cut) + '…';
}

export function extractEntities(text) {
  const found = [];
  for (const e of KNOWN_ENTITIES) {
    const hit = [e.name, ...e.variants].some((v) => text.includes(v));
    if (hit && !found.some((f) => f.name === e.name)) {
      found.push({ name: e.name, kind: e.kind });
    }
  }
  const quoted = text.match(/[「『]([^」』]{2,12})[」』]/g) ?? [];
  for (const q of quoted) {
    const name = q.slice(1, -1);
    if (!found.some((f) => f.name === name)) found.push({ name, kind: '概念' });
  }
  return found.slice(0, 8);
}

export function makeRelations(entities, topic) {
  if (entities.length >= 2) {
    return [{ a: entities[0].name, rel: '共现于', b: entities[1].name }];
  }
  if (entities.length === 1 && topic) {
    return [{ a: entities[0].name, rel: '归属', b: topic }];
  }
  return [];
}

// ——— 投喂受理：创建待确认条目 ———

/** 文本投喂 → 新条目（待确认，排队整理）。id 由调用方分配。 */
export function createItemFromText(id, text) {
  const t = text.trim();
  const { topic } = classifyTopic(t);
  void topic; // 受理阶段不写归类，整理时再定
  return {
    id,
    type: classifyType(t),
    topic: '待归类',
    when: nowStamp(),
    source: '手动投喂',
    state: '待确认',
    conf: 0,
    title: makeTitle(t),
    summary: '排队整理中…',
    entities: [],
    relations: [],
    excerpt: t,
    log: [{ when: dateOnly(), what: '收到投喂，排队整理' }],
    signal: '常规',
    weight: 0.5,
    calls: 0,
    lastCall: '—',
  };
}

/** 图片投喂 → 新截图条目（待确认，排队 OCR）。id / file 由调用方分配。 */
export function createItemFromImage(id, name, file) {
  const { topic } = classifyTopic(name || '');
  void topic;
  return {
    id,
    type: '截图',
    topic: '待归类',
    when: nowStamp(),
    source: `uploads/${file}`,
    state: '待确认',
    conf: 0,
    title: `截图：${name || '未命名'}`,
    summary: 'OCR 识别中…',
    entities: [],
    relations: [],
    excerpt: `（截图 ${name || '未命名'}，已归档至 uploads/${file}）`,
    log: [{ when: dateOnly(), what: '收到截图，排队 OCR 识别' }],
    signal: '常规',
    weight: 0.5,
    calls: 0,
    lastCall: '—',
  };
}

// ——— 异步整理：条目就位（在调用方持有 items 的上下文中 mutate）———

export function organizeItem(item) {
  const today = dateOnly();

  if (item.type === '截图') {
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
}

/** 「调整了 N 条旧记忆的权重」：同主题旧条目微调，返回被调整的条数。 */
export function adjustSiblingWeights(items, topic, excludeId) {
  const siblings = items.filter(
    (i) => i.id !== excludeId && i.topic === topic && i.signal === '常规',
  );
  const adjusted = siblings.slice(0, 3);
  const today = dateOnly();
  for (const sib of adjusted) {
    const delta = (Math.random() - 0.4) * 0.12;
    sib.weight = Math.max(0.02, Math.min(0.98, sib.weight + delta));
    sib.log.push({ when: today, what: 'agent 因新材料入库微调了检索权重' });
  }
  return adjusted.length;
}

// ——— 人类信号（唯一可写） ———

const SIGNAL_WEIGHT = { 重要: 0.96, 常规: null, 不重要: 0.12, 忘掉: 0.02 };
const SIGNAL_LABEL = { 重要: '很重要', 常规: '常规', 不重要: '不重要了', 忘掉: '可以忘掉' };

export function applySignalToItem(item, signal) {
  if (!(signal in SIGNAL_WEIGHT)) return null;
  const w = SIGNAL_WEIGHT[signal];
  item.signal = signal;
  if (w !== null) item.weight = w;
  item.log.push({ when: dateOnly(), what: `人工信号：${SIGNAL_LABEL[signal]}，下一轮将调整保留策略` });
  return `已告诉 agent：「${item.title}」${SIGNAL_LABEL[signal]}，它会在下一轮调整权重与保留策略。`;
}

// ——— 重新生成 ———

export function regenerateItemSummary(item) {
  if (item.type === '截图') {
    item.summary = `agent 重新跑了一次 OCR 与摘要（原型模拟）：${item.summary}`;
  } else {
    const flat = item.excerpt.replace(/\s+/g, ' ').trim();
    const second = flat.slice(Math.min(60, Math.floor(flat.length / 3)));
    item.summary = summarize(second) || item.summary;
  }
  item.entities = extractEntities(item.excerpt + ' ' + item.title);
  item.log.push({ when: dateOnly(), what: '重新生成摘要与实体抽取' });
  return `已让 agent 为「${item.title}」重跑一次摘要与实体抽取。`;
}

// ——— 自然语言指令（真实执行） ———

/** 就地处理 items，返回回执文案。 */
export function runInstructionOnItems(items, text) {
  const t = (text ?? '').trim();
  if (!t) return '';
  const today = dateOnly();

  if (/时间线/.test(t)) {
    const targets = items
      .filter((i) => i.topic.includes('Aurora') && i.type === '会议纪要')
      .sort((a, b) => b.when.localeCompare(a.when));
    for (const i of targets) {
      i.log.push({ when: today, what: '已纳入「Aurora 会议时间线」合成' });
    }
    return `agent 已把 ${targets.length} 条 Aurora 会议纪要按时间合成时间线（最新：${targets[0]?.title ?? '无'}），结果已写回各条整理记录。`;
  }

  if (/合并|去重/.test(t)) {
    const seen = new Map();
    const dropped = [];
    for (const i of [...items].sort((a, b) => b.when.localeCompare(a.when))) {
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
      for (let k = items.length - 1; k >= 0; k--) {
        if (dropped.includes(items[k].id)) items.splice(k, 1);
      }
      return `agent 合并了 ${dropped.length} 条重复条目（${dropped.join('、')}），调用统计已并入保留条目。`;
    }
    return 'agent 扫描了全部条目，本轮没有发现标题完全重复的条目。';
  }

  if (/实体/.test(t)) {
    let changed = 0;
    for (const i of items) {
      const before = JSON.stringify(i.entities);
      i.entities = extractEntities(i.excerpt + ' ' + i.title);
      if (JSON.stringify(i.entities) !== before) changed += 1;
    }
    return `agent 已对全部 ${items.length} 条 context 重跑实体抽取，${changed} 条的实体列表有更新。`;
  }

  return `指令「${t}」已受理，agent 将在下一轮整理中评估执行。`;
}
