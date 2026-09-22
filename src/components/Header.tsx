import type { ContextItem } from '../types';

interface HeaderProps {
  query: string;
  onQuery: (value: string) => void;
  items: ContextItem[];
}

/** 顶栏：品牌 + 搜索 + 条目计数。没有按钮——投喂入口只在底部一处。 */
export default function Header({ query, onQuery, items }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-name">文境</span>
        <span className="brand-sub">Contexta</span>
      </div>
      <div className="header-search">
        <input
          className="input"
          type="search"
          placeholder="搜索 context、实体、摘要…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <div className="header-count">
        <span className="header-count-label">
          {items.length} 条 context
        </span>
      </div>
    </header>
  );
}
