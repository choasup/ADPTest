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
npm run dev      # 开发服务器
npm run build    # TypeScript 检查 + 生产构建
npm run preview  # 预览生产构建
```

技术栈：React 18 + TypeScript + Vite。样式为 Classical 设计系统
（Cormorant Garamond + Lora、近白底、颜色只做描边与细线、1px 描边按钮），
token 全部来自 `src/styles/tokens.css`，不硬编码任何色值/字号。

## 代码结构

```
src/
├── main.tsx              # 入口
├── App.tsx               # 状态容器（全部本地状态，见下）
├── types.ts              # ContextItem 等数据模型 + 信号/权重映射
├── data.ts               # 初始示例数据（需替换为真实后端数据）
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
    ├── FeedBar.tsx       # 投喂/指令条（拖放 + 粘贴图片）
    └── DetailPanel.tsx   # 右栏详情（含 SVG 关系图）
```

## 状态

```
items[]         # ContextItem[]，agent 维护，前端只读；signal 是唯一人类可写字段
query           # 搜索词
topic           # '全部' | 主题名
type            # null | 类型名
selectedId      # 当前选中条目（窄屏 null = 显示列表）
instruction     # 投喂/指令输入框
runLog          # 最近一条回执文案
tools[]         # 工具启用状态
pending         # agent 新整理条数（提示条）
narrow          # 视口 < 900px
```

## 接入真实后端

当前数据为交付设计稿中的示例数据。需要的服务端能力：

- 条目列表（含权重与调用统计）
- 投喂接口（文本/链接/图片，返回异步处理任务）
- 信号写入接口
- 自然语言指令接口
- 工具启用开关
- agent 活动摘要（pending）
