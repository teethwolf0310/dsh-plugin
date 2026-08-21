# @teethwolf/dsh-token-stats

English | [简体中文](README.md)

A dsh (DeepSeek Harness) plugin that collects durable token-usage statistics per **turn / session / workspace / time window** and persists every sample as a JSONL record.

Accounting model:

- **Total input** = uncached input (`in`) + cache read (`cr`) + cache write (`cw`)
- **Cache hit** = `cr`
- **Output** = `out`

The plugin reports **volumes only — no cost estimation, no pricing**.

## Data Source

The plugin consumes the harness's own session event log, under the same data contract as `@deepseek-ai/dsh-token-meter`:

| Event | Match condition | Description |
|---|---|---|
| `assistant/chunk` | `chunk.type === 'usage'` | Early usage sample during streaming |
| `assistant/message` | `data.usage != undefined` | Final confirmed usage for the step |

Any edit to the session log (message deletion, replacement, replay after compaction, etc.) is therefore automatically reflected in the statistics — the plugin does not maintain a secondary accounting pipeline.

## Event Hooks

| dsh Event | Responsibility |
|---|---|
| `session/created` (global) | Register session metadata, then **replay `session.events`** to backfill history (the constructor seed is not published via firehose) |
| `session/event` (global) | Fold usage samples into memory while appending JSONL records |
| `session/flush` (global) | Persist `sessions.json` and `meta.json` |
| `session/disposed` (global) | Mark the session as released (folded in-memory state is retained for later queries) |

Within the same `(turn, step)`, a `chunk(usage)` followed by an `assistant/message(usage)` is handled under a **replace-not-add** invariant — the later sample replaces the earlier one, preventing double counting.

## Storage Layout

Root directory: `resolveDshHome()/token-stats/`, i.e. `$DSH_HOME/token-stats/` (`~/.dsh/token-stats/` by default):

```
token-stats/
├── sessions.json                  # { sessionId: { cwd, createdAt } }
├── records/
│   ├── records-20260820.jsonl    # Rolled by UTC day, one file per day
│   └── records-20260821.jsonl
└── meta.json                     # { lastFlushAt, recordsWritten, knownSessions }
```

Each JSONL line is one usage sample:

```json
{"ts":1755784000000,"sessionId":"session-7","turn":2,"step":5,
 "in":3120,"cr":98600,"cw":1200,"out":340}
```

## Query Interfaces

### 1. Service `ctx.tokenStats`

```ts
ctx.tokenStats.query({ scope: 'global', granularity: 'perDay' })
ctx.tokenStats.format(agg)   // Render the aggregation as a multi-line human-readable text
```

### 2. Model-facing tool `token_stats`

| Parameter | Type | Default | Semantics |
|---|---|---|---|
| `scope` | `session` / `workspace` / `global` | `session` | Aggregation scope; `session` and `workspace` are resolved from the calling session |
| `granularity` | `total` / `perTurn` / `perSession` / `perDay` | `total` | Row granularity of the result |
| `since` | number (epoch ms) | — | Window start (inclusive) |
| `until` | number (epoch ms) | — | Window end (exclusive) |

### 3. Slash command `/tokens`

```
/tokens                  # current session, all time
/tokens 24h              # current session, last 24 hours
/tokens 7d workspace     # current workspace, last 7 days
/tokens 30d global       # process-wide global view, last 30 days
```

Relative window syntax: `Nd` / `Nh` / `Nm`. Scope accepts `session` / `workspace` / `global` (`all` is an alias for `global`).

## Installation

There is **exactly one meaningful fork**: whether your dsh is a **source checkout** or **npm-installed** (`npx @deepseek-ai/dsh` / a globally installed `dsh`). The plugin artifact (a single ESM JS file) is identical in both cases — only **how that JS is produced** differs.

### A. npm-installed dsh (no monorepo source)

`npx @deepseek-ai/dsh` or a globally installed `dsh` bundles every `@deepseek-ai/*` host package into its CLI — there is no monorepo you need to place the plugin into. Pick one of two routes:

#### A1. Prebuilt package (recommended)

Publish the plugin to npm with `lib/index.js` in `files`:

