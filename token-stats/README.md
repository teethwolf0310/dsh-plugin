# @teethwolf/dsh-token-stats

[English](README_EN.md) | 简体中文

dsh（DeepSeek Harness）插件，按**问答轮次（turn）/ 会话（session）/ 工作区（workspace）/ 时间窗口**统计 token 用量，并将每次采样持久化为 JSONL 记录。

统计口径：

- **输入总量** = 未缓存输入（`in`）+ 缓存读（`cr`）+ 缓存写（`cw`）
- **缓存命中** = `cr`
- **输出** = `out`

本插件**仅统计用量，不涉及任何计费**。

## 数据源

插件直接消费 dsh 自身的会话事件日志，与 `@deepseek-ai/dsh-token-meter` 遵循同一份数据契约：

| 事件 | 匹配条件 | 说明 |
|---|---|---|
| `assistant/chunk` | `chunk.type === 'usage'` | 流式期间的早期 sampled |
| `assistant/message` | `data.usage != undefined` | 该 step 的最终 confirmed usage |

因此，对会话日志的任何修改（删除消息、替换、compaction 后重放等）都会自动同步到统计结果中——插件不会维护第二条独立的统计管道。

## 事件挂载（Event Hooks）

| dsh 事件 | 处理职责 |
|---|---|
| `session/created`（global） | 注册会话元数据，并**回放 `session.events`** 补齐历史（构造函数 seed 不经 firehose） |
| `session/event`（global） | 将 usage 样本折叠进内存，同时追加 JSONL 记录 |
| `session/flush`（global） | 持久化 `sessions.json` 与 `meta.json` |
| `session/disposed`（global） | 标记会话已释放（内存中的折叠状态保留，供后续查询） |

同一 `(turn, step)` 下，`chunk(usage)` 与其后的 `assistant/message(usage)` 遵循 **replace-not-add** 不变量——后到的样本替换先到的，不会双计量。

## 存储布局

根目录 `resolveDshHome()/token-stats/`，即 `$DSH_HOME/token-stats/`（默认 `~/.dsh/token-stats/`）：

```
token-stats/
├── sessions.json                  # { sessionId: { cwd, createdAt } }
├── records/
│   ├── records-20260820.jsonl    # 按 UTC 日期滚动，一天一个文件
│   └── records-20260821.jsonl
└── meta.json                     # { lastFlushAt, recordsWritten, knownSessions }
```

每条 JSONL 记录对应一个 usage 样本：

```json
{"ts":1755784000000,"sessionId":"session-7","turn":2,"step":5,
 "in":3120,"cr":98600,"cw":1200,"out":340}
```

## 查询接口

### 1. 服务 `ctx.tokenStats`

```ts
ctx.tokenStats.query({ scope: 'global', granularity: 'perDay' })
ctx.tokenStats.format(agg)   // 将查询结果渲染为多行可读文本
```

### 2. 模型侧工具 `token_stats`

| 参数 | 类型 | 默认值 | 语义 |
|---|---|---|---|
| `scope` | `session` / `workspace` / `global` | `session` | 聚合范围；`session` 与 `workspace` 均以调用方所在会话定位 |
| `granularity` | `total` / `perTurn` / `perSession` / `perDay` | `total` | 结果行粒度 |
| `since` | number（epoch ms） | — | 窗口起点（含） |
| `until` | number（epoch ms） | — | 窗口终点（不含） |

### 3. 斜杠命令 `/tokens`

```
/tokens                  # 当前会话全量
/tokens 24h              # 当前会话，最近 24 小时
/tokens 7d workspace     # 当前工作区，最近 7 天
/tokens 30d global       # 跨进程视角全局，最近 30 天
```

相对窗口格式：`Nd` / `Nh` / `Nm`；scope 支持 `session` / `workspace` / `global`（`all` 与 `global` 等价）。

## 安装与装载

决定安装方式的**唯一分水岭**：你的 dsh 是**源码 checkout** 还是 **npm 已装**（`npx @deepseek-ai/dsh` / 全局 `dsh`）。插件产物（一个 ESM JS 文件）在两种情形下完全一致——变的只是**如何产出这个 JS**。

### A. npm 已装 dsh（无 monorepo 源码）

`npx @deepseek-ai/dsh` 或全局 `dsh` 会把 host 所需的 `@deepseek-ai/*` 全部打进 CLI bundle，无需再把插件塞进 monorepo。两条路任选：

#### A1. 预构建包（推荐）

把插件发到 npm，将 `lib/index.js` 列入 `files`：

