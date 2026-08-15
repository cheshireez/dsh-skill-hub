import { describe, expect, it } from 'vitest'
import { countSkillInvocations, createSkillStatsReader, readSkillStats, type SessionQueryLike } from './stats.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Minimal user/message event carrying a skill-invocation source. */
function invocationEvent(name: string, seq = 1, time = 0): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time,
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

/** Minimal `skill` tool call (model-invoked skill). */
function skillToolCall(name: string, seq = 1, time = 0): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time,
    data: { turn: 1, step: 1, callId: 'c' + seq as never, name: 'skill', arguments: JSON.stringify({ name }) },
  } as unknown as SessionEvent
}

describe('countSkillInvocations', () => {
  it('counts user-explicit skill-invocation sources', () => {
    const events = [
      invocationEvent('code-review', 1),
      invocationEvent('code-review', 2),
      invocationEvent('tdd', 3),
      plainUserEvent(4),
    ]
    const counts = countSkillInvocations(events)
    expect(counts.get('code-review')?.count).toBe(2)
    expect(counts.get('tdd')?.count).toBe(1)
    expect(counts.size).toBe(2)
  })

  it('counts model-invoked skill tool calls', () => {
    const events = [
      skillToolCall('godot-master', 1),
      skillToolCall('godot-master', 2),
      skillToolCall('tdd', 3),
      { type: 'tool/call', seq: 4, time: 0, data: { turn: 1, step: 1, callId: 'c4', name: 'bash', arguments: '{}' } } as unknown as SessionEvent,
    ]
    const counts = countSkillInvocations(events)
    expect(counts.get('godot-master')?.count).toBe(2)
    expect(counts.get('tdd')?.count).toBe(1)
    expect(counts.size).toBe(2)
  })

  it('merges both invocation paths and ignores malformed skill calls', () => {
    const events = [
      invocationEvent('tdd', 1),
      skillToolCall('tdd', 2),
      { type: 'tool/call', seq: 3, time: 0, data: { turn: 1, step: 1, callId: 'c3', name: 'skill', arguments: 'not json' } } as unknown as SessionEvent,
    ]
    const counts = countSkillInvocations(events)
    expect(counts.get('tdd')?.count).toBe(2)
    expect(counts.size).toBe(1)
  })

  it('returns an empty map for a log with no invocations', () => {
    expect(countSkillInvocations([]).size).toBe(0)
    expect(countSkillInvocations([plainUserEvent(1)]).size).toBe(0)
  })

  it('records the latest lastUsed time across events', () => {
    const events = [
      invocationEvent('a', 1, 1000),
      invocationEvent('a', 2, 3000),
      invocationEvent('a', 3, 2000),
      skillToolCall('a', 4, 2500),
    ]
    const stats = countSkillInvocations(events)
    expect(stats.get('a')).toEqual({ count: 4, lastUsed: 3000 })
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
      { name: 'code-review', count: 1, lastUsed: 0 },
      { name: 'tdd', count: 2, lastUsed: 0 },
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
    expect(await readSkillStats(query)).toEqual([{ name: 'tdd', count: 1, lastUsed: 0 }])
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
