/** 后端 API 封装。失败时抛错，调用方负责回执提示。 */
import type { AgentTool, ContextItem } from './types';

export interface AppState {
  items: ContextItem[];
  tools: AgentTool[];
  pending: number;
  latestId: string | null;
  adjustCount: number;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchState(): Promise<AppState> {
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<AppState>;
}

export interface FeedImage {
  name: string;
  /** base64（不含 data: 前缀） */
  data: string;
}

export function postFeed(
  text: string,
  images: FeedImage[],
): Promise<{ runLog: string }> {
  return post('/api/feed', { text, images });
}

export function postSignal(
  id: string,
  signal: string,
): Promise<{ runLog: string }> {
  return post('/api/signal', { id, signal });
}

export function postInstruction(text: string): Promise<{ runLog: string }> {
  return post('/api/instruction', { text });
}

export function postRegenerate(id: string): Promise<{ runLog: string }> {
  return post('/api/regenerate', { id });
}

export function postToggleTool(
  id: string,
): Promise<{ tools: AgentTool[] }> {
  return post('/api/tools/toggle', { id });
}

/** File → { name, data(base64) }。 */
export function readFileAsImage(file: File): Promise<FeedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const base64 = url.includes(',') ? url.split(',')[1] : '';
      resolve({ name: file.name || '截图.png', data: base64 });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
