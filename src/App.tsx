import { useMemo, useState } from 'react';
import Header from './components/Header';
import AgentNotice from './components/AgentNotice';
import Sidebar from './components/Sidebar';
import ContextList from './components/ContextList';
import FeedBar from './components/FeedBar';
import DetailPanel from './components/DetailPanel';
import { useNarrow } from './hooks/useNarrow';
import { INITIAL_ITEMS, INITIAL_TOOLS } from './data';
import { SIGNAL_LABEL, SIGNAL_WEIGHT } from './types';
import type { AgentTool, ContextItem, Signal } from './types';

/** Tweaks（设计稿上的可调项，按默认值实现）。 */
const DENSITY = '舒适' as '舒适' | '紧凑';
const SHOW_ENTITIES = true;
const SHOW_AGENT_LOG = true;

/** 文境 Contexta — Agent 维护的上下文记忆库，人只投喂与给信号。 */
export default function App() {
  const [items, setItems] = useState<ContextItem[]>(INITIAL_ITEMS);
  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState('全部');
  const [type, setType] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>('c1');
  const [instruction, setInstruction] = useState('');
  const [runLog, setRunLog] = useState('');
  const [tools, setTools] = useState<AgentTool[]>(INITIAL_TOOLS);
  const [pending, setPending] = useState(2);

  const narrow = useNarrow(900);

  const visible = useMemo(() => items, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visible.filter((i) => {
      if (topic !== '全部' && i.topic !== topic) return false;
      if (type && i.type !== type) return false;
      if (!q) return true;
      const hay = (
        i.title +
        i.summary +
        i.excerpt +
        i.entities.map((e) => e.name).join('')
      ).toLowerCase();
      return hay.includes(q);
    });
  }, [visible, query, topic, type]);

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  );

  // 窄屏：选中条目后详情替换中列；未选中显示列表。
  const showSidebar = !narrow;
  const showDetail = narrow ? !!selected : true;

  /** 人类信号：唯一可写动作，写权重并出回执。 */
  const handleSignal = (id: string, signal: Signal) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    const w = SIGNAL_WEIGHT[signal];
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, signal, weight: w === null ? i.weight : w } : i)),
    );
    setRunLog(
      `已告诉 agent：「${item.title}」${SIGNAL_LABEL[signal]}，它会在下一轮调整权重与保留策略。`,
    );
  };

  const handleRegenerate = (item: ContextItem) => {
    setRunLog(`已让 agent 为「${item.title}」重跑一次摘要与实体抽取。`);
  };

  /** 提示条动作：清空筛选，跳到最近整理的条目。 */
  const reviewPending = () => {
    setTopic('全部');
    setType(null);
    setQuery('');
    setSelectedId('c3');
    setPending(0);
    setRunLog('已定位到 agent 最近整理的条目。');
  };

  const toggleTool = (id: string) => {
    setTools((prev) => prev.map((t) => (t.id === id ? { ...t, on: !t.on } : t)));
  };

  const pickEntity = (name: string) => {
    setQuery(name);
    setTopic('全部');
    setType(null);
  };

  const listTitle = topic === '全部' ? '全部 context' : topic;

  return (
    <div className="app">
      <Header query={query} onQuery={setQuery} items={visible} />

      <AgentNotice pending={pending} onReview={reviewPending} />

      <div className={'app-grid' + (narrow ? ' narrow' : '')}>
        {showSidebar && (
          <Sidebar
            items={visible}
            topic={topic}
            onTopic={setTopic}
            type={type}
            onType={setType}
            query={query}
            onEntityPick={pickEntity}
            tools={tools}
            onToggleTool={toggleTool}
            showEntities={SHOW_ENTITIES}
          />
        )}

        <section
          className="stream"
          style={narrow && selected ? { display: 'none' } : undefined}
        >
          <ContextList
            filtered={filtered}
            total={visible.length}
            title={listTitle}
            selectedId={selectedId}
            onSelect={setSelectedId}
            dense={DENSITY === '紧凑'}
          />
          <FeedBar
            instruction={instruction}
            onInstruction={setInstruction}
            onRunLog={setRunLog}
            runLog={runLog}
            tools={tools}
          />
        </section>

        {showDetail && (
          <DetailPanel
            item={selected}
            narrow={narrow}
            onClose={() => setSelectedId(null)}
            onSignal={handleSignal}
            onRegenerate={handleRegenerate}
            showAgentLog={SHOW_AGENT_LOG}
          />
        )}
      </div>
    </div>
  );
}
