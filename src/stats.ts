/**
 * Trigger statistics: how often each skill was actually invoked. The count
 * comes from the local session logs — a user-explicit skill invocation rides a
 * `user/message` event whose `source.kind === 'skill-invocation'` (the
 * MessageSourceMap augmentation from @deepseek-ai/dsh-skill). Sessions are
 * read through the host's `sessionQuery` service, which transparently
 * decompresses the on-disk JSONL.zstd artifacts.
 *
 * Counting is deliberately per-skill-name, not per-source: a name may resolve
 * to different files across projects, but the model-facing identity (and the
 * `skill-invocation` source it records) is the kebab-case name alone.
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

/** Count skill invocations in one session's event log, keyed by skill name. */
export function countSkillInvocations(events: readonly SessionEvent[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind === 'skill-invocation') {
      counts.set(source.name, (counts.get(source.name) ?? 0) + 1)
    }
  }
  return counts
}

/** Scan every session and total per-skill invocation counts. */
export async function readSkillStats(query: SessionQueryLike): Promise<SkillStat[]> {
  const totals = new Map<string, number>()
  const sessions = await query.listSessions()
  for (const record of sessions) {
    let snapshot: { events: SessionEvent[] }
    try {
      snapshot = await query.readSession(record.header.id)
    } catch {
      continue // unreadable sessions are skipped, never fatal
    }
    for (const [name, count] of countSkillInvocations(snapshot.events)) {
      totals.set(name, (totals.get(name) ?? 0) + count)
    }
  }
  return [...totals.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name))
}

/** A memoized stats reader (the panel polls, but logs change slowly). */
export type SkillStatsReader = () => Promise<SkillStat[]>

/** Wrap a query in a TTL cache so a 5s panel poll does not rescan every log. */
export function createSkillStatsReader(query: SessionQueryLike, ttlMs = 30_000): SkillStatsReader {
  let cached: SkillStat[] | undefined
  let cachedAt = 0
  return async () => {
    const now = Date.now()
    if (cached !== undefined && now - cachedAt < ttlMs) return cached
    cached = await readSkillStats(query)
    cachedAt = Date.now()
    return cached
  }
}
