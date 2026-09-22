import type { AgentTool, ContextItem, ToolStatus } from '../types';

/** 近两周入库柱状图的日期窗口（14 天，MM-DD）。 */
function sparkDays(): string[] {
  const days: string[] = [];
  for (let d = 7; d <= 20; d++) days.push('09-' + String(d).padStart(2, '0'));
  return days;
}

interface SidebarProps {
  items: ContextItem[];
  topic: string;
  onTopic: (topic: string) => void;
  type: string | null;
  onType: (type: string | null) => void;
  query: string;
  onEntityPick: (name: string) => void;
  tools: AgentTool[];
  onToggleTool: (id: string) => void;
  /** Tweaks：是否显示左栏「高频实体」。 */
  showEntities?: boolean;
}

interface TopicRow {
  name: string;
  count: number;
  barW: string;
}

interface EntityRow {
  name: string;
  kind: string;
  count: number;
}

interface SparkBar {
  day: string;
  count: number;
  h: number;
  empty: boolean;
}

function toolDotClass(status: ToolStatus): string {
  if (status === '离线') return 'tool-dot off';
  if (status === '占用') return 'tool-dot busy';
  return 'tool-dot';
}

/** 左栏 · 导航与状态：主题 / 类型 / 高频实体 / 工具 / 近两周入库。 */
export default function Sidebar({
  items,
  topic,
  onTopic,
  type,
  onType,
  query,
  onEntityPick,
  tools,
  onToggleTool,
  showEntities = true,
}: SidebarProps) {
  // — 主题统计（含「全部」）—
  const topicCount = new Map<string, number>();
  items.forEach((i) => topicCount.set(i.topic, (topicCount.get(i.topic) ?? 0) + 1));
  const total = items.length;
  const maxTopic = Math.max(1, ...topicCount.values());
  const knownTopics = [...new Set(items.map((i) => i.topic))];
  const topicRows: TopicRow[] = [
    { name: '全部', count: total, barW: '100%' },
    ...knownTopics.map((name) => ({
      name,
      count: topicCount.get(name) ?? 0,
      barW: Math.round(((topicCount.get(name) ?? 0) / maxTopic) * 100) + '%',
    })),
  ];

  // — 类型（来自数据中出现过的类型）—
  const typeNames = [...new Set(items.map((i) => i.type))];

  // — 高频实体：按出现次数降序取前 8 —
  const entityMap = new Map<string, EntityRow>();
  items.forEach((i) =>
    i.entities.forEach((e) => {
      const row = entityMap.get(e.name) ?? { name: e.name, kind: e.kind, count: 0 };
      row.count += 1;
      entityMap.set(e.name, row);
    }),
  );
  const entityRows = [...entityMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // — 近两周入库：14 根柱 —
  const dayCount = new Map<string, number>();
  items.forEach((i) => {
    const key = i.when.slice(0, 5);
    dayCount.set(key, (dayCount.get(key) ?? 0) + 1);
  });
  const days = sparkDays();
  const maxDay = Math.max(1, ...dayCount.values());
  const sparkBars: SparkBar[] = days.map((day) => {
    const c = dayCount.get(day) ?? 0;
    return {
      day,
      count: c,
      h: c ? Math.max(6, Math.round((c / maxDay) * 40)) : 2,
      empty: !c,
    };
  });

  const enabledCount = tools.filter((t) => t.on).length;

  return (
    <aside className="sidebar">
      {/* (a) 主题 */}
      <div className="sidebar-block">
        <div className="sidebar-block-title">主题</div>
        <div className="topic-list">
          {topicRows.map((t) => (
            <div
              key={t.name}
              className={'topic-item' + (topic === t.name ? ' active' : '')}
              onClick={() => onTopic(t.name)}
            >
              <div className="topic-item-top">
                <span>{t.name}</span>
                <span className="topic-count">{t.count}</span>
              </div>
              <div className="topic-bar">
                <div className="topic-bar-fill" style={{ width: t.barW }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* (b) 类型 */}
      <div className="sidebar-block">
        <div className="sidebar-block-title">类型</div>
        <div className="type-list">
          {typeNames.map((name) => (
            <span
              key={name}
              className={'tag tag-outline type-tag' + (type === name ? ' on' : '')}
              onClick={() => onType(type === name ? null : name)}
            >
              {name}
            </span>
          ))}
        </div>
      </div>

      {/* (c) 高频实体 */}
      {showEntities && (
        <div className="sidebar-block">
          <div className="sidebar-block-head">
            <span className="sidebar-block-title">高频实体</span>
            <span className="sidebar-block-head-note">agent 抽取</span>
          </div>
          <div className="entity-list">
            {entityRows.map((e) => (
              <div
                key={e.name}
                className={
                  'entity-item' + (query === e.name ? ' matched' : '')
                }
                onClick={() => onEntityPick(e.name)}
              >
                <span className="entity-name">{e.name}</span>
                <span className="entity-meta">
                  {e.kind} {e.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="hr" style={{ margin: 'var(--space-6) 0 var(--space-3)' }} />

      {/* (d) Agent 可用工具 */}
      <div className="sidebar-block" style={{ marginBottom: 0 }}>
        <div className="sidebar-block-head">
          <span className="sidebar-block-title">Agent 可用工具</span>
          <span className="sidebar-block-head-note num">
            {enabledCount}/{tools.length} 启用
          </span>
        </div>
        <div className="tool-list">
          {tools.map((t) => (
            <div
              key={t.id}
              className={'tool-item' + (t.on ? ' on' : '')}
              onClick={() => onToggleTool(t.id)}
            >
              <span className={toolDotClass(t.status)} />
              <span className="tool-main">
                <span className="tool-name">{t.name}</span>
                <span className="tool-meta">{t.meta}</span>
              </span>
              <span className={'tool-state' + (t.status === '离线' ? ' off' : '')}>
                {t.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="hr" style={{ margin: 'var(--space-6) 0 var(--space-3)' }} />

      {/* (e) 近两周入库 */}
      <div className="sidebar-block" style={{ marginBottom: 0 }}>
        <div className="sidebar-block-title">近两周入库</div>
        <div className="spark">
          {sparkBars.map((b) => (
            <div
              key={b.day}
              className={'spark-bar' + (b.empty ? ' empty' : '')}
              style={{ height: b.h + 'px' }}
              title={`${b.day} · ${b.count} 条`}
            />
          ))}
        </div>
        <div className="spark-caption">
          <span>{days[0]}</span>
          <span>{days[days.length - 1]}</span>
        </div>
      </div>
    </aside>
  );
}
