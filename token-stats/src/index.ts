/**
 * Durable token-usage statistics for the DeepSeek Harness.
 *
 * Data source: the harness's own session event log — every `assistant/chunk`
 * with `chunk.type === 'usage'` and every `assistant/message` whose `data.usage`
 * is present. This follows the same contract `@deepseek-ai/dsh-token-meter`
 * relies on, so editing or replaying a session log stays consistent: the
 * plugin replays the log on adoption and keeps folding from `session/event`
 * afterwards.
 *
 * Storage: `$DSH_HOME/token-stats/` (resolved through
 * `@deepseek-ai/dsh-home-paths`, so `$DSH_HOME` takes priority, else `~/.dsh`):
 *   - `sessions.json`           map sessionId → { cwd, createdAt }
 *   - `records-YYYYMMDD.jsonl`  daily JSONL of usage samples
 *   - `meta.json`               operational statistics (recordsWritten, lastFlushAt)
 *
 * Query:
 *   - class service `ctx.tokenStats` (`query()` + `format()`)
 *   - model-facing tool `token_stats`
 *   - human-facing slash command `/tokens [ago] [scope]`
 *
 * @module @teethwolf/dsh-token-stats
 */

import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'

export const name = 'token-stats'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tokenStats: TokenStats
  }
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/** Token buckets carried by one usage sample. `in` is the uncached input. */
export interface Buckets {
  in: number
  cr: number
  cw: number
  out: number
}

/** One folded usage sample, as it appears in the JSONL records. */
export interface UsageRecord extends Buckets {
  ts: number
  sessionId: string
  turn: number
  step: number
}

/** Folded totals attached to one session. */
export interface SessionTotals extends Buckets {
  samples: number
  lastSampleAt?: number
}

interface SessionMeta {
  cwd?: string
  createdAt?: number
}

interface SessionState {
  meta: SessionMeta
  totals: SessionTotals
  /** Last folded (turn, step) sample, used to replace same-step duplicates. */
  last?: { turn: number; step: number; buckets: Buckets }
}

/** Workspace-row in perSession top-level aggregations. */
export interface WorkspaceAggregationRow extends Buckets {
  workspace: string
  sessions: number
}

/** Session-row. */
export interface SessionAggregationRow extends Buckets {
  sessionId: string
  samples: number
  cwd?: string
  createdAt?: number
  lastSampleAt?: number
}

/** Turn-row (granularity perTurn). */
export interface TurnAggregationRow extends Buckets {
  sessionId: string
  turn: number
  samples: number
}

/** Day-row (granularity perDay). */
export interface DayAggregationRow extends Buckets {
  day: string
  samples: number
}

export type AggregationRow =
  | WorkspaceAggregationRow
  | SessionAggregationRow
  | TurnAggregationRow
  | DayAggregationRow

export interface Aggregation {
  scope: 'session' | 'workspace' | 'global'
  granularity: 'total' | 'perTurn' | 'perSession' | 'perDay'
  since?: number
  until?: number
  buckets: Buckets
  samples: number
  rows?: AggregationRow[]
}

export interface QueryOptions {
  scope?: 'session' | 'workspace' | 'global'
  sessionId?: string
  workspace?: string
  since?: number
  until?: number
  granularity?: 'total' | 'perTurn' | 'perSession' | 'perDay'
}

