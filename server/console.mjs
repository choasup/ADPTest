/** 控制台操作执行器 — 平台无关。
 *  LLM（llm.mjs 路由）输出意图 JSON，本模块在 items 上执行确定性 CRUD。
 *  LLM 不直接碰数据：所有操作在这里落库，可靠可审计。
 */

const VALID_TYPES = ['会议纪要', '对话片段', '文档', '链接剪藏', '灵感', '截图'];
const VALID_TOPICS = ['项目 · Aurora', '记忆系统研究', '个人灵感', '竞品观察', '商务', '待归类'];

/** 按关键词在标题/摘要/原文上匹配条目（大小写不敏感），返回 id 列表。
 *  精确子串优先；无命中时用 2 字滑窗宽松召回（LLM 抽取的 target
 *  常是描述性短语，如「评测集的重复条目」，需模糊匹配）。 */
export function matchItems(items, target) {
  const t = String(target || '').trim().toLowerCase();
  if (!t || t === 'all') return items.map((i) => i.id);
  const hay = (i) => (i.title + i.summary + i.excerpt).toLowerCase();
  const exact = items.filter((i) => hay(i).includes(t));
  if (exact.length) return exact.map((i) => i.id);
  const grams = new Set();
  for (let k = 0; k < t.length - 1; k++) grams.add(t.slice(k, k + 2));
  return items
    .filter((i) => {
      const h = hay(i);
      for (const g of grams) if (h.includes(g)) return true;
      return false;
    })
    .map((i) => i.id);
}

/**
 * 执行控制台意图。
 * @param {Array} items 库内条目（就地修改，add/delete 由调用方回写）
 * @param {{op:string, data:object, reply:string}} intent LLM 路由结果
 * @param {object} ctx {nextId(), dateOnly()} id 分配器
 * @returns {{runLog:string, effects?:{added?:string[], deleted?:string[], updated?:string[], queryIds?:string[]}}}
 */
