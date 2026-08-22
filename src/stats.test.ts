import { describe, expect, it } from 'vitest'
import { countSkillInvocations, createSkillStatsReader, readSkillStats, STATS_FREEZE_AFTER_MS, type SessionQueryLike } from './stats.ts'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

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
  it('returns empty on first call, then serves the background scan from cache', async () => {
    let resolveScan: (() => void) | undefined
    const query: SessionQueryLike = {
      listSessions: async () => [{ header: { id: 'a' as never } }],
      readSession: () => new Promise((resolve) => {
        resolveScan = () => resolve({ events: [invocationEvent('tdd', 1)] } as never)
      }),
    }
    const reader = createSkillStatsReader(query, 60_000)
    // 首次调用不等待全量扫描：立即返回空。
    expect(await reader()).toEqual([])
    // 后台扫描完成后，后续调用命中缓存。
    resolveScan!()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await reader()).toEqual([{ name: 'tdd', count: 1, lastUsed: 0 }])
    expect(await reader()).toEqual([{ name: 'tdd', count: 1, lastUsed: 0 }])
  })

  it('serves stale totals after expiry and rescans only once', async () => {
    let reads = 0
    const query: SessionQueryLike = {
      listSessions: async () => [{ header: { id: 'a' as never } }],
      readSession: async () => {
        reads += 1
        return { events: [invocationEvent('tdd', 1)] }
      },
    }
    const reader = createSkillStatsReader(query, 200)
    expect(await reader()).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await reader()).toEqual([{ name: 'tdd', count: 1, lastUsed: 0 }])
    // TTL 过期时立即返回 stale 值并触发一次后台刷新；后续调用命中缓存。
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await reader()).toEqual([{ name: 'tdd', count: 1, lastUsed: 0 }])
    expect(await reader()).toEqual([{ name: 'tdd', count: 1, lastUsed: 0 }])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(reads).toBe(2)
  })
})

// ------------------------------------------------ 增量扫描与自适应 TTL

const NOW = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** One fake corpus record (createdAt omitted → never freezes). */
function record(id: string, createdAt?: number): { header: { id: SessionId; createdAt?: number } } {
  return { header: { id: id as never, ...(createdAt !== undefined ? { createdAt } : {}) } }
}

/** Fake session-query that records which sessions were actually read. */
function fakeQuery(
  records: ReturnType<typeof record>[],
  eventsById: Record<string, SessionEvent[] | 'corrupt'>,
  reads: string[],
): SessionQueryLike {
  return {
    listSessions: async () => records,
    readSession: async (id) => {
      reads.push(String(id))
      const events = eventsById[String(id)]
      if (events === 'corrupt') throw new Error('corrupt')
      return { events: events ?? [] }
    },
  }
}

