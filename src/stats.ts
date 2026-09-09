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
 * Two read paths, cheapest first:
 *
 * 1. Cold path (preferred): the host's `sessionPersistence` seam serves raw
 *    stored logs — decompress + parse only, no Session restore, no
 *    structuredClone-per-event, no deepFreeze. `list()` also reports an opaque
 *    per-session revision token, so the checkpoint re-reads exactly the
 *    sessions whose revision changed (plus live sessions via the query seam).
 *    No time watermark, no daily full reconciliation.
 * 2. Query fallback: `sessionQuery.readSession` restores + replay-validates a
 *    full Session per call (structuredClone × 2 + deepFreeze). Reads are
 *    strictly sequential (concurrency 1) so at most one restored log is
 *    resident, and a per-session checkpoint + incremental scans keeps the
 *    repeat cost to the recent window: a full scan decompresses every session
 *    log, which grows linearly with total history. Sessions older than the
 *    effective watermark are therefore treated as finalized — their
 *    per-session counts live in the checkpoint (persisted by the host via the
 *    sidecar) and are skipped on incremental scans; only the recent window is
 *    re-read. A daily full reconciliation rebuilds the cache and advances the
 *    watermark, so a resumed old session is eventually re-counted. On top of
 *    that, the reader's TTL adapts to the measured scan duration
 *    (STATS_TTL_SCAN_FACTOR), so a heavy scan also lowers its own frequency.
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
import { mapConcurrent } from './concurrency.ts'
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

/**
 * Narrow structural view of the host's session-persistence seam (kept loose
 * so no runtime import of host packages is needed — the owner adapts the real
 * service via {@link asPersistenceSeam}). Raw log reads here cost decompress +
 * parse only: no Session restore, no per-event clone, no deep-freeze.
 */
export interface ColdSessionSnapshot {
  header: { id: SessionId; createdAt?: number }
  /** Opaque per-session change token, kept as its string form. */
  revision: string
}

/** One read handle over a stored session log (always closed after counting). */
export interface ColdSessionHandle {
  read(): Promise<{ events: SessionEvent[] }>
  close(): Promise<void> | void
}

/** Minimal persistence surface the cold scan needs. */
export interface SessionPersistenceLike {
  /** Lightweight listing: headers + revision tokens, no event logs. */
  list(): Promise<readonly ColdSessionSnapshot[]>
  open(id: SessionId, access: 'read'): Promise<ColdSessionHandle>
}

/**
 * Adapt a host persistence service to {@link SessionPersistenceLike}.
 * Shape-checked only (no I/O): returns undefined when the value is not a
 * usable seam, so callers fall back to the query path. The adapter re-resolves
 * nothing and holds no state — a replaced host service surfaces as ordinary
 * per-call failures, which scans already tolerate.
 */
export function asPersistenceSeam(service: unknown): SessionPersistenceLike | undefined {
  if (service === null || typeof service !== 'object') return undefined
  const { list, open } = service as { list?: unknown; open?: unknown }
  if (typeof list !== 'function' || typeof open !== 'function') return undefined
  // Bind: host services read instance state (this.tracker, …) — an unbound
  // destructured method throws inside list()/open().
  const listFn = (list as () => Promise<unknown>).bind(service)
  const openFn = (open as (id: SessionId, access: 'read') => Promise<unknown>).bind(service)
  return {
    list: async () => {
      const rows = await listFn()
      if (!Array.isArray(rows)) throw new Error('persistence list shape mismatch')
      return rows.map((row) => {
        const record = row as { header?: { id?: unknown; createdAt?: unknown }; revision?: unknown }
        const id = record.header?.id
        if (typeof id !== 'string' && typeof id !== 'number') throw new Error('persistence snapshot shape mismatch')
        const created = record.header?.createdAt
        return {
          header: {
            id: id as SessionId,
            ...(typeof created === 'number' ? { createdAt: created } : {}),
          },
          revision: String(record.revision),
        }
      })
    },
    open: async (id, access) => {
      const raw = await openFn(id, access)
      if (raw === null || typeof raw !== 'object') throw new Error('persistence handle shape mismatch')
      const { read, close } = raw as { read?: unknown; close?: unknown }
      if (typeof read !== 'function' || typeof close !== 'function') throw new Error('persistence handle shape mismatch')
      const readFn = (read as (offset: number, length: undefined) => Promise<unknown>).bind(raw)
      const closeFn = (close as () => Promise<void> | void).bind(raw)
      return {
        read: async () => {
          const out = await readFn(0, undefined)
          const events = (out as { events?: unknown } | null)?.events
          if (!Array.isArray(events)) throw new Error('persistence read shape mismatch')
          return { events: events as SessionEvent[] }
        },
        close: () => closeFn(),
      }
    },
  }
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
  // Missing or non-positive timestamps never freeze by time (full scans cache
  // such sessions explicitly instead — see below). The re-read path is merely
  // slower, never wrong.
  return typeof created === 'number' && created > 0 && created < watermark
}

