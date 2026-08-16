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
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the 'skill-invocation' MessageSourceMap augmentation.
import type {} from '@deepseek-ai/dsh-skill'
import type { SkillStat } from './protocol.ts'

/** Narrow structural view of the session-query service (kept loose for tests). */
export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: SessionId } }>>
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

/** Scan every session and total per-skill counts, keeping the latest lastUsed. */
export async function readSkillStats(query: SessionQueryLike): Promise<SkillStat[]> {
  const totals = new Map<string, InvocationStat>()
  const sessions = await query.listSessions()
  for (const record of sessions) {
    let snapshot: { events: SessionEvent[] }
    try {
      snapshot = await query.readSession(record.header.id)
    } catch {
      continue // unreadable sessions are skipped, never fatal
    }
    for (const [name, stat] of countSkillInvocations(snapshot.events)) {
      const total = totals.get(name)
      if (total === undefined) totals.set(name, { ...stat })
      else {
        total.count += stat.count
        if (stat.lastUsed > total.lastUsed) total.lastUsed = stat.lastUsed
      }
    }
  }
  return [...totals.entries()]
    .map(([name, stat]) => ({ name, count: stat.count, lastUsed: stat.lastUsed }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** A memoized stats reader (the panel polls, but logs change slowly). */
export type SkillStatsReader = () => Promise<SkillStat[]>

/**
 * Wrap a query in a stale-while-revalidate cache: responses never wait for a
 * full session-log scan. While the TTL is fresh the cached totals are
 * returned; after expiry the stale totals are returned immediately and a
 * single background rescan refreshes them — the panel's next poll picks the
 * fresh numbers. A full scan decompresses every session log and can take
 * seconds, so it must never sit on the request path.
 */
export function createSkillStatsReader(query: SessionQueryLike, ttlMs = 300_000): SkillStatsReader {
  let cached: SkillStat[] | undefined
  let cachedAt = 0
  let refreshing: Promise<void> | null = null
  return async () => {
    const now = Date.now()
    if (cached !== undefined && now - cachedAt < ttlMs) return cached
    // Expired (or first call): hand back the stale totals (empty on first
    // call) and kick off one background rescan.
    if (refreshing === null) {
      refreshing = readSkillStats(query)
        .then((stats) => {
          cached = stats
          cachedAt = Date.now()
        })
        .catch(() => { /* keep the previous totals on scan failure */ })
        .finally(() => { refreshing = null })
    }
    return cached ?? []
  }
}
