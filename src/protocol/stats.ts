/** One skill's invocation stats across the local session logs. */
export interface SkillStat {
  /** Kebab-case skill name. */
  name: string
  /** How many sessions recorded a user-explicit invocation of this skill. */
  count: number
  /** Unix epoch ms of the most recent invocation (absent when never called). */
  lastUsed?: number
}

/** GET /api/skill-hub/stats */
export interface StatsResponse {
  ok: true
  /** Whether a session-log source was available (false means counts are empty). */
  available: boolean
  /** Sorted per-skill invocation counts. */
  stats: SkillStat[]
}

/**
 * Persisted incremental-scan checkpoint for the usage statistics (sidecar
 * `skillStats` field). Sessions created before `frozenBefore` are treated as
 * finalized: their per-session counts live in `frozenSessions` (only sessions
 * with at least one invocation are kept) and they are not re-read on
 * incremental scans. A daily full reconciliation rebuilds the cache and
 * advances the watermark, so a resumed old session is eventually re-counted.
 */
export interface SkillStatsCheckpoint {
  /** The rolling-window configuration this checkpoint was built for (0 = all history). */
  windowDays: number
  /** Watermark: every session with header.createdAt < this value is frozen. */
  frozenBefore: number
  /** Per-session counts of finalized sessions, keyed by session id. */
  frozenSessions: Record<string, { createdAt: number; counts: Record<string, { count: number; lastUsed: number }> }>
  /** Epoch ms of the last full reconciliation (drives the daily cadence). */
  lastFullReconcile: number
  /**
   * Totals from the last completed scan (any kind). Served instantly on cold
   * start so a restart still shows numbers while the background rescan runs.
   */
  lastTotals?: SkillStat[]
}