/** Max parallel session-log reads per scan. Reads on the query path restore +
 * replay-validate a full Session each (structuredClone × 2 + deepFreeze), so
 * this stays 1: at most one restored log is resident and a heavy corpus costs
 * wall time, never a memory spike. The cold path reads sequentially anyway. */
const SCAN_READ_CONCURRENCY = 1

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
      const id = record.header.id as unknown as string
      // Sessions without a usable timestamp never freeze by time, so cache
      // them explicitly once read — otherwise they are re-read on every
      // incremental scan forever.
      if (counted.size > 0 && (isFrozen(record, cutoff) || !(typeof created === 'number' && created > 0))) {
        cache[id] = { createdAt: typeof created === 'number' ? created : 0, counts: Object.fromEntries(counted) }
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
  const frozenIds = checkpoint.frozenSessions
  const unfrozen = sessions.filter((record) =>
    !Object.prototype.hasOwnProperty.call(frozenIds, record.header.id as unknown as string)
    && !isFrozen(record, checkpoint.frozenBefore))
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
    if (entry.createdAt > 0 && !inWindow(entry.createdAt, windowDays, nowMs)) {
      delete checkpoint.frozenSessions[id] // lazily prune entries provably outside the window
      continue
    }
    mergeInto(totals, new Map(Object.entries(entry.counts)))
  }
  mergeInto(totals, new Map(Object.entries(recent)))
  return { stats: toSorted(totals), mutated: false }
}

/**
 * One pass over the corpus through the persistence seam. Reads are strictly
 * sequential and each handle is closed before the next opens, so at most one
 * raw log is resident. A session is re-read only when its revision token
 * changed since the checkpoint; the rolling window is applied from the
 * listing headers, so out-of-window logs are never even opened. Live sessions
 * (in-memory, possibly newer than their persisted revision) are read through
 * `readLive` and never enter the revision cache.
 *
 * A `list()` failure rejects — the reader keeps the previous totals, and the
 * next poll retries. Per-session failures are skipped, never fatal.
 */
export async function scanCold(
  persistence: SessionPersistenceLike,
  checkpoint: SkillStatsCheckpoint,
  nowMs: number,
  windowDays: number,
  liveIds: ReadonlySet<string> = new Set(),
  readLive: (id: SessionId) => Promise<readonly SessionEvent[] | undefined> = async () => undefined,
): Promise<SkillStat[]> {
  const revisions = checkpoint.coldRevisions ?? (checkpoint.coldRevisions = {})
  const totals: Totals = {}
  const snapshots = await persistence.list()
  const seen = new Set<string>()
  for (const snapshot of snapshots) {
    const id = snapshot.header.id as unknown as string
    seen.add(id)
    if (liveIds.has(id)) continue // covered by the live read below, never double-counted
    const created = snapshot.header.createdAt
    if (!inWindow(created, windowDays, nowMs)) {
      delete revisions[id]
      continue
    }
    const rev = snapshot.revision
    const cached = revisions[id]
    if (cached !== undefined && cached.rev === rev) {
      mergeInto(totals, new Map(Object.entries(cached.counts)))
      continue
    }
    let counted: Map<string, InvocationStat> | undefined
    try {
      const handle = await persistence.open(snapshot.header.id, 'read')
      try {
        counted = countSkillInvocations((await handle.read()).events)
      } finally {
        await handle.close()
      }
    } catch {
      continue // unreadable sessions are skipped (and not cached), never fatal
    }
    revisions[id] = {
      rev,
      createdAt: typeof created === 'number' ? created : 0,
      counts: Object.fromEntries(counted),
    }
    mergeInto(totals, counted)
  }
  for (const id of Object.keys(revisions)) {
    if (!seen.has(id)) delete revisions[id] // sessions gone from the listing leave the cache
  }
  for (const id of liveIds) {
    let events: readonly SessionEvent[] | undefined
    try {
      events = await readLive(id as unknown as SessionId)
    } catch {
      continue
    }
    if (events === undefined) continue
    mergeInto(totals, countSkillInvocations(events))
  }
  return toSorted(totals)
}

