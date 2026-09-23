import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import ContextList from './components/ContextList';
import ChatPanel from './components/ChatPanel';
import DetailPanel from './components/DetailPanel';
import { useNarrow } from './hooks/useNarrow';
import {
  fetchState,
  postRegenerate,
  postSignal,
  postToggleTool,
} from './api';
import type { ChatState } from './api';
import type { AgentTool, ContextItem, Signal } from './types';

/** Tweaks（设计稿上的可调项，按默认值实现）。 */
const DENSITY = '舒适' as '舒适' | '紧凑';
const SHOW_ENTITIES = true;
const SHOW_AGENT_LOG = true;

/** 状态轮询间隔：agent 异步整理完成后前端据此感知更新。 */
const POLL_MS = 2000;

/** 文境 Contexta — Agent 维护的上下文记忆库，人只投喂与给信号。
 *  数据在服务端（整理 agent 拥有数据），本地仅持有轮询快照与视图状态。
 */
export default function App() {
  const [items, setItems] = useState<ContextItem[]>([]);
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [loaded, setLoaded] = useState(false);
  const latestIdRef = useRef<string | null>(null);

  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState('全部');
  const [type, setType] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatState>({ messages: [], pendingOps: [], mode: 'approve' });
  const [rightTab, setRightTab] = useState<'agent' | 'detail'>('agent');

  const narrow = useNarrow(900);

  const syncState = useCallback(async () => {
    try {
      const s = await fetchState();
      setItems(s.items);
      setTools(s.tools);
      setChat(s.chat ?? { messages: [], pendingOps: [], mode: 'approve' });
      latestIdRef.current = s.latestId;
      setLoaded(true);
    } catch {
      setLoaded(true); // 显示空态而非白屏，回执会提示通信失败
    }
  }, []);

  useEffect(() => {
    void syncState();
    const timer = setInterval(() => void syncState(), POLL_MS);
    return () => clearInterval(timer);
  }, [syncState]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
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
  }, [items, query, topic, type]);

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  );

  // 窄屏：选中条目后详情替换中列；未选中显示列表。
  const showSidebar = !narrow;
  const showDetail = narrow ? !!selected : true;

  /** 人类信号：唯一可写动作，agent 在服务端写权重并出回执。 */
  const handleSignal = async (id: string, signal: Signal) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    try {
      await postSignal(id, signal);
      void syncState();
    } catch {
      /* 信号失败由轮询自愈 */
    }
  };

  const handleRegenerate = async (item: ContextItem) => {
    try {
      await postRegenerate(item.id);
      void syncState();
    } catch {
      /* 重新生成失败由轮询自愈 */
    }
  };

  const toggleTool = async (id: string) => {
    // 乐观更新，失败回滚由轮询纠正
    setTools((prev) => prev.map((t) => (t.id === id ? { ...t, on: !t.on } : t)));
    try {
      const { tools } = await postToggleTool(id);
      setTools(tools);
    } catch {
      void syncState();
    }
  };

  const pickEntity = (name: string) => {
    setQuery(name);
    setTopic('全部');
    setType(null);
  };

  const listTitle = topic === '全部' ? '全部 context' : topic;

  if (!loaded) {
    return (
      <div className="app">
        <div className="stream-empty" style={{ padding: 'var(--space-8)' }}>
          正在连接整理 agent…
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Header query={query} onQuery={setQuery} items={items} />

      <div className={'app-grid' + (narrow ? ' narrow' : '')}>
        {showSidebar && (
          <Sidebar
            items={items}
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
            total={items.length}
            title={listTitle}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setRightTab('detail');
            }}
            dense={DENSITY === '紧凑'}
          />
        </section>

        {showDetail && (
          <div className="chat-panel">
            <div className="right-tabs">
              <button
                className={'right-tab' + (rightTab === 'agent' ? ' on' : '')}
                onClick={() => setRightTab('agent')}
              >
                Agent
              </button>
              <button
                className={'right-tab' + (rightTab === 'detail' ? ' on' : '')}
                onClick={() => setRightTab('detail')}
              >
                详情
                {selected && <span className="right-tab-dot" />}
              </button>
            </div>
            {rightTab === 'agent' && <ChatPanel chat={chat} onSync={() => void syncState()} />}
            {rightTab === 'detail' && (
              <DetailPanel
                item={selected}
                narrow={narrow}
                onClose={() => setRightTab('agent')}
                onSignal={handleSignal}
                onRegenerate={handleRegenerate}
                showAgentLog={SHOW_AGENT_LOG}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