export interface TokenStatsConfig {
  /** Days of JSONL day files to keep; 0 means keep forever. */
  retentionDays?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const zeroBuckets = (): Buckets => ({ in: 0, cr: 0, cw: 0, out: 0 })

const copyBuckets = (b: Buckets): Buckets => ({ in: b.in, cr: b.cr, cw: b.cw, out: b.out })

const addBuckets = (a: Buckets, b: Buckets): Buckets => ({
  in: a.in + b.in,
  cr: a.cr + b.cr,
  cw: a.cw + b.cw,
  out: a.out + b.out,
})

const subBuckets = (a: Buckets, b: Buckets): Buckets => ({
  in: a.in - b.in,
  cr: a.cr - b.cr,
  cw: a.cw - b.cw,
  out: a.out - b.out,
})

const bucketsFromUsage = (usage: TokenUsage): Buckets => ({
  in: usage.inputTokens,
  cr: usage.cacheReadTokens ?? 0,
  cw: usage.cacheWriteTokens ?? 0,
  out: usage.outputTokens,
})

const bucketsEqual = (a: Buckets, b: Buckets): boolean =>
  a.in === b.in && a.cr === b.cr && a.cw === b.cw && a.out === b.out

/** Extract (turn, step, usage) from a session event, or undefined. */
function usageOf(event: SessionEvent): { turn: number; step: number; usage: TokenUsage } | undefined {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
    return { turn: event.data.turn, step: event.data.step, usage: event.data.chunk.usage }
  }
  if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    return { turn: event.data.turn, step: event.data.step, usage: event.data.usage }
  }
  return undefined
}

const MS_PER_DAY = 86_400_000

