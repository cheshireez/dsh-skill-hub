/**
 * Trigger statistics: how often each skill was actually invoked. The count
 * comes from the local session logs, read through the host's `sessionQuery`
 * service (which transparently decompresses the on-disk JSONL.zstd artifacts).
 *
 * A skill is invoked two ways, both recorded in the log:
 *  - model-invoked: a `tool/call` event for the `skill` tool, whose raw
 *    `arguments` JSON names the requested skill (see @deepseek-ai/dsh-tool-skill);
 *  - user-explicit: a `user/message` event whose `source.kind ===
 *    'skill-invocation'` (the MessageSourceMap augmentation from
 *    @deepseek-ai/dsh-skill).
 *
 * Counting is per-skill-name, not per-source: a name may resolve to different
 * files across projects, but the model-facing identity is the kebab-case name.
 *
 * Scaling (per-session checkpoint + incremental scans): a full scan
 * decompresses every session log, which grows linearly with total history.
 * Sessions older than the effective watermark are therefore treated as
 * finalized — their per-session counts live in the checkpoint (persisted by
 * the host via the sidecar) and are skipped on incremental scans; only the
 * recent window is re-read. A daily full reconciliation rebuilds the cache
 * and advances the watermark, so a resumed old session is eventually
 * re-counted. On top of that, the reader's TTL adapts to the measured scan
 * duration (STATS_TTL_SCAN_FACTOR), so a heavy scan also lowers its own
 * frequency.
 *
 * Rolling window (statsWindowDays > 0): totals only include sessions created
 * within the last N days. The watermark then equals the window edge, so
 * sessions outside the window are neither re-read nor counted, and the
 * reconciliation prunes their cache entries. Changing the configured window
 * forces one full reconciliation immediately (the checkpoint records the
 * window it was built for), so the new semantics take effect on the next scan
 * instead of up to a day later.
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the 'skill-invocation' MessageSourceMap augmentation.
import type {} from '@deepseek-ai/dsh-skill'
import type { SkillStat, SkillStatsCheckpoint } from './protocol.ts'

/** Fallback freeze horizon when no rolling window is configured (14 days). */
export const STATS_FREEZE_AFTER_MS = 14 * 24 * 60 * 60 * 1000
/** Cadence of the full reconciliation that rebuilds the checkpoint (24 h). */
export const STATS_FULL_RECONCILE_MS = 24 * 60 * 60 * 1000
/** Adaptive TTL factor: effective TTL ≥ this multiple of the last scan duration. */
export const STATS_TTL_SCAN_FACTOR = 3

const DAY_MS = 24 * 60 * 60 * 1000

/** Narrow structural view of the session-query service (kept loose for tests). */
export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: SessionId; createdAt?: number } }>>
  readSession(id: SessionId): Promise<{ events: SessionEvent[] }>
}

/** Per-skill invocation stats in one session's event log. */
export interface InvocationStat {
  count: number
  /** Unix epoch ms of the most recent invocation in this batch. */
  lastUsed: number
}

/** Collect per-skill invocation counts and last-used times from one session. */
export function countSkillInvocations(events: readonly SessionEvent[]): Map<string, InvocationStat> {
  const stats = new Map<string, InvocationStat>()
  const bump = (name: string, time: number): void => {
    if (name === '') return
    const current = stats.get(name)
    if (current === undefined) stats.set(name, { count: 1, lastUsed: time })
    else {
      current.count += 1
      if (time > current.lastUsed) current.lastUsed = time
    }
  }
  for (const event of events) {
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind === 'skill-invocation') bump(source.name, event.time)
    } else if (event.type === 'tool/call') {
      const call = event.data
      if (call.name === 'skill') {
        // arguments is the raw JSON string; extract the requested skill name.
        try {
          const parsed: unknown = JSON.parse(call.arguments)
          if (typeof parsed === 'object' && parsed !== null) {
            const name = (parsed as { name?: unknown }).name
            if (typeof name === 'string') bump(name, event.time)
          }
        } catch { /* unparseable arguments skip */ }
      }
    }
  }
  return stats
}

/** Aggregated totals bucket keyed by skill name. */
type Totals = Record<string, InvocationStat>

function isFrozen(record: { header: { createdAt?: number } }, watermark: number): boolean {
  const created = record.header.createdAt
  // Missing or non-positive timestamps never freeze: the session stays on the
  // re-read path, which is merely slower — never wrong.
  return typeof created === 'number' && created > 0 && created < watermark
}

