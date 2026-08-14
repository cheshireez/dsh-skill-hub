import { describe, expect, it } from 'vitest'
import { countSkillInvocations, createSkillStatsReader, readSkillStats, type SessionQueryLike } from './stats.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Minimal user/message event carrying a skill-invocation source. */
function invocationEvent(name: string, seq = 1): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: {
      id: 'm' + seq as never,
      role: 'user',
      content: [],
      source: { kind: 'skill-invocation', name, form: 'instructions' },
    },
  } as unknown as SessionEvent
}

/** Minimal non-skill user/message event. */
function plainUserEvent(seq = 1): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: { id: 'm' + seq as never, role: 'user', content: [], source: { kind: 'user' } },
  } as unknown as SessionEvent
}

describe('countSkillInvocations', () => {
  it('counts only user/message events with a skill-invocation source', () => {
    const events = [
      invocationEvent('code-review', 1),
      invocationEvent('code-review', 2),
      invocationEvent('tdd', 3),
      plainUserEvent(4),
      { type: 'assistant/message', seq: 5, time: 0, data: {} } as unknown as SessionEvent,
    ]
    const counts = countSkillInvocations(events)
    expect(counts.get('code-review')).toBe(2)
    expect(counts.get('tdd')).toBe(1)
    expect(counts.size).toBe(2)
  })

  it('returns an empty map for a log with no invocations', () => {
    expect(countSkillInvocations([]).size).toBe(0)
    expect(countSkillInvocations([plainUserEvent(1)]).size).toBe(0)
  })
})

describe('readSkillStats', () => {
  it('totals invocations across sessions and sorts by name', async () => {
    const query: SessionQueryLike = {
      listSessions: async () => [
        { header: { id: 'a' as never } },
        { header: { id: 'b' as never } },
      ],
      readSession: async (id) => ({
        events: id === 'a'
          ? [invocationEvent('tdd', 1), invocationEvent('tdd', 2)]
          : [invocationEvent('code-review', 1), plainUserEvent(2)],
      }),
    }
    expect(await readSkillStats(query)).toEqual([
      { name: 'code-review', count: 1 },
      { name: 'tdd', count: 2 },
    ])
  })

  it('skips sessions that fail to read', async () => {
    const query: SessionQueryLike = {
      listSessions: async () => [
        { header: { id: 'bad' as never } },
        { header: { id: 'good' as never } },
      ],
      readSession: async (id) => {
        if (id === 'bad') throw new Error('corrupt')
        return { events: [invocationEvent('tdd', 1)] }
      },
    }
    expect(await readSkillStats(query)).toEqual([{ name: 'tdd', count: 1 }])
  })
})

describe('createSkillStatsReader', () => {
  it('caches results within the TTL window', async () => {
    let reads = 0
    const query: SessionQueryLike = {
      listSessions: async () => [{ header: { id: 'a' as never } }],
      readSession: async () => {
        reads += 1
        return { events: [invocationEvent('tdd', 1)] }
      },
    }
    const reader = createSkillStatsReader(query, 60_000)
    await reader()
    await reader()
    expect(reads).toBe(1)
  })
})
