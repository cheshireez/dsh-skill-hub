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
import type { SkillStat, SkillStatsCheckpoint } from './protocol.ts'
import type { SessionPersistenceLike, SessionQueryLike } from './stats/persistence.ts'
import { scan, scanCold, STATS_TTL_SCAN_FACTOR } from './stats/scan.ts'

export { asPersistenceSeam } from './stats/persistence.ts'
export type {
  ColdSessionHandle,
  ColdSessionSnapshot,
  SessionPersistenceLike,
  SessionQueryLike,
} from './stats/persistence.ts'
export {
  countSkillInvocations,
  readColdSkillStats,
  readSkillStats,
  scanCold,
  STATS_FREEZE_AFTER_MS,
  STATS_FULL_RECONCILE_MS,
  STATS_TTL_SCAN_FACTOR,
} from './stats/scan.ts'
export type { InvocationStat } from './stats/scan.ts'

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