/**
 * Full-corpus totals in one shot (no checkpoint reuse). Kept as the
 * reference implementation for tests and one-off callers.
 */
export async function readSkillStats(query: SessionQueryLike, windowDays = 0): Promise<SkillStat[]> {
  const checkpoint: SkillStatsCheckpoint = { windowDays, frozenBefore: 0, frozenSessions: {}, lastFullReconcile: 0 }
  return (await scan(query, checkpoint, Date.now(), windowDays)).stats
}

/**
 * Full-corpus totals in one shot through the persistence seam (no checkpoint
 * reuse). Reference implementation for tests and one-off callers.
 */
export async function readColdSkillStats(persistence: SessionPersistenceLike, windowDays = 0): Promise<SkillStat[]> {
  const checkpoint: SkillStatsCheckpoint = { windowDays, frozenBefore: 0, frozenSessions: {}, lastFullReconcile: 0 }
  return scanCold(persistence, checkpoint, Date.now(), windowDays)
}

/** A memoized stats reader (the panel polls, but logs change slowly). */
export type SkillStatsReader = (() => Promise<SkillStat[]>) & {
  /** Which read path this reader scans with (set at wiring; absent on test doubles). */
  source?: 'cold' | 'query'
}

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
  /** Preferred cheap seam: raw stored-log reads keyed by revision token. */
  persistence?: SessionPersistenceLike
  /** Live session ids (usually 0-2) read through the query seam, not the cache. */
  listLiveIds?: () => Promise<readonly SessionId[]>
  /** Full current log of one live session; undefined skips it for this scan. */
  readLiveSession?: (id: SessionId) => Promise<{ events: SessionEvent[] } | undefined>
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

  const reader: SkillStatsReader = async () => {
    const startedAt = now()
    const base = typeof ttlMs === 'function' ? ttlMs() : ttlMs
    const ttl = Math.max(base, lastScanDurationMs * STATS_TTL_SCAN_FACTOR)
    if (cached !== undefined && startedAt - cachedAt < ttl) return cached
    // Expired (or first call): hand back the stale totals (empty on a truly
    // fresh start) and kick off one background rescan.
    if (refreshing === null) {
      const windowDays = options.windowDays?.() ?? 0
      const task: Promise<SkillStat[]> = options.persistence !== undefined
        ? (async () => {
            let liveIds = new Set<string>()
            if (options.listLiveIds !== undefined) {
              try {
                liveIds = new Set((await options.listLiveIds()).map((id) => String(id)))
              } catch { /* live listing is best-effort; the cold cache still counts */ }
            }
            return scanCold(options.persistence as SessionPersistenceLike, checkpoint, startedAt, windowDays, liveIds, async (id) => {
              const snapshot = await options.readLiveSession?.(id)
              return snapshot?.events
            })
          })()
        : scan(query, checkpoint, startedAt, windowDays).then(({ stats }) => stats)
      refreshing = task
        .then((stats) => {
          cached = stats
          cachedAt = now()
          lastScanDurationMs = Math.max(0, cachedAt - startedAt)
          checkpoint.lastTotals = stats
          options.onCheckpoint?.({
            ...checkpoint,
            frozenSessions: { ...checkpoint.frozenSessions },
            ...(checkpoint.coldRevisions !== undefined ? { coldRevisions: { ...checkpoint.coldRevisions } } : {}),
          })
        })
        .catch(() => { /* keep the previous totals on scan failure */ })
        .finally(() => { refreshing = null })
    }
    return cached ?? []
  }
  reader.source = options.persistence !== undefined ? 'cold' : 'query'
  return reader
}
