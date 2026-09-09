import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the 'skill-invocation' MessageSourceMap augmentation.
import type {} from '@deepseek-ai/dsh-skill'
import { mapConcurrent } from '../concurrency.ts'
import type { SkillStat, SkillStatsCheckpoint } from '../protocol.ts'
import type { SessionPersistenceLike, SessionQueryLike } from './persistence.ts'

/** Fallback freeze horizon when no rolling window is configured (14 days). */
export const STATS_FREEZE_AFTER_MS = 14 * 24 * 60 * 60 * 1000
/** Cadence of the full reconciliation that rebuilds the checkpoint (24 h). */
export const STATS_FULL_RECONCILE_MS = 24 * 60 * 60 * 1000
/** Adaptive TTL factor: effective TTL ≥ this multiple of the last scan duration. */
export const STATS_TTL_SCAN_FACTOR = 3

const DAY_MS = 24 * 60 * 60 * 1000

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
export async function scan(query: SessionQueryLike, checkpoint: SkillStatsCheckpoint, nowMs: number, windowDays: number): Promise<{ stats: SkillStat[]; mutated: boolean }> {
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
  // 窗口过滤在增量路径同样生效：unfrozen 只代表"水位之后"，不等于"窗口之内"
  // （时间推进会把它挤出去），否则滑出窗口的会话会被多算到下一次全量对账。
  unfrozen.forEach((record, index) => {
    const counted = recentList[index]
    if (counted === undefined) return
    if (inWindow(record.header.createdAt, windowDays, nowMs)) mergeInto(recent, counted)
  })
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
