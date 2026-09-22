# 文境 Contexta

Agent-maintained context library — 一个给 agent 用的上下文记忆库的人类界面。

用户把零散材料（会议纪要、聊天片段、文档、网页剪藏、灵感、截图）投喂进来，整理
agent 自动完成解析、摘要、归类、实体与关系抽取、权重维护与淘汰。这个前端是系统
的唯一人类界面：**只读的观察窗 + 两个人类动作**。

## 产品约束

- **agent 拥有数据。** 归类、摘要、实体、关系、保留/淘汰全部由 agent 维护，
  界面上没有新增、编辑、删除、归档、改分类等人工 CRUD 操作。
- **人只做两件事：**
  1. **投喂**（粘贴文本/链接，拖入或粘贴截图）
  2. **给信号**（很重要 / 常规 / 不重要了 / 可以忘掉），外加自然语言整理指令
- 每条 context 面向 agent 的关键指标是**检索权重**与**被调用次数**。

## 界面

单页三栏布局（<900px 自动切到单栏）：

- **顶栏** — 品牌、全局搜索（标题+摘要+原文+实体名）、条目计数；没有按钮
- **Agent 提示条** — 条件显示的告知条（不是确认请求）
- **左栏** — 主题单选过滤（含占比条）、类型互斥标签、高频实体（agent 抽取）、
  Agent 可用工具开关、近两周入库柱状图
- **中栏** — Context 流：可点选行（类型 kicker/时间/状态词/权重细线/标题/
  两行截断摘要/实体行/被调用次数）；底部投喂/指令条（预设指令、隐形图片投喂：
  整条区域是 drop 区 + 输入框粘贴图片）
- **右栏** — 详情：agent 归类（只读）、检索权重卡、你的信号（唯一可写）、
  AI 摘要（重新生成）、实体标签、SVG 关系图（hub + 椭圆均布节点 + HTML 标签）、
  原文片段、整理记录、收尾说明

## 开发

```bash
npm install
npm run dev      # API(8787) + vite dev server 并行启动（/api 已代理）
npm run build    # TypeScript 检查 + 生产构建
npm start        # 生产模式：单进程服务 dist 静态文件 + API（http://localhost:8787）
```

## 架构

全栈原型：**前端（React 18 + TypeScript + Vite）+ 整理 agent（Node/Express）**。
数据在服务端由 agent 维护，前端只读轮询（2s）；「signal」是唯一人类可写动作。

```
前端 src/                    服务端 server/
├── App.tsx        状态容器    ├── index.mjs   Express API + 静态服务
├── api.ts         API 封装    ├── agent.mjs   整理 agent（异步流水线）
├── components/…   全部界面    ├── store.mjs   JSON 文件持久化（防抖写盘）
└── styles/…       Classical   └── seed.mjs    种子数据（设计稿示例数据）
```

### 整理流水线（server/agent.mjs）

```
投喂受理（state=待确认，log:排队整理）
  → 异步整理（~2.5s）：
      摘要生成（截取/OCR 模拟）→ 主题归类（关键词规则 + 置信度，
      低置信 → 待归类 + 待确认）→ 实体抽取（词典 + 「引号」概念）
      → 关系生成 → 同主题旧条目权重微调
  → pending++（提示条）→ 前端轮询感知 → 点击定位 → pending 清零
```

自然语言指令：合成时间线（真实写回 log）、合并重复条目（真实合并 +
calls 累加）、重新抽取所有实体（全量重跑）；其他指令受理回执。
图片投喂：base64 上传 → 落盘 `server/data/uploads/` → OCR 模拟整理。

### API

| 接口 | 说明 |
|---|---|
| `GET /api/state` | 条目列表 + 工具 + pending + latestId（前端轮询） |
| `POST /api/feed` | 投喂 `{ text, images:[{name,data}] }`，触发异步整理 |
| `POST /api/signal` | 人类信号写入 `{ id, signal }`（唯一可写） |
| `POST /api/instruction` | 自然语言指令 `{ text }` |
| `POST /api/regenerate` | 重跑摘要与实体 `{ id }` |
| `POST /api/tools/toggle` | 工具启用开关 `{ id }` |
| `POST /api/pending/clear` | 提示条已查看 |

存储：`server/data/db.json`（运行时数据，不入 git）；删除该目录即重置回种子。

技术栈：React 18 + TypeScript + Vite。样式为 Classical 设计系统
（Cormorant Garamond + Lora、近白底、颜色只做描边与细线、1px 描边按钮），
token 全部来自 `src/styles/tokens.css`，不硬编码任何色值/字号。

## 代码结构

```
src/
├── main.tsx              # 入口
├── App.tsx               # 状态容器（轮询 + API 动作）
├── api.ts                # 后端 API 封装（fetch）
├── types.ts              # ContextItem 等数据模型 + 信号/权重映射
├── hooks/
│   └── useNarrow.ts      # <900px 响应式
├── styles/
│   ├── tokens.css        # Classical 设计系统 token + 组件类
│   └── app.css           # 应用样式（引用 token，不含硬编码值）
└── components/
    ├── Header.tsx        # 顶栏
    ├── AgentNotice.tsx   # Agent 提示条
    ├── Sidebar.tsx       # 左栏（主题/类型/实体/工具/入库图）
    ├── ContextList.tsx   # 中栏列表
    ├── FeedBar.tsx       # 投喂/指令条（拖放 + 粘贴图片 → base64 上传）
    └── DetailPanel.tsx   # 右栏详情（含 SVG 关系图）
```

## 状态

```
items[]         # 服务端轮询快照，agent 维护；signal 是唯一人类可写字段
query           # 搜索词
topic           # '全部' | 主题名
type            # null | 类型名
selectedId      # 当前选中条目（窄屏 null = 显示列表）
instruction     # 投喂/指令输入框
runLog          # 最近一条回执文案（来自服务端 agent）
tools[]         # 工具启用状态
pending         # agent 新整理条数（提示条）
narrow          # 视口 < 900px
```

## 原型边界

- 整理 agent 为**确定性规则模拟**（关键词归类、词典实体、截取式摘要、OCR 模拟），
  接真实 LLM 时替换 `server/agent.mjs` 的 `classifyTopic/summarize/extractEntities`
  即可，API 与前端无需改动
- 检索权重微调为模拟策略；calls/lastCall 为静态统计
- 图片 OCR 为模拟（文件真实落盘，识别文字为占位文案）
