import { SIGNAL_LABEL } from '../types';
import type { ContextItem, ContextEntity, Signal } from '../types';

interface DetailPanelProps {
  item: ContextItem | null;
  narrow: boolean;
  onClose: () => void;
  onSignal: (id: string, signal: Signal) => void;
  onRegenerate: (item: ContextItem) => void;
  /** Tweaks：是否显示「整理记录」。 */
  showAgentLog?: boolean;
}

interface GraphNode {
  name: string;
  cx: number;
  cy: number;
  left: string;
  right: string;
  top: string;
}

const SIGNAL_ORDER: Signal[] = ['重要', '常规', '不重要', '忘掉'];

/** 实体按椭圆均布：中心 hub (170,95)，半径 x 88 / y 62。 */
function layoutNodes(entities: ContextEntity[]): GraphNode[] {
  const n = entities.length;
  return entities.map((e, k) => {
    const ang = -Math.PI / 2 + (k * 2 * Math.PI) / Math.max(1, n);
    const cx = 170 + Math.cos(ang) * 88;
    const cy = 95 + Math.sin(ang) * 62;
    const rightSide = Math.cos(ang) >= 0;
    return {
      name: e.name,
      cx: Math.round(cx),
      cy: Math.round(cy),
      left: rightSide ? (((cx + 9) / 340) * 100).toFixed(2) + '%' : 'auto',
      right: rightSide
        ? 'auto'
        : (((340 - cx + 9) / 340) * 100).toFixed(2) + '%',
      top: ((cy / 190) * 100).toFixed(2) + '%',
    };
  });
}

/** 右栏 · 详情：agent 整理结果的只读观察窗 + 唯一可写的信号。 */
export default function DetailPanel({
  item,
  narrow,
  onClose,
  onSignal,
  onRegenerate,
  showAgentLog = true,
}: DetailPanelProps) {
  if (!item) {
    return (
      <aside className="detail">
        <div className="detail-empty">选一条 context 查看 agent 的整理结果。</div>
      </aside>
    );
  }

  const graphNodes = layoutNodes(item.entities);

  return (
    <aside className="detail">
      {/* 1. 来源行 */}
      <div className="detail-src">
        <span className="kicker accent">{item.type}</span>
        <span className="detail-src-line">
          {item.source} · {item.when}
        </span>
        <span style={{ flex: 1 }} />
        {narrow && (
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            返回
          </button>
        )}
      </div>

      {/* 2. 标题 */}
      <h1 className="detail-title">{item.title}</h1>
      <div className="hr" style={{ margin: '0 0 var(--space-4)' }} />

      {/* 3. agent 归类（只读） */}
      <div className="detail-cls">
        <span className="kicker">agent 归类</span>
        <span className="detail-cls-name">{item.topic}</span>
        <span className="detail-cls-conf">置信度 {item.conf.toFixed(2)}</span>
      </div>

      {/* 4. 检索权重卡 */}
      <div className="weight-card">
        <div className="weight-card-head">
          <span className="kicker">检索权重</span>
          <span className="weight-value">{item.weight.toFixed(2)}</span>
        </div>
        <div className="weight-bar">
          <div
            className={
              'weight-bar-fill' + (item.signal === '不重要' ? ' unimportant' : '')
            }
            style={{ width: Math.round(item.weight * 100) + '%' }}
          />
        </div>
        <div className="weight-card-foot">
          <span>近 30 天被 agent 调用 {item.calls} 次</span>
          <span>最近 {item.lastCall}</span>
        </div>
      </div>

      {/* 5. 你的信号 */}
      <div className="kicker" style={{ marginBottom: 'var(--space-2)' }}>
        你的信号
      </div>
      <div className="signal-list">
        {SIGNAL_ORDER.map((key) => (
          <span
            key={key}
            className={'tag signal-tag' + (item.signal === key ? ' on' : '')}
            onClick={() => onSignal(item.id, key)}
          >
            {SIGNAL_LABEL[key]}
          </span>
        ))}
      </div>

      {/* 6. AI 摘要 */}
      <div className="card summary-card">
        <div className="summary-card-head">
          <span className="card-kicker">AI 摘要</span>
          <span
            className="summary-regen"
            onClick={() => onRegenerate(item)}
          >
            重新生成
          </span>
        </div>
        <p className="summary-body">{item.summary}</p>
      </div>

      {/* 7. 实体（只读） */}
      <div className="kicker" style={{ marginBottom: 'var(--space-2)' }}>
        实体
      </div>
      <div className="entity-tags">
        {item.entities.map((e) => (
          <span key={e.name} className="tag tag-accent entity-tag">
            <span>{e.name}</span>
            <span className="entity-tag-kind">{e.kind}</span>
          </span>
        ))}
      </div>

      {/* 8. 关系图 */}
      <div className="kicker" style={{ marginBottom: 'var(--space-2)' }}>
        关系图
      </div>
      <div className="graph-wrap">
        <div className="graph-box">
          <svg
            className="graph-svg"
            viewBox="0 0 340 190"
            preserveAspectRatio="none"
          >
            {graphNodes.map((n) => (
              <line
                key={'link-' + n.name}
                x1={170}
                y1={95}
                x2={n.cx}
                y2={n.cy}
                stroke="var(--color-accent-300)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <circle
              cx={170}
              cy={95}
              r={9}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={170} cy={95} r={3} fill="var(--color-accent)" />
            {graphNodes.map((n) => (
              <circle
                key={'node-' + n.name}
                cx={n.cx}
                cy={n.cy}
                r={4}
                fill="var(--color-bg)"
                stroke="var(--color-neutral-700)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {graphNodes.map((n) => (
            <div
              key={'label-' + n.name}
              className="graph-label"
              style={{ left: n.left, right: n.right, top: n.top }}
            >
              {n.name}
            </div>
          ))}
        </div>
      </div>
      <div className="rel-list">
        {item.relations.map((r, idx) => (
          <div key={idx} className="rel-item">
            {r.a} —{r.rel}→ {r.b}
          </div>
        ))}
      </div>

      {/* 9. 原文片段 */}
      <div className="kicker" style={{ marginBottom: 'var(--space-2)' }}>
        原文片段
      </div>
      <blockquote className="excerpt">{item.excerpt}</blockquote>

      {/* 10. 整理记录 */}
      {showAgentLog && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <div className="kicker" style={{ marginBottom: 'var(--space-2)' }}>
            整理记录
          </div>
          <div className="log-list">
            {item.log.map((l, idx) => (
              <div key={idx} className="log-item">
                <span className="log-when">{l.when}</span>
                <span className="log-what">{l.what}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 11. 收尾说明 */}
      <div className="hr" style={{ margin: '0 0 var(--space-3)' }} />
      <div className="detail-foot">
        这条 context 的归类、摘要、实体与去留由 agent
        维护。你只需要投喂新材料，或在上面告诉它这条重不重要。
      </div>
    </aside>
  );
}