export function runConsole(items, intent, ctx) {
  const op = intent && intent.op;
  const data = (intent && intent.data) || {};
  const reply = (intent && intent.reply) || '';
  const today = ctx.dateOnly ? ctx.dateOnly() : '';

  if (op === 'add') {
    const id = ctx.nextId();
    const item = {
      id,
      type: VALID_TYPES.includes(data.type) ? data.type : '对话片段',
      topic: VALID_TOPICS.includes(data.topic) ? data.topic : '待归类',
      when: ctx.nowStamp ? ctx.nowStamp() : '',
      source: '控制台投喂',
      state: data.conf < 0.5 ? '待确认' : '已整理',
      conf: Math.max(0, Math.min(0.99, Number(data.conf) || 0.5)),
      title: String(data.title || '').slice(0, 30) || '未命名',
      summary: String(data.summary || '').slice(0, 220),
      entities: Array.isArray(data.entities)
        ? data.entities.filter((e) => e && e.name).slice(0, 8)
            .map((e) => ({ name: String(e.name).slice(0, 24), kind: String(e.kind || '概念').slice(0, 10) }))
        : [],
      relations: Array.isArray(data.relations)
        ? data.relations.filter((r) => r && r.a && r.b).slice(0, 5)
            .map((r) => ({ a: String(r.a).slice(0, 24), rel: String(r.rel || '关联').slice(0, 12), b: String(r.b).slice(0, 24) }))
        : [],
      excerpt: ctx.rawInput || '',
      log: [{ when: today, what: '控制台投喂，经 LLM 整理' }],
      signal: '常规',
      weight: data.noise ? 0.1 : 0.5,
      calls: 0,
      lastCall: '—',
    };
    if (data.noise) {
      item.state = '待确认';
      item.summary = '（噪声，建议低权重归档）';
      item.log.push({ when: today, what: 'LLM 判定为噪声，已降权待归档' });
    }
    items.unshift(item);
    return {
      runLog: reply || `已新增 1 条 context「${item.title}」。`,
      effects: { added: [id] },
    };
  }

  if (op === 'delete') {
    const ids = matchItems(items, data.target || data.keyword);
    if (!ids.length) {
      return { runLog: `没有找到与「${data.target || ''}」匹配的 context，未删除。` };
    }
    const titles = items.filter((i) => ids.includes(i.id)).map((i) => `「${i.title}」`);
    for (let k = items.length - 1; k >= 0; k--) {
      if (ids.includes(items[k].id)) items.splice(k, 1);
    }
    const brief = titles.length > 5 ? titles.slice(0, 5).join('、') + ` 等 ${titles.length} 条` : titles.join('、');
    return {
      runLog: `已删除 ${ids.length} 条：${brief}。`,
      effects: { deleted: ids },
    };
  }

  if (op === 'update') {
    const ids = matchItems(items, data.target);
    if (!ids.length) {
      return { runLog: `没有找到与「${data.target || ''}」匹配的 context，未修改。` };
    }
    const fields = data.fields || {};
    const updated = [];
    for (const i of items) {
      if (!ids.includes(i.id)) continue;
      const changes = [];
      if (fields.title) { i.title = String(fields.title).slice(0, 30); changes.push('标题'); }
      if (fields.summary) { i.summary = String(fields.summary).slice(0, 220); changes.push('摘要'); }
      if (fields.topic && VALID_TOPICS.includes(fields.topic)) { i.topic = fields.topic; changes.push('主题'); }
      if (changes.length) {
        i.log.push({ when: today, what: `控制台修改：${changes.join('、')}` });
        updated.push(i.id);
      }
    }
    return {
      runLog: updated.length
        ? `已修改 ${updated.length} 条（${ids.length} 条匹配）。`
        : '指令中没有可修改的字段。',
      effects: { updated },
    };
  }

  if (op === 'query') {
    const q = String(data.text || '').trim().toLowerCase();
    const topic = data.topic;
    const type = data.type;
    // 「会议记录/会议」类关键词自动映射类型过滤（LLM 常抽 text=会议记录 + type=会议纪要）
    const isMeetingQuery = /会议/.test(q) || type === '会议纪要';
    const qq = q.replace(/会议记录|会议/g, '').trim();
    const hits = items.filter((i) => {
      if (topic && i.topic !== topic) return false;
      if (type && i.type !== type) return false;
      if (isMeetingQuery && i.type !== '会议纪要' && !String(i.source).includes('腾讯会议')) return false;
      if (!qq) return true;
      return (i.title + i.summary + i.excerpt + i.entities.map((e) => e.name).join('')).toLowerCase().includes(qq);
    });
    const names = hits.slice(0, 8).map((i) => `「${i.title}」`).join('、');
    return {
      runLog: hits.length
        ? `找到 ${hits.length} 条：${names}${hits.length > 8 ? ' …' : ''}。`
        : `没有找到匹配「${data.text || ''}」的 context。`,
      effects: { queryIds: hits.map((i) => i.id) },
    };
  }

  if (op === 'sync_meetings') {
    const meetings = Array.isArray(data.meetings) ? data.meetings : [];
    // 由调用方（DO）接管真实导入；这里只回执（console 保持纯函数，
    // sync 涉及 state.syncedMeetingIds 与 alarm 排队，属 DO 职责）
    return {
      runLog: reply || `收到 ${meetings.length} 场会议待同步。`,
      effects: { syncMeetings: meetings, hasMore: !!data.hasMore },
    };
  }

  if (op === 'stats') {
    const byTopic = {};
    for (const i of items) byTopic[i.topic] = (byTopic[i.topic] || 0) + 1;
    const detail = Object.entries(byTopic).map(([t, n]) => `${t} ${n} 条`).join('，');
    return {
      runLog: `库内共 ${items.length} 条 context${detail ? '：' + detail : ''}。`,
      effects: {},
    };
  }

  // none / 未知：纯回复
  return { runLog: reply || '已收到。', effects: {} };
}
