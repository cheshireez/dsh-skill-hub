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

/** Count skill invocations in one session's event log, keyed by skill name. */
export function countSkillInvocations(events: readonly SessionEvent[]): Map<string, number> {
  const counts = new Map<string, number>()
  const bump = (name: string): void => {
    if (name !== '') counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  for (const event of events) {
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind === 'skill-invocation') bump(source.name)
    } else if (event.type === 'tool/call') {
      const call = event.data
      if (call.name === 'skill') {
        // arguments is the raw JSON string; extract the requested skill name.
        try {
          const parsed: unknown = JSON.parse(call.arguments)
          if (typeof parsed === 'object' && parsed !== null) {
            const name = (parsed as { name?: unknown }).name
            if (typeof name === 'string') bump(name)
          }
        } catch { /* unparseable arguments skip */ }
      }
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
