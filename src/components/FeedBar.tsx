import { useRef, useState } from 'react';
import type { KeyboardEvent, ClipboardEvent, DragEvent } from 'react';
import { PRESETS } from '../types';
import type { AgentTool } from '../types';

interface FeedBarProps {
  instruction: string;
  onInstruction: (value: string) => void;
  onRunLog: (msg: string) => void;
  runLog: string;
  tools: AgentTool[];
}

function toolShortName(name: string): string {
  return name.split(' · ')[0].replace(/^(主库|向量库|对象存储)\s*/, '');
}

/** 底部 投喂 / 指令 条。
 *  图片投喂是隐形的：没有上传按钮、没有缩略图卡片——
 *  整条区域是 drop 区，输入框支持粘贴图片。
 */
export default function FeedBar({
  instruction,
  onInstruction,
  onRunLog,
  runLog,
  tools,
}: FeedBarProps) {
  const [dragging, setDragging] = useState(false);
  /** 待提交的图片附件（仅计数，不渲染缩略图）。 */
  const attachmentsRef = useRef<string[]>([]);

  const addFiles = (fileList: FileList | null) => {
    const files = [...(fileList ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    attachmentsRef.current = [
      ...attachmentsRef.current,
      ...files.map((f) => f.name || '截图.png'),
    ];
    setDragging(false);
    onRunLog(`收到 ${files.length} 张图片，agent 正在 OCR 识别并归类。`);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const items = e.clipboardData?.files;
    if (items && items.length) {
      e.preventDefault();
      addFiles(items);
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!dragging) setDragging(true);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') run();
  };

  const run = () => {
    const text = instruction.trim();
    const count = attachmentsRef.current.length;
    if (!text && !count) return;
    const parts: string[] = [];
    if (count) parts.push(`已收下 ${count} 张图片，正在 OCR 识别、生成摘要并归类`);
    if (text) parts.push(`指令「${text}」将在下一轮整理中执行`);
    onInstruction('');
    attachmentsRef.current = [];
    onRunLog(`agent ${parts.join('；')}。`);
  };

  const activeToolLine =
    tools
      .filter((t) => t.on)
      .map((t) => toolShortName(t.name))
      .join(' · ') || '无（请先启用工具）';

  return (
    <div
      className={'feed' + (dragging ? ' dragging' : '')}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="feed-top">
        <span className="kicker">投喂 / 指令</span>
        {PRESETS.map((p) => (
          <span
            key={p}
            className="tag tag-outline preset-tag"
            onClick={() => onInstruction(p)}
          >
            {p}
          </span>
        ))}
        <span className="feed-tools" />
        <span className="feed-tools-note">本轮将调用：{activeToolLine}</span>
      </div>
      <div className="feed-input-row">
        <input
          className="input"
          placeholder="粘贴一段话、链接，拖入截图，或告诉它哪些不重要了…"
          value={instruction}
          onChange={(e) => onInstruction(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button className="btn btn-primary" type="button" onClick={run}>
          执行
        </button>
      </div>
      {runLog && <div className="feed-runlog">{runLog}</div>}
    </div>
  );
}
