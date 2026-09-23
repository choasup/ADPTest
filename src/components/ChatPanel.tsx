import { useRef, useState } from 'react';
import type { KeyboardEvent, ClipboardEvent, DragEvent } from 'react';
import { readFileAsImage, postChat, postOp, postMode } from '../api';
import type { FeedImage, ChatState } from '../api';

interface ChatPanelProps {
  chat: ChatState;
  onSync: () => void;
}

/** 右栏 · Agent 对话面板：消息流 + 操作确认卡 + 输入框 + Auto/Approve 开关。
 *  所有写操作在 Approve 模式下先进确认队列，用户点「执行」才落库。
 */
export default function ChatPanel({ chat, onSync }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const attachmentsRef = useRef<FeedImage[]>([]);
  const [attachCount, setAttachCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mode = chat.mode;

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  const addFiles = async (fileList: FileList | null) => {
    const files = [...(fileList ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    const images = await Promise.all(files.map(readFileAsImage));
    attachmentsRef.current = [...attachmentsRef.current, ...images];
    setAttachCount(attachmentsRef.current.length);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const items = e.clipboardData?.files;
    if (items && items.length) {
      e.preventDefault();
      void addFiles(items);
    }
  };

  const send = async () => {
    const text = input.trim();
    const images = attachmentsRef.current;
    if (!text && !images.length) return;
    if (busy) return;
    setBusy(true);
    setInput('');
    attachmentsRef.current = [];
    setAttachCount(0);
    try {
      await postChat(text, images);
      onSync();
      scrollToBottom();
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void send();
  };

  const confirm = async (opId: string) => {
    setBusy(true);
    try {
      await postOp('confirm', opId);
      onSync();
      scrollToBottom();
    } finally {
      setBusy(false);
    }
  };

  const reject = async (opId: string) => {
    setBusy(true);
    try {
      await postOp('reject', opId);
      onSync();
    } finally {
      setBusy(false);
    }
  };

  const switchMode = async (next: 'auto' | 'approve') => {
    if (next === mode) return;
    await postMode(next);
    onSync();
  };

  return (
    <aside className="chat-panel">
      {/* 头部：模式开关 */}
      <div className="chat-head">
        <span className="chat-title">Agent</span>
        <div className="chat-mode">
          <button
            className={'chat-mode-btn' + (mode === 'approve' ? ' on' : '')}
            onClick={() => void switchMode('approve')}
            title="写操作需要确认后执行"
          >
            Approve
          </button>
          <button
            className={'chat-mode-btn' + (mode === 'auto' ? ' on' : '')}
            onClick={() => void switchMode('auto')}
            title="写操作直接执行"
          >
            Auto
          </button>
        </div>
      </div>

      {/* 消息流 */}
      <div className="chat-scroll" ref={scrollRef}>
        {chat.messages.length === 0 && (
          <div className="chat-empty">
            与 agent 对话来管理上下文库：投喂材料、删除、修改、查询、统计——
            {mode === 'approve' ? '写操作会先请你确认。' : '写操作将自动执行。'}
          </div>
        )}
        {chat.messages.map((m, idx) => (
          <div key={idx} className={'chat-msg ' + m.role}>
            <div className="chat-bubble">
              {m.reasoning && (
                <details className="chat-reasoning">
                  <summary>推理过程</summary>
                  <div className="chat-reasoning-body">{m.reasoning}</div>
                </details>
              )}
              {m.text}
              {m.opCard && (
                <div className={'chat-opcard ' + m.opCard.status}>
                  <span className="chat-opcard-kind">{m.opCard.kind}</span>
                  <span className="chat-opcard-summary">{m.opCard.summary}</span>
                  {m.opCard.status === 'pending' && m.opCard.opId && (
                    <span className="chat-opcard-actions">
                      <button
                        className="chat-opbtn go"
                        disabled={busy}
                        onClick={() => void confirm(m.opCard!.opId!)}
                      >
                        执行
                      </button>
                      <button
                        className="chat-opbtn no"
                        disabled={busy}
                        onClick={() => void reject(m.opCard!.opId!)}
                      >
                        取消
                      </button>
                    </span>
                  )}
                  {m.opCard.status === 'done' && (
                    <span className="chat-opcard-state done">已执行</span>
                  )}
                  {m.opCard.status === 'rejected' && (
                    <span className="chat-opcard-state rejected">已取消</span>
                  )}
                </div>
              )}
            </div>
            <div className="chat-ts">{m.ts}</div>
          </div>
        ))}
        {busy && <div className="chat-msg agent"><div className="chat-bubble typing">…</div></div>}
      </div>

      {/* 输入区（drop 区） */}
      <div
        className={'chat-input-wrap' + (dragging ? ' dragging' : '')}
        onDragOver={(e: DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e: DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
      >
        <input
          className="input"
          placeholder={mode === 'approve' ? '对 agent 说：投喂、删掉、修改、查询…（写操作需确认）' : '对 agent 说：投喂、删掉、修改、查询…（自动执行）'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={busy}
        />
        <button
          className="btn btn-primary chat-send"
          onClick={() => void send()}
          disabled={busy}
        >
          发送
        </button>
        {attachCount > 0 && (
          <div className="chat-attach-note">待发送截图 {attachCount} 张</div>
        )}
      </div>
    </aside>
  );
}
