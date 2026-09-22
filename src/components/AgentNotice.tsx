interface AgentNoticeProps {
  pending: number;
  onReview: () => void;
}

/** Agent 提示条：这是告知，不是「请你确认」。 */
export default function AgentNotice({ pending, onReview }: AgentNoticeProps) {
  if (pending <= 0) return null;
  return (
    <div className="agent-notice">
      <span className="agent-notice-kicker">Agent</span>
      <span className="agent-notice-text">
        agent 刚整理了 {pending} 条新 context，并调整了 3 条旧记忆的权重。
      </span>
      <button className="btn btn-ghost" type="button" onClick={onReview}>
        看看它整理了什么
      </button>
    </div>
  );
}
