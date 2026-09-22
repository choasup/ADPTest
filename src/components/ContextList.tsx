import type { ContextItem, ItemState } from '../types';

interface ContextListProps {
  filtered: ContextItem[];
  total: number;
  title: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  dense: boolean;
}

function stateClass(item: ContextItem): string {
  if (item.signal === '不重要') return 'row-state unimportant';
  const map: Record<ItemState, string> = {
    待确认: 'row-state pending',
    已归档: 'row-state normal',
    已整理: 'row-state normal',
  };
  return map[item.state];
}

function stateLabel(item: ContextItem): string {
  return item.signal === '常规' ? item.state : item.signal;
}

function weightClass(item: ContextItem): string {
  if (item.signal === '不重要') return 'row-weight-fill unimportant';
  if (item.weight < 0.4) return 'row-weight-fill low';
  return 'row-weight-fill';
}

function callLabel(calls: number): string {
  return calls > 0 ? `被调用 ${calls}` : '未被调用';
}

/** 中栏 · Context 流（列表头 + 可点选行）。 */
export default function ContextList({
  filtered,
  total,
  title,
  selectedId,
  onSelect,
  dense,
}: ContextListProps) {
  return (
    <>
      <div className="stream-head">
        <h2 className="stream-title">{title}</h2>
        <span className="stream-count">
          {filtered.length} / {total}
        </span>
      </div>
      <div className="stream-body">
        {filtered.map((item) => (
          <article
            key={item.id}
            className={
              'row' + (dense ? ' dense' : '') + (item.id === selectedId ? ' selected' : '')
            }
            onClick={() => onSelect(item.id)}
          >
            <div className="row-meta">
              <span className="row-type">{item.type}</span>
              <span className="row-when">{item.when}</span>
              <span style={{ flex: 1 }} />
              <span className={stateClass(item)}>{stateLabel(item)}</span>
              <span className="row-weight">
                <span
                  className={weightClass(item)}
                  style={{ width: Math.round(item.weight * 100) + '%' }}
                />
              </span>
            </div>
            <div className="row-title">{item.title}</div>
            <div className="row-summary">{item.summary}</div>
            <div className="row-foot">
              <span className="row-entities">
                {item.entities.map((e) => e.name).join(' · ')}
              </span>
              <span className="row-calls">{callLabel(item.calls)}</span>
            </div>
          </article>
        ))}
        {filtered.length === 0 && (
          <div className="stream-empty">没有符合条件的 context。</div>
        )}
      </div>
    </>
  );
}
