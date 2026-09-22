/** 文境 Contexta — 数据模型。
 *  条目数据由 agent 维护，前端只读；`signal` 是唯一人类可写字段。
 */

export type ContextType =
  | '会议纪要'
  | '对话片段'
  | '文档'
  | '链接剪藏'
  | '灵感'
  | '截图';

export type ItemState = '已整理' | '待确认' | '已归档';

export type Signal = '重要' | '常规' | '不重要' | '忘掉';

export interface ContextEntity {
  name: string;
  kind: string;
}

export interface ContextRelation {
  a: string;
  rel: string;
  b: string;
}

export interface ContextLogEntry {
  when: string;
  what: string;
}

export interface ContextItem {
  id: string;
  type: ContextType;
  /** agent 归类 */
  topic: string;
  /** 'MM-DD HH:mm' */
  when: string;
  /** 来源描述 */
  source: string;
  state: ItemState;
  /** agent 归类置信度 0-1 */
  conf: number;
  title: string;
  /** agent 摘要 */
  summary: string;
  entities: ContextEntity[];
  relations: ContextRelation[];
  /** 原文片段，保留换行 */
  excerpt: string;
  log: ContextLogEntry[];
  /** 人类信号（唯一可写） */
  signal: Signal;
  /** 检索权重 0-1 */
  weight: number;
  /** 近 30 天被 agent 调用次数 */
  calls: number;
  lastCall: string;
}

export type ToolStatus = '空闲' | '在线' | '占用' | '离线';

export interface AgentTool {
  id: string;
  name: string;
  meta: string;
  status: ToolStatus;
  on: boolean;
}

export const TOPICS: string[] = [
  '项目 · Aurora',
  '记忆系统研究',
  '个人灵感',
  '竞品观察',
  '商务',
];

export const PRESETS: string[] = [
  '把 Aurora 的会议纪要合成时间线',
  '合并重复条目',
  '重新抽取所有实体',
];

/** 信号 → 权重映射（null 表示保持当前权重） */
export const SIGNAL_WEIGHT: Record<Signal, number | null> = {
  重要: 0.96,
  常规: null,
  不重要: 0.12,
  忘掉: 0.02,
};

export const SIGNAL_LABEL: Record<Signal, string> = {
  重要: '很重要',
  常规: '常规',
  不重要: '不重要了',
  忘掉: '可以忘掉',
};