/** Bounded-concurrency map: session-log reads are independent decompressions, so wall time scales ~1/limit. Merge stays sequential in index order. */
async function mapConcurrent<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** Max parallel session-log reads per scan (read-only; merge is order-independent). */
const SCAN_READ_CONCURRENCY = 6

function mergeInto(totals: Totals, counted: Map<string, InvocationStat>): void {
  for (const [name, stat] of counted) {
    const total = totals[name]
    if (total === undefined) totals[name] = { ...stat }
    else {
      total.count += stat.count
      if (stat.lastUsed > total.lastUsed) total.lastUsed = stat.lastUsed
    }
  }
}

function toSorted(totals: Totals): SkillStat[] {
  return Object.entries(totals)
    .map(([name, stat]) => ({ name, count: stat.count, lastUsed: stat.lastUsed }))
    .sort((x, y) => x.name.localeCompare(y.name))
}

/** Effective freeze watermark for the configured rolling window (0 = all history → freeze horizon). */
function watermarkFor(windowDays: number, nowMs: number): number {
  return windowDays > 0 ? nowMs - windowDays * DAY_MS : nowMs - STATS_FREEZE_AFTER_MS
}

/**
 * Whether a session's usage counts toward the configured window. With no
 * window (0) everything counts — full history; with a window, only sessions
 * created inside it do. Distinct from the freeze watermark, which is purely a
 * re-read optimization.
 */
function inWindow(createdAt: number | undefined, windowDays: number, nowMs: number): boolean {
  if (windowDays <= 0) return true
  return typeof createdAt === 'number' && createdAt > 0 && createdAt >= nowMs - windowDays * DAY_MS
}

/**
 * One pass over the corpus. Runs either a full reconciliation (rebuilds the
 * per-session cache and advances the watermark — mutates the checkpoint) or a
 * cheap incremental scan (re-reads everything at or after the watermark and
 * merges over the cached sessions — leaves the checkpoint untouched). Totals
 * always apply the CURRENT window filter over the cached sessions, so a
 * window shrink takes effect immediately even before the next reconciliation.
 */
async function scan(query: SessionQueryLike, checkpoint: SkillStatsCheckpoint, nowMs: number, windowDays: number): Promise<{ stats: SkillStat[]; mutated: boolean }> {
  const sessions = await query.listSessions()
  const cutoff = watermarkFor(windowDays, nowMs)
  const dueFullScan = nowMs - checkpoint.lastFullReconcile >= STATS_FULL_RECONCILE_MS
    || checkpoint.windowDays !== windowDays

  if (dueFullScan) {
    const cache: SkillStatsCheckpoint['frozenSessions'] = {}
    const totals: Totals = {}
    const countedList = await mapConcurrent(sessions, SCAN_READ_CONCURRENCY, async (record) => {
      try {
        return countSkillInvocations((await query.readSession(record.header.id)).events)
      } catch {
        return undefined // unreadable sessions are skipped, never fatal
      }
    })
    sessions.forEach((record, index) => {
      const counted = countedList[index]
      if (counted === undefined) return
      const created = record.header.createdAt
      if (isFrozen(record, cutoff) && counted.size > 0 && typeof created === 'number') {
        cache[record.header.id as unknown as string] = { createdAt: created, counts: Object.fromEntries(counted) }
      }
      if (inWindow(created, windowDays, nowMs)) mergeInto(totals, counted)
    })
    checkpoint.frozenSessions = cache
    checkpoint.frozenBefore = cutoff
    checkpoint.windowDays = windowDays
    checkpoint.lastFullReconcile = nowMs
    return { stats: toSorted(totals), mutated: true }
  }

  const recent: Totals = {}
  const unfrozen = sessions.filter((record) => !isFrozen(record, checkpoint.frozenBefore))
  const recentList = await mapConcurrent(unfrozen, SCAN_READ_CONCURRENCY, async (record) => {
    try {
      return countSkillInvocations((await query.readSession(record.header.id)).events)
    } catch {
      return undefined // unreadable sessions are skipped, never fatal
    }
  })
  for (const counted of recentList) {
    if (counted === undefined) continue
    mergeInto(recent, counted)
  }
  const totals: Totals = {}
  for (const [id, entry] of Object.entries(checkpoint.frozenSessions)) {
    if (!inWindow(entry.createdAt, windowDays, nowMs)) {
      delete checkpoint.frozenSessions[id] // lazily prune entries outside the window
      continue
    }
    mergeInto(totals, new Map(Object.entries(entry.counts)))
  }
  mergeInto(totals, new Map(Object.entries(recent)))
  return { stats: toSorted(totals), mutated: false }
}