function dayKey(ts: number): string {
  const d = new Date(ts)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}${mm}${dd}`
}

const isoDayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10)

/** Parse "Nd" | "Nh" | "Nm" relative-window syntax; returns milliseconds. */
function parseAgo(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const match = /^([0-9]+)([dhm])$/u.exec(trimmed)
  if (match === null) return undefined
  const n = Number(match[1])
  switch (match[2]) {
    case 'd': return n * MS_PER_DAY
    case 'h': return n * 3_600_000
    case 'm': return n * 60_000
    default: return undefined
  }
}

function formatWindow(bounds: { since?: number; until?: number }): string {
  const open = bounds.since !== undefined || bounds.until !== undefined
  if (!open) return ''
  const since = bounds.since !== undefined ? new Date(bounds.since).toISOString() : '-∞'
  const until = bounds.until !== undefined ? new Date(bounds.until).toISOString() : 'now'
  return ` [${since} → ${until}]`
}

const fmtInt = (n: number): string => n.toLocaleString('en-US')

/** Render one Buckets line, e.g. `in=1,234 (+cr=45,678 cw=0) out=890`. */
export function formatBuckets(b: Buckets): string {
  const inputTotal = b.in + b.cr + b.cw
  return `in=${fmtInt(inputTotal)} (uncached=${fmtInt(b.in)}, cacheRead=${fmtInt(b.cr)}, cacheWrite=${fmtInt(b.cw)}) out=${fmtInt(b.out)}`
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TokenStats extends Service {
  static Config = undefined

  private readonly rootDir: string
  private readonly sessions = new Map<string, SessionState>()
  private readonly turns = new Map<string, Buckets>()
  private readonly pending = new Set<Promise<void>>()
  private retentionDays: number
  private recordsWritten = 0

  constructor(ctx: Context, config: TokenStatsConfig = {}) {
    super(ctx, 'tokenStats')
    this.retentionDays = config.retentionDays !== undefined && config.retentionDays > 0
      ? Math.floor(config.retentionDays)
      : 0
    this.rootDir = join(resolveDshHome(), 'token-stats')

    ctx.on('session/created', (session) => {
      this.adopt(session)
    }, { global: true })

    ctx.on('session/event', (session, event) => {
      this.foldEvent(session, event)
    }, { global: true })

    ctx.on('session/flush', async (session) => {
      await this.persist(session)
    }, { global: true })

    ctx.on('session/disposed', (session) => {
      // Keep the folded state in memory: querying a just-closed session is a
      // legitimate ask, and the process-mapped snapshot is cheap. Only the
      // live `Session` object goes away.
      void session
    }, { global: true })

    this.track(this.cleanupRetention())
  }


  // ---- adoption + fold ----------------------------------------------------

  /**
   * Adopt a live session: register metadata, then replay its durable log.
   * The session's `events` snapshot includes the constructor seed (replay of a
   * stored log), which `session/event` does NOT publish — replay is therefore
   * the only way to pick up historical usage for a reopened session.
   */
  adopt(session: Session): void {
    const state = this.stateFor(session.id, session.header)
    for (const event of session.events) {
      this.foldOne(session, state, event)
    }
  }

  /** Fold one appended event. Follows token-meter's replace-not-add invariant. */
  foldEvent(session: Session, event: SessionEvent): void {
    const state = this.sessions.get(session.id)
    if (state === undefined) {
      // Not adopted (should not happen for live sessions): adopt on touch.
      this.adopt(session)
      return
    }
    this.foldOne(session, state, event)
  }

  private stateFor(sessionId: string, header: Session['header']): SessionState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = {
        meta: { cwd: header.cwd, createdAt: header.createdAt },
        totals: { in: 0, cr: 0, cw: 0, out: 0, samples: 0 },
      }
      this.sessions.set(sessionId, state)
    } else {
      if (header.cwd !== undefined) state.meta.cwd = header.cwd
      if (header.createdAt !== undefined) state.meta.createdAt = header.createdAt
    }
    return state
  }

  private foldOne(session: Session, state: SessionState, event: SessionEvent): void {
    const sample = usageOf(event)
    if (sample === undefined) return
    const buckets = bucketsFromUsage(sample.usage)
    const last = state.last
    if (last !== undefined && last.turn === sample.turn && last.step === sample.step) {
      if (bucketsEqual(last.buckets, buckets)) return
      state.totals = {
        ...subBuckets(state.totals, last.buckets),
        samples: state.totals.samples,
      }
      this.subFromTurn(session.id, sample.turn, last.buckets)
    }
    state.totals = {
      ...addBuckets(state.totals, buckets),
      samples: state.totals.samples + 1,
      lastSampleAt: event.time,
    }
    this.addToTurn(session.id, sample.turn, buckets)
    state.last = { turn: sample.turn, step: sample.step, buckets }
    this.track(this.writeRecord({
      ts: event.time,
      sessionId: session.id,
      turn: sample.turn,
      step: sample.step,
      ...buckets,
    }))
  }

  // Turn-level aggregation keyed by `${sessionId}#${turn}`.
  private turnKey(sessionId: string, turn: number): string {
    return `${sessionId}#${turn}`
  }

  private addToTurn(sessionId: string, turn: number, buckets: Buckets): void {
    const key = this.turnKey(sessionId, turn)
    const current = this.turns.get(key) ?? zeroBuckets()
    this.turns.set(key, addBuckets(current, buckets))
  }

  private subFromTurn(sessionId: string, turn: number, buckets: Buckets): void {
    const key = this.turnKey(sessionId, turn)
    const current = this.turns.get(key)
    if (current === undefined) return
    this.turns.set(key, subBuckets(current, buckets))
  }

  // ---- persistence --------------------------------------------------------

  private recordFile(ts: number): string {
    return join(this.rootDir, 'records', `records-${dayKey(ts)}.jsonl`)
  }

  private async writeRecord(rec: UsageRecord): Promise<void> {
    const file = this.recordFile(rec.ts)
    try {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, JSON.stringify(rec) + '\n', 'utf8')
      this.recordsWritten += 1
    } catch {
      // Best-effort: token statistics must never block session work. The
      // in-memory fold is the authoritative source for this process; replay
      // on the next boot recovers the rest.
    }
  }

  /** Persist session metadata and meta counters at one flush point. */
  async persist(session: Session): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    const state = this.sessions.get(session.id)
    const sessionsFile = join(this.rootDir, 'sessions.json')
    let existing: Record<string, SessionMeta> = {}
    try {
      existing = JSON.parse(await readFile(sessionsFile, 'utf8')) as Record<string, SessionMeta>
    } catch {
      // Tolerate missing/corrupt sessions.json — rewrite merges into it.
    }
    existing[session.id] = state !== undefined ? { ...state.meta } : { cwd: session.header.cwd, createdAt: session.header.createdAt }
    try {
      await writeFile(sessionsFile, JSON.stringify(existing, null, 2) + '\n', 'utf8')
    } catch { /* best-effort */ }
    const metaFile = join(this.rootDir, 'meta.json')
    try {
      await writeFile(metaFile, JSON.stringify({
        lastFlushAt: Date.now(),
        lastFlushedSessionId: session.id,
        recordsWritten: this.recordsWritten,
        knownSessions: this.sessions.size,
      }, null, 2) + '\n', 'utf8')
    } catch { /* best-effort */ }
  }

  /** Remove day JSONL files older than the configured retention. */
  private async cleanupRetention(): Promise<void> {
    if (this.retentionDays <= 0) return
    // Deferred to a microtask so it does not sit on the plugin boot path.
    await Promise.resolve()
    const recordsDir = join(this.rootDir, 'records')
    let entries: string[]
    try {
      const { readdir } = await import('node:fs/promises')
      entries = await readdir(recordsDir)
    } catch {
      return
    }
    const cutoff = new Date(Date.now() - this.retentionDays * MS_PER_DAY)
    const cutoffKey = dayKey(cutoff.getTime())
    for (const entry of entries) {
      const match = /^records-(\d{8})\.jsonl$/u.exec(entry)
      const day = match?.[1]
      if (day === undefined) continue
      if (day < cutoffKey) {
        try { await rm(join(recordsDir, entry)) } catch { /* best-effort */ }
      }
    }
  }

  /** Bookkeeping helper: track fire-and-forget persistence promises so the
   * service can be disposed after they settle and tests can `awaitQuiescent()`. */
  private track<T>(p: Promise<T>): void {
    const wrapped = p.then(
      () => undefined,
      () => undefined,
    )
    this.pending.add(wrapped)
    wrapped.finally(() => this.pending.delete(wrapped))
  }

  /** Await all pending persistence work (tests / controlled shutdown). */
  async awaitQuiescent(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending])
    }
  }

  // ---- query ---------------------------------------------------------------

  private sessionRow(sessionId: string, state: SessionState): SessionAggregationRow {
    const { totals } = state
    return {
      sessionId,
      samples: totals.samples,
      cwd: state.meta.cwd,
      createdAt: state.meta.createdAt,
      lastSampleAt: totals.lastSampleAt,
      in: totals.in,
      cr: totals.cr,
      cw: totals.cw,
      out: totals.out,
    }
  }

  private matchesWindow(ts: number | undefined, since?: number, until?: number): boolean {
    if (ts === undefined) return since === undefined && until === undefined
    if (since !== undefined && ts < since) return false
    if (until !== undefined && ts >= until) return false
    return true
  }

  /**
   * Query the current in-memory fold. `scope='session'` requires `sessionId`
   * (fall back to the caller's session in the tool/command layer);
   * `scope='workspace'` groups by the recorded `cwd`; `scope='global'`
   * includes every adopted session. `granularity='total'` returns one
   * aggregate row; the others return per-X rows within the window.
   *
   * Note: `since`/`until` filter by last-sample timestamp per row. For
   * per-day/per-turn rows the filter uses the row's activity window.
   */
  query(options: QueryOptions = {}): Aggregation {
    const scope = options.scope ?? 'global'
    const granularity = options.granularity ?? 'total'

    if (granularity === 'perTurn') {
      const rows: TurnAggregationRow[] = []
      for (const [key, buckets] of this.turns) {
        const splitAt = key.lastIndexOf('#')
        if (splitAt < 0) continue
        const sessionId = key.slice(0, splitAt)
        const turn = Number(key.slice(splitAt + 1))
        const sessionState = this.sessions.get(sessionId)
        if (sessionState === undefined) continue
        if (!this.matchesWindow(sessionState.totals.lastSampleAt, options.since, options.until)) continue
        if (scope === 'session' && options.sessionId !== undefined && sessionId !== options.sessionId) continue
        if (scope === 'workspace' && options.workspace !== undefined && sessionState.meta.cwd !== options.workspace) continue
        rows.push({ sessionId, turn, samples: 1, ...copyBuckets(buckets) })
      }
      rows.sort((a, b) => (a.sessionId === b.sessionId ? a.turn - b.turn : a.sessionId.localeCompare(b.sessionId)))
      const totals = rows.reduce((acc, row) => addBuckets(acc, row), zeroBuckets())
      return {
        scope,
        granularity,
        since: options.since,
        until: options.until,
        buckets: totals,
        samples: rows.reduce((acc, r) => acc + r.samples, 0),
        rows,
      }
    }

    if (granularity === 'perSession') {
      const rows: SessionAggregationRow[] = []
      for (const [sessionId, state] of this.sessions) {
        if (state.totals.samples === 0) continue
        if (!this.matchesWindow(state.totals.lastSampleAt, options.since, options.until)) continue
        if (scope === 'session' && sessionId !== options.sessionId) continue
        if (scope === 'workspace' && options.workspace !== undefined && state.meta.cwd !== options.workspace) continue
        rows.push(this.sessionRow(sessionId, state))
      }
      rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      const totals = rows.reduce((acc, row) => addBuckets(acc, row), zeroBuckets())
      return {
        scope,
        granularity,
        since: options.since,
        until: options.until,
        buckets: totals,
        samples: rows.reduce((acc, r) => acc + r.samples, 0),
        rows,
      }
    }

    if (granularity === 'perDay') {
      const byDay = new Map<string, DayAggregationRow>()
      for (const state of this.sessions.values()) {
        if (state.totals.samples === 0) continue
        if (!this.matchesWindow(state.totals.lastSampleAt, options.since, options.until)) continue
        if (scope === 'workspace' && options.workspace !== undefined && state.meta.cwd !== options.workspace) continue
        const ts = state.totals.lastSampleAt
        if (ts === undefined) continue
        const key = isoDayKey(ts)
        const row = byDay.get(key) ?? { day: key, samples: 0, ...zeroBuckets() }
        row.samples += state.totals.samples
        row.in += state.totals.in
        row.cr += state.totals.cr
        row.cw += state.totals.cw
        row.out += state.totals.out
        byDay.set(key, row)
      }
      const rows = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
      const totals = rows.reduce((acc, row) => addBuckets(acc, row), zeroBuckets())
      return {
        scope,
        granularity,
        since: options.since,
        until: options.until,
        buckets: totals,
        samples: rows.reduce((acc, r) => acc + r.samples, 0),
        rows,
      }
    }

    // granularity === 'total'
    let totals = zeroBuckets()
    let samples = 0
    if (scope === 'session') {
      const state = options.sessionId !== undefined ? this.sessions.get(options.sessionId) : undefined
      if (state !== undefined) {
        totals = copyBuckets(state.totals)
        samples = state.totals.samples
      }
    } else if (scope === 'workspace') {
      for (const state of this.sessions.values()) {
        if (state.totals.samples === 0) continue
        if (options.workspace !== undefined && state.meta.cwd !== options.workspace) continue
        if (!this.matchesWindow(state.totals.lastSampleAt, options.since, options.until)) continue
        totals = addBuckets(totals, state.totals)
        samples += state.totals.samples
      }
    } else {
      for (const state of this.sessions.values()) {
        if (state.totals.samples === 0) continue
        if (!this.matchesWindow(state.totals.lastSampleAt, options.since, options.until)) continue
        totals = addBuckets(totals, state.totals)
        samples += state.totals.samples
      }
    }
    return {
      scope,
      granularity,
      since: options.since,
      until: options.until,
      buckets: totals,
      samples,
    }
  }

  /** Human-readable text view of one aggregation. */
  format(agg: Aggregation): string {
    const window = formatWindow(agg)
    const header = `token-stats (${agg.scope}/${agg.granularity})${window}`
    const lines = [header, `  total: ${formatBuckets(agg.buckets)}  samples=${agg.samples}`]
    if (agg.rows === undefined) return lines.join('\n')

    if (agg.granularity === 'perTurn') {
      lines.push('  turns:')
      for (const row of agg.rows as TurnAggregationRow[]) {
        lines.push(`    ${row.sessionId}  turn=${row.turn}  ${formatBuckets(row)}`)
      }
    } else if (agg.granularity === 'perSession') {
      lines.push('  sessions:')
      for (const row of agg.rows as SessionAggregationRow[]) {
        const cwd = row.cwd !== undefined ? ` cwd=${row.cwd}` : ''
        lines.push(`    ${row.sessionId}${cwd} samples=${row.samples}: ${formatBuckets(row)}`)
      }
    } else if (agg.granularity === 'perDay') {
      lines.push('  days:')
      for (const row of agg.rows as DayAggregationRow[]) {
        lines.push(`    ${row.day}  samples=${row.samples}: ${formatBuckets(row)}`)
      }
    }
    return lines.join('\n')
  }

  // ---- registrations -------------------------------------------------------

  registerTool(ctx: Context): void {
    const stats = this
    ctx.tools.register(defineTool({
      name: 'token_stats',
      description: 'Query durable token-usage statistics for the current session, the current workspace, or all sessions seen by this harness process. Buckets: input tokens (split into uncached input, cache read, cache write) and output tokens. No cost/pricing — only volumes.',
      parameters: {
        scope: {
          type: 'string',
          enum: ['session', 'workspace', 'global'],
          description: "Aggregation scope: the calling session, the calling session's workspace (cwd), or every adopted session. Defaults to 'session'.",
        },
        granularity: {
          type: 'string',
          enum: ['total', 'perTurn', 'perSession', 'perDay'],
          description: "'total' = one aggregate row; 'perTurn' = per-question rows within scope; 'perSession' = one row per session; 'perDay' = one row per UTC day. Defaults to 'total'.",
        },
        since: { type: 'number', description: 'Optional window start, Unix epoch milliseconds (inclusive).' },
        until: { type: 'number', description: 'Optional window end, Unix epoch milliseconds (exclusive).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: stats.format(value as unknown as Aggregation) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const agent = exec.agent
        const scope = args.scope ?? 'session'
        const agg = stats.query({
          scope,
          granularity: args.granularity ?? 'total',
          ...(agent?.session.id !== undefined ? { sessionId: agent.session.id as string } : {}),
          ...(agent?.session.header.cwd !== undefined ? { workspace: agent.session.header.cwd } : {}),
          ...(args.since !== undefined ? { since: args.since } : {}),
          ...(args.until !== undefined ? { until: args.until } : {}),
        })
        // Cast through JsonValue so the tool DSL accepts the structured value;
        // `format()` re-reads it on the model side.
        return agg as unknown as import('@deepseek-ai/dsh-session').JsonValue
      },
    }))
  }

  registerCommands(ctx: Context): void {
    const stats = this
    ctx.commands.register({
      name: 'tokens',
      description: 'show durable token-usage statistics',
      input: { hint: '[ago] [scope]' },
      recordInput: false,
      handler: invocation => {
        const tokens = invocation.rawInput.trim().length === 0
          ? []
          : invocation.rawInput.trim().split(/\s+/u)
        const agoText = tokens.find(t => /^[0-9]+[dhm]$/u.test(t))
        const scopeText = tokens.find(t => t === 'session' || t === 'workspace' || t === 'global' || t === 'all')
        const scope = scopeText === 'all' ? 'global' : scopeText ?? 'session'
        const agoMs = agoText !== undefined ? parseAgo(agoText) : undefined
        if (agoText !== undefined && agoMs === undefined) {
          return { kind: 'error' as const, text: `Invalid window "${agoText}". Use a relative window like 1d, 24h, 30m.` }
        }
        const sessionId = invocation.agent.session.id
        const workspace = invocation.agent.session.header.cwd
        const agg = stats.query({
          scope,
          sessionId,
          workspace,
          since: agoMs !== undefined ? Date.now() - agoMs : undefined,
          granularity: 'total',
        })
        return { kind: 'success' as const, text: stats.format(agg) }
      },
    })
  }
}

/**
 * Plugin entry wiring: TokenStats is a Service (its constructor provides
 * `ctx.tokenStats`), and the model tool + slash command register through
 * `ctx.inject` so they only mount once the host runtime has `tools` and
 * `commands` ready.
 */
export const inject = ['tools', 'commands']

export function apply(ctx: Context): void {
  const stats = new TokenStats(ctx, {})
  stats.registerTool(ctx)
  stats.registerCommands(ctx)
}

export default TokenStats
