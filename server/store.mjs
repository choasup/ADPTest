/** JSON 文件持久化存储。
 *  内存为权威副本，写盘防抖；删除 server/data/ 即重置回种子数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { SEED_ITEMS, SEED_TOOLS } from './seed.mjs';

const DATA_DIR = path.join(import.meta.dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let state = null;
let saveTimer = null;

function nowStamp() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function dateOnly() {
  return nowStamp().slice(0, 5);
}

function freshState() {
  return {
    nextId: SEED_ITEMS.length + 1,
    items: structuredClone(SEED_ITEMS),
    tools: structuredClone(SEED_TOOLS),
    /** agent 新整理、用户尚未查看的条数（提示条）。 */
    pending: 2,
    /** 最近整理完成（触发提示条）的条目 id。 */
    latestId: null,
    lastAdjustCount: 3,
  };
}

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, DB_FILE);
  }, 150);
}

export function getStore() {
  if (state) return state;
  try {
    if (fs.existsSync(DB_FILE)) {
      state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return state;
    }
  } catch {
    // 损坏则回种子
  }
  state = freshState();
  persist();
  return state;
}

export function commit() {
  persist();
}

export { nowStamp, dateOnly };