/**
 * Full-corpus totals in one shot (no checkpoint reuse). Kept as the
 * reference implementation for tests and one-off callers.
 */
export async function readSkillStats(query: SessionQueryLike, windowDays = 0): Promise<SkillStat[]> {
  const checkpoint: SkillStatsCheckpoint = { windowDays, frozenBefore: 0, frozenSessions: {}, lastFullReconcile: 0 }
  return (await scan(query, checkpoint, Date.now(), windowDays)).stats
}

/** A memoized stats reader (the panel polls, but logs change slowly). */
export type SkillStatsReader = () => Promise<SkillStat[]>

/** Optional wiring for {@link createSkillStatsReader}. */
export interface SkillStatsReaderOptions {
  /** Checkpoint restored from the sidecar; absent means "start from zero". */
  checkpoint?: SkillStatsCheckpoint
  /** Injectable clock (epoch ms); defaults to Date.now. Tests drive time with it. */
  now?: () => number
  /** Base rescan interval in ms; a getter reads the live config each check. */
  ttlMs?: number | (() => number)
  /** Rolling window in days; a getter reads the live config each scan. 0 = all history. */
  windowDays?: () => number
  /** Called after every completed scan (full or incremental) so the host can
   *  persist the checkpoint including the fresh totals. Cadence follows the
   *  scan TTL (minutes, not days) — the payload is tiny and writes are atomic. */
  onCheckpoint?: (checkpoint: SkillStatsCheckpoint) => void
}

/**
 * Wrap a query in a stale-while-revalidate cache: responses never wait for a
 * full session-log scan. While the TTL is fresh the cached totals are
 * returned; after expiry the stale totals are returned immediately and a
 * single background rescan refreshes them — the panel's next poll picks the
 * fresh numbers. A full scan decompresses every session log and can take
 * seconds, so it must never sit on the request path.
 *
 * Two scaling mechanisms keep this sane as history grows:
 *  - the rescan is incremental (per-session checkpoint, see module doc);
 *  - the effective TTL adapts to the measured scan duration, so a heavier
 *    corpus automatically lowers the rescan cadence instead of burning CPU
 *    on every poll interval.
 */
export function createSkillStatsReader(query: SessionQueryLike, ttlMs: number | (() => number) = 300_000, options: SkillStatsReaderOptions = {}): SkillStatsReader {
  const checkpoint: SkillStatsCheckpoint = options.checkpoint ?? { windowDays: 0, frozenBefore: 0, frozenSessions: {}, lastFullReconcile: 0 }
  const now = options.now ?? (() => Date.now())
  // Cold start serves the last persisted totals instantly (may be a window
  // behind); cachedAt stays 0 so the first call still kicks a background rescan.
  let cached: SkillStat[] | undefined = checkpoint.lastTotals !== undefined ? [...checkpoint.lastTotals] : undefined
  let cachedAt = 0
  let refreshing: Promise<void> | null = null
  let lastScanDurationMs = 0

  return async () => {
    const startedAt = now()
    const base = typeof ttlMs === 'function' ? ttlMs() : ttlMs
    const ttl = Math.max(base, lastScanDurationMs * STATS_TTL_SCAN_FACTOR)
    if (cached !== undefined && startedAt - cachedAt < ttl) return cached
    // Expired (or first call): hand back the stale totals (empty on a truly
    // fresh start) and kick off one background rescan.
    if (refreshing === null) {
      const windowDays = options.windowDays?.() ?? 0
      refreshing = scan(query, checkpoint, startedAt, windowDays)
        .then(({ stats }) => {
          cached = stats
          cachedAt = now()
          lastScanDurationMs = Math.max(0, cachedAt - startedAt)
          checkpoint.lastTotals = stats
          options.onCheckpoint?.({ ...checkpoint, frozenSessions: { ...checkpoint.frozenSessions } })
        })
        .catch(() => { /* keep the previous totals on scan failure */ })
        .finally(() => { refreshing = null })
    }
    return cached ?? []
  }
}
