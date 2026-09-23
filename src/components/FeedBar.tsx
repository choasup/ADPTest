import { useState } from 'react';
import type { KeyboardEvent, ClipboardEvent, DragEvent } from 'react';
import { PRESETS } from '../types';
import { readFileAsImage } from '../api';
import type { FeedImage } from '../api';
import type { AgentTool } from '../types';

interface FeedBarProps {
  instruction: string;
  onInstruction: (value: string) => void;
  onSubmit: (text: string, images: FeedImage[]) => void;
  runLog: string;
  tools: AgentTool[];
}

function toolShortName(name: string): string {
  return name.split(' · ')[0].replace(/^(主库|向量库|对象存储)\s*/, '');
}

/** 底部 投喂 / 指令 条。
 *  图片投喂是隐形的：没有上传按钮、没有缩略图卡片——
 *  整条区域是 drop 区，输入框支持粘贴图片；图片读为 base64 随指令提交。
 */
export default function FeedBar({
  instruction,
  onInstruction,
  onSubmit,
  runLog,
  tools,
}: FeedBarProps) {
  const [dragging, setDragging] = useState(false);
  /** 待提交的图片附件（base64，不渲染缩略图）。 */
  const [attachments, setAttachments] = useState<FeedImage[]>([]);

  const addFiles = async (fileList: FileList | null) => {
    const files = [...(fileList ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    setDragging(false);
    const images = await Promise.all(files.map(readFileAsImage));
    setAttachments((prev) => [...prev, ...images]);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const items = e.clipboardData?.files;
    if (items && items.length) {
      e.preventDefault();
      void addFiles(items);
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!dragging) setDragging(true);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    void addFiles(e.dataTransfer.files);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') run();
  };

  const run = () => {
    const text = instruction.trim();
    if (!text && !attachments.length) return;
    onSubmit(text, attachments);
    onInstruction('');
    setAttachments([]);
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
        {tools.length > 0 && (
          <span className="feed-tools" />
        )}
        <span className="feed-tools-note">
          {tools.length > 0 ? `本轮将调用：${activeToolLine}` : ''}
          {attachments.length > 0 ? ` · 待提交截图 ${attachments.length} 张` : ''}
        </span>
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