/** Let the background scan's promise chain settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('frozen-bucket incremental scans', () => {
  it('skips frozen sessions and merges checkpoint totals with the recent window', async () => {
    const reads: string[] = []
    const query = fakeQuery(
      [record('frozen-skill', NOW - 30 * DAY), record('fresh', NOW - 1 * DAY)],
      {
        'frozen-skill': [invocationEvent('oldskill', 1, NOW - 20 * DAY)],
        fresh: [invocationEvent('tdd', 1), invocationEvent('tdd', 2)],
      },
      reads,
    )
    let checkpoints = 0
    const reader = createSkillStatsReader(query, 60_000, {
      now: () => NOW,
      checkpoint: {
        windowDays: 0,
        frozenBefore: NOW - 10 * DAY,
        frozenSessions: { 'frozen-skill': { createdAt: NOW - 30 * DAY, counts: { oldskill: { count: 5, lastUsed: NOW - 20 * DAY } } } },
        lastFullReconcile: NOW - 3_600_000, // 1h ago → incremental path
      },
      onCheckpoint: () => { checkpoints += 1 },
    })
    expect(await reader()).toEqual([]) // 首次调用不等待扫描
    await flush()
    expect(await reader()).toEqual([
      { name: 'oldskill', count: 5, lastUsed: NOW - 20 * DAY },
      { name: 'tdd', count: 2, lastUsed: 0 },
    ])
    // 冻结会话没有被重读；增量扫描不改检查点 → 不触发持久化回调。
    expect(reads).toEqual(['fresh'])
    expect(checkpoints).toBe(0)
  })

  it('runs a full reconciliation when due: rebuilds the frozen bucket and advances the watermark', async () => {
    const reads: string[] = []
    const query = fakeQuery(
      [record('ancient', NOW - 30 * DAY), record('recent', NOW - 1 * DAY)],
      {
        ancient: [invocationEvent('a', 1, 5)],
        recent: [invocationEvent('b', 1), invocationEvent('b', 2)],
      },
      reads,
    )
    const saved: Array<Record<string, unknown>> = []
    const reader = createSkillStatsReader(query, 60_000, {
      now: () => NOW,
      // lastFullReconcile = 0 → 对账到期（全量路径）
      checkpoint: { windowDays: 0, frozenBefore: 0, frozenSessions: {}, lastFullReconcile: 0 },
      onCheckpoint: (cp) => { saved.push(cp as unknown as Record<string, unknown>) },
    })
    expect(await reader()).toEqual([])
    await flush()
    expect(await reader()).toEqual([
      { name: 'a', count: 1, lastUsed: 5 },
      { name: 'b', count: 2, lastUsed: 0 },
    ])
    expect(reads).toEqual(['ancient', 'recent']) // 全量：两个都读
    expect(saved).toHaveLength(1)
    expect(saved[0]).toEqual({
      windowDays: 0,
      frozenBefore: NOW - STATS_FREEZE_AFTER_MS,
      // 全历史模式（windowDays=0）：冻结会话进缓存且仍计入总数。
      frozenSessions: { ancient: { createdAt: NOW - 30 * DAY, counts: { a: { count: 1, lastUsed: 5 } } } },
      lastFullReconcile: NOW,
    })
  })

  it('re-reads sessions without createdAt on incremental scans (never freezes)', async () => {
    const reads: string[] = []
    const query = fakeQuery(
      [record('no-stamp'), record('fresh', NOW - 1 * DAY)],
      { 'no-stamp': [invocationEvent('x', 1)], fresh: [invocationEvent('y', 1)] },
      reads,
    )
    const reader = createSkillStatsReader(query, 60_000, {
      now: () => NOW,
      checkpoint: {
        windowDays: 0,
        frozenBefore: NOW - 10 * DAY,
        frozenSessions: {},
        lastFullReconcile: NOW - 3_600_000,
      },
    })
    expect(await reader()).toEqual([])
    await flush()
    expect(await reader().then((s) => s.map((stat) => stat.name))).toEqual(['x', 'y'])
    expect(reads).toEqual(['no-stamp', 'fresh'])
  })

  it('skips unreadable recent sessions on incremental scans without failing', async () => {
    const reads: string[] = []
    const query = fakeQuery(
      [record('bad', NOW - 2 * DAY), record('good', NOW - 1 * DAY)],
      { bad: 'corrupt', good: [invocationEvent('tdd', 1)] },
      reads,
    )
    const reader = createSkillStatsReader(query, 60_000, {
      now: () => NOW,
      checkpoint: {
        windowDays: 0,
        frozenBefore: NOW - 10 * DAY,
        frozenSessions: { cached: { createdAt: NOW - 30 * DAY, counts: { oldskill: { count: 3, lastUsed: 0 } } } },
        lastFullReconcile: NOW - 3_600_000,
      },
    })
    expect(await reader()).toEqual([])
    await flush()
    expect(await reader()).toEqual([
      { name: 'oldskill', count: 3, lastUsed: 0 },
      { name: 'tdd', count: 1, lastUsed: 0 },
    ])
  })
})

describe('adaptive rescan TTL', () => {
  it('extends the effective TTL to three times the measured scan duration', async () => {
    let clock = 0
    let scans = 0
    const query: SessionQueryLike = {
      listSessions: async () => [{ header: { id: 'a' as never } }, { header: { id: 'b' as never } }],
      readSession: async () => {
        clock += 60_000 // 每个会话耗时 60s → 扫描总耗时 120s
        scans += 1
        return { events: [invocationEvent('tdd')] }
      },
    }
    const reader = createSkillStatsReader(query, 300_000, { now: () => clock })
    expect(await reader()).toEqual([])
    await flush() // 扫描完成：cachedAt=120_000，lastScanDuration=120s
    expect(scans).toBe(2)

    // 自适应 TTL = max(300s, 3×120s) = 360s。固定 TTL 在 310s 时就该重扫了，
    // 这里必须仍然命中缓存 —— 证明自适应生效。
    clock += 310_000
    await reader()
    expect(scans).toBe(2)

    clock += 60_000 // 距上次缓存 370s ≥ 360s → 触发后台重扫
    await reader()
    await flush()
    expect(scans).toBe(4)
  })
})

describe('rolling stats window (configurable days)', () => {
  it('counts only sessions inside the window when windowDays > 0', async () => {
    const reads: string[] = []
    const query = fakeQuery(
      [record('old', NOW - 10 * DAY), record('fresh', NOW - 1 * DAY)],
      {
        old: [invocationEvent('oldskill', 1)],
        fresh: [invocationEvent('tdd', 1)],
      },
      reads,
    )
    const reader = createSkillStatsReader(query, 60_000, {
      now: () => NOW,
      windowDays: () => 7, // 只统计最近 7 天
    })
    expect(await reader()).toEqual([])
    await flush()
    // 10 天前的会话超出窗口：不计入，也不进缓存。
    expect(await reader()).toEqual([{ name: 'tdd', count: 1, lastUsed: 0 }])
  })

  it('keeps full history when the window is 0 (default)', async () => {
    const query = fakeQuery(
      [record('old', NOW - 400 * DAY), record('fresh', NOW - 1 * DAY)],
      {
        old: [invocationEvent('oldskill', 1)],
        fresh: [invocationEvent('tdd', 1)],
      },
      [],
    )
    const reader = createSkillStatsReader(query, 60_000, { now: () => NOW })
    expect(await reader()).toEqual([])
    await flush()
    expect(await reader().then((s) => s.map((stat) => stat.name))).toEqual(['oldskill', 'tdd'])
  })

  it('forces a full reconciliation when the configured window changes', async () => {
    let window = 0
    const reads: string[] = []
    const query = fakeQuery(
      [record('ancient', NOW - 30 * DAY), record('mid', NOW - 20 * DAY), record('fresh', NOW - 1 * DAY)],
      {
        ancient: [invocationEvent('a', 1)],
        mid: [invocationEvent('b', 1)],
        fresh: [invocationEvent('c', 1)],
      },
      reads,
    )
    let clock = NOW
    const reader = createSkillStatsReader(query, 3_600_000, {
      now: () => clock,
      windowDays: () => window,
      checkpoint: { windowDays: 0, frozenBefore: NOW - STATS_FREEZE_AFTER_MS, frozenSessions: {}, lastFullReconcile: NOW - 1000 },
    })
    // 全历史首轮：增量水位（NOW-14d）之后的只有 fresh；mid/ancient 被冻结跳过。
    expect(await reader()).toEqual([])
    await flush()
    expect(await reader()).toEqual([{ name: 'c', count: 1, lastUsed: 0 }])
    const afterFirst = reads.length

    // 窗口切到 7 天：检查点记录的 windowDays 不一致 → 强制全量对账，
    // 老会话也会被重读一次，随后合计只含窗内的 c。（推进时钟使 TTL 过期）
    window = 7
    clock += 2 * 3_600_000
    expect(await reader()).toEqual([{ name: 'c', count: 1, lastUsed: 0 }]) // 先回 stale 缓存并触发重扫
    await flush()
    await reader()
    expect(reads.length).toBeGreaterThan(afterFirst)
    const names = (await reader()).map((stat) => stat.name)
    expect(names).not.toContain('a')
    expect(names).not.toContain('b')
    expect(names).toContain('c')
  })

  it('filters and prunes over-window cache entries on incremental reads', async () => {
    // 防御行为：检查点里残留了超出当前窗口的缓存条目时（例如窗口曾收窄），
    // 增量读取直接把它过滤掉并顺手清除，而不是计入总数。
    const query = fakeQuery([], {}, [])
    const checkpoint = {
      windowDays: 7,
      frozenBefore: NOW - 7 * DAY,
      frozenSessions: {
        'stale-entry': { createdAt: NOW - 10 * DAY, counts: { oldskill: { count: 9, lastUsed: NOW - 10 * DAY } } },
      },
      lastFullReconcile: NOW - 1000, // 对账未到期 → 增量路径
    }
    const reader = createSkillStatsReader(query, 3_600_000, { now: () => NOW, checkpoint, windowDays: () => 7 })
    expect(await reader()).toEqual([])
    await flush()
    const stats = await reader()
    expect(stats).toEqual([])
    expect(checkpoint.frozenSessions['stale-entry']).toBeUndefined() // 已被懒清理
  })
})
