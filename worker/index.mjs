/** Worker 入口 — /api/* 路由到 ContextaLibrary DO（RPC），其余走静态资产。
 *  静态资产（dist/）与 SPA fallback 由 wrangler assets 层处理（run_worker_first 仅 /api/*）。
 */
import { ContextaLibrary } from './do.mjs';

export { ContextaLibrary };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Not Found', { status: 404 });
    }
    const stub = env.LIBRARY.getByName('global');

    const route = url.pathname.slice(5); // 'state' | 'feed' | ...
    const method = request.method;

    if (route === 'state' && method === 'GET') {
      return json(await stub.getState());
    }

    if (route === 'feed' && method === 'POST') {
      const { text = '', images = [] } = await readJson(request);
      if (!text.trim() && !(images && images.length)) {
        return json({ error: '空的投喂' }, 400);
      }
      return json({ runLog: await stub.feed(text, images ?? []) });
    }

    if (route === 'signal' && method === 'POST') {
      const { id, signal } = await readJson(request);
      const runLog = await stub.signal(id, signal);
      return runLog ? json({ runLog }) : json({ error: '条目不存在' }, 404);
    }

    if (route === 'instruction' && method === 'POST') {
      const { text = '' } = await readJson(request);
      return json({ runLog: await stub.instruction(text) });
    }

    if (route === 'regenerate' && method === 'POST') {
      const { id } = await readJson(request);
      const runLog = await stub.regenerate(id);
      return runLog ? json({ runLog }) : json({ error: '条目不存在' }, 404);
    }

    if (route === 'tools/toggle' && method === 'POST') {
      const { id } = await readJson(request);
      const tools = await stub.toggleTool(id);
      return tools ? json({ tools }) : json({ error: '工具不存在' }, 404);
    }

    if (route === 'pending/clear' && method === 'POST') {
      return json(await stub.clearPending());
    }

    if (route === 'reset' && method === 'POST') {
      const { mode = 'seed', keepIds = [] } = await readJson(request);
      return json(await stub.reset(mode, keepIds));
    }

    if (route === 'meetings/import' && method === 'POST') {
      const { meetings = [] } = await readJson(request);
      return json(await stub.importMeetings(meetings));
    }

    // ——— 对话面板 ———
    if (route === 'chat' && method === 'POST') {
      const { text = '', images = [] } = await readJson(request);
      return json(await stub.chat(text, images ?? []));
    }

    if (route === 'op' && method === 'POST') {
      const { action, opId } = await readJson(request);
      if (action === 'confirm') return json(await stub.confirmOp(opId));
      if (action === 'reject') return json(await stub.rejectOp(opId));
      return json({ error: '未知操作' }, 400);
    }

    if (route === 'mode' && method === 'POST') {
      const { mode } = await readJson(request);
      return json(await stub.setMode(mode));
    }

    if (route === 'chat/clear' && method === 'POST') {
      return json(await stub.clearChat());
    }

    return json({ error: '未知接口' }, 404);
  },
};