```json
"files": ["lib/index.js", "lib/types/**/*.d.ts", "cordis.patch.yml"]
```

End users then run:

```bash
dsh plugin --profile web add @teethwolf/dsh-token-stats
```

pnpm resolves the published `@deepseek-ai/*` peerDependencies; at startup dsh merges `cordis.patch.yml` into the layer stack automatically — **one command, zero build**.

#### A2. Local build against npm

On any machine with network access:

```bash
cd <working directory>
npm install cordis @deepseek-ai/dsh-commands @deepseek-ai/dsh-session \
            @deepseek-ai/dsh-llm @deepseek-ai/dsh-tools \
            @deepseek-ai/dsh-home-paths typescript
npx tsc -p tsconfig.json     # emits lib/ *.js + .d.ts
# Optional single-file bundle: npx tsdown (requires npm i tsdown)
```

Load this directory into any profile:

```bash
dsh plugin --profile web add <this directory>
# Or: dsh web --patch <this directory>/cordis.patch.yml
```

### B. Source checkout (you have the monorepo)

Drop the plugin into the monorepo so pnpm workspace links resolve `@deepseek-ai/*` peerDeps to the same sources the host is running:

```bash
mkdir -p <dsh repo>/packages/teethwolf
cp -r $PLUGIN_HOME <dsh repo>/packages/teethwolf/token-stats
cd <dsh repo>
pnpm install --offline --no-frozen-lockfile
pnpm exec tsc -b packages/teethwolf/token-stats/tsconfig.json
cd packages/teethwolf/token-stats && <dsh repo>/node_modules/.bin/tsdown

DEEPSEEK_BASE_URL=<your LLM base URL> \
  node --import tsx/esm <dsh repo>/apps/cli/src/bin.ts web \
  --patch $PLUGIN_HOME/cordis.patch.yml
```

Open `http://127.0.0.1:3080`, send any prompt, then send `/tokens` to see the current session's token buckets.

### Loading modes compared

| Mode | Command | When to use |
|---|---|---|
| **`dsh plugin add`** | `dsh plugin --profile web add <package or directory>` | Recommended — pnpm resolves deps and the bundle merges into the layer stack |
| **`--patch` overlay** | `dsh web --patch $PLUGIN_HOME/cordis.patch.yml` | Development/debugging, iterate by restarting after each change |
| **Merge into global patch** | Append the `insert` entry of `cordis.patch.yml` into `$DSH_HOME/cordis.patch.yml` | Long-term use across every profile |

## Configuration

| Key | Type | Default | Semantics |
|---|---|---|---|
| `retentionDays` | number | `0` | Days to keep `records-*.jsonl` files; `0` keeps them forever |

Configure in `$DSH_HOME/cordis.patch.yml` (or a profile's patch file):

```yaml
- insert:
    - id: token-stats
      name: '<dsh repo>/packages/teethwolf/token-stats/lib/index.js'
      config:
        retentionDays: 90
```

`name` must point at the absolute path of the **built artifact**; pointing it at TypeScript source fails because dsh's ESM loader does not go through tsx.

## Granularity

The `perTurn` granularity returns rows of `{ sessionId, turn, in, cr, cw, out, samples }`. A turn typically consists of multiple steps (one per LLM call); their usage sums to the total token consumption of that round of conversation.

## Known Limitations

- **In-memory state is the source of truth for the current process**: `global` / `workspace` queries only cover **sessions adopted by this process**. For historical sessions not opened by the current process, aggregate `$DSH_HOME/token-stats/records-*.jsonl` offline, or open the session so dsh loads it.
- **Workspace identity = the session cwd's realpath**: taken from `session.header.cwd`; it is deliberately not tied to the workspace registry's `WorkspaceId` — cwd is the only identifier guaranteed to exist.
- No cost estimation and no context-pressure (context occupancy) assessment — the former is out of scope, for the latter use the native `dsh-token-meter`.

## File Structure

```
token-stats/
├── package.json
├── cordis.patch.yml
├── tsconfig.json
├── tsdown.config.ts
├── README.md          # 中文版本
├── README_EN.md       # This document
└── src/
    └── index.ts       # Single-file implementation
```