```json
"files": ["lib/index.js", "lib/types/**/*.d.ts", "cordis.patch.yml"]
```

用户直接：

```bash
dsh plugin --profile web add @teethwolf/dsh-token-stats
```

pnpm 解析发布出的 `@deepseek-ai/*` peerDeps；dsh 启动时自动把 `cordis.patch.yml` 并入 layer 栈——**一条命令，零构建**。

#### A2. 本地构建

在任意一台有网机器上：

```bash
cd <工作目录>
npm install cordis @deepseek-ai/dsh-commands @deepseek-ai/dsh-session \
            @deepseek-ai/dsh-llm @deepseek-ai/dsh-tools \
            @deepseek-ai/dsh-home-paths typescript
npx tsc -p tsconfig.json       # 产出 lib/ 下 .js + .d.ts
# 可选单文件打包：npx tsdown（需 npm i tsdown）
```

随后将本目录挂到任意 profile：

```bash
dsh plugin --profile web add <本目录>
# 或：dsh web --patch <本目录>/cordis.patch.yml
```

### B. 源码 checkout（拥有 monorepo 仓库）

把插件放进 monorepo，由 pnpm workspace 把 `@deepseek-ai/*` peerDeps 解析到仓库内同源包：

```bash
mkdir -p <dsh仓库>/packages/teethwolf
cp -r $PLUGIN_HOME <dsh仓库>/packages/teethwolf/token-stats
cd <dsh仓库>
pnpm install --offline --no-frozen-lockfile
pnpm exec tsc -b packages/teethwolf/token-stats/tsconfig.json
cd packages/teethwolf/token-stats && <dsh仓库>/node_modules/.bin/tsdown

DEEPSEEK_BASE_URL=<你的 LLM base URL> \
  node --import tsx/esm <dsh仓库>/apps/cli/src/bin.ts web \
  --patch $PLUGIN_HOME/cordis.patch.yml
```

打开 `http://127.0.0.1:3080`，发送任一条 prompt 后再发 `/tokens`，即可看到当前会话的 token 桶。

### 装载方式对比

| 方式 | 命令 | 适用场景 |
|---|---|---|
| **`dsh plugin add`** | `dsh plugin --profile web add <包名或目录>` | 推荐——pnpm 解析依赖 + 自动并入 layer 栈 |
| **`--patch` 临时叠加** | `dsh web --patch $PLUGIN_HOME/cordis.patch.yml` | 开发调试，改完重启验证 |
| **合并到全局 patch** | 将 `cordis.patch.yml` 中的 `insert` 条目追加到 `$DSH_HOME/cordis.patch.yml` | 长期使用，对所有 profile 生效 |

## 配置项

| 键 | 类型 | 默认值 | 语义 |
|---|---|---|---|
| `retentionDays` | number | `0` | `records-*.jsonl` 保留天数；`0` 表示永久保留 |

在 `$DSH_HOME/cordis.patch.yml`（或 profile 的 patch 文件）中配置：

```yaml
- insert:
    - id: token-stats
      name: '<dsh仓库>/packages/teethwolf/token-stats/lib/index.js'
      config:
        retentionDays: 90
```

`name` 必须指向**构建产物的绝对路径**；指向 TypeScript 源码会被 dsh 的 ESM loader 拒绝（不会走 tsx）。

## 粒度说明

`perTurn` 粒度返回 `{ sessionId, turn, in, cr, cw, out, samples }`。一个 turn 通常包含多个 step（每次 LLM 调用对应一个 step），其 usage 之和即为该轮问答的 token 总消耗。

## 已知限制

- **内存状态即当前进程的统计真相**：`global` / `workspace` 级查询仅覆盖**本进程已 adopt 的会话**。对进程未打开的历史会话，请基于 `$DSH_HOME/token-stats/records-*.jsonl` 离线聚合，或打开对应会话让 dsh 载入。
- **workspace 标识 = 会话 cwd 的 realpath 绝对路径**：取自 `session.header.cwd`，未接入 workspace 注册表的 `WorkspaceId`——cwd 是唯一必然存在的标识，此为刻意简化。
- 不提供计费估算与上下文压力（context occupancy）评估——前者超出本插件边界，后者请使用原生 `dsh-token-meter`。

## 文件结构

```
token-stats/
├── package.json
├── cordis.patch.yml
├── tsconfig.json
├── tsdown.config.ts
├── README.md          # 本文档
├── README_EN.md       # English version
└── src/
    └── index.ts       # 单文件实现
```
