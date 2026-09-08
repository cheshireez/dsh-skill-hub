import { describe, expect, it } from 'vitest'
import { asPersistenceSeam, countSkillInvocations, createSkillStatsReader, readColdSkillStats, readSkillStats, STATS_FREEZE_AFTER_MS, type SessionPersistenceLike, type SessionQueryLike } from './stats.ts'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SkillStatsCheckpoint } from './protocol.ts'

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
      // 有时间戳的近期会话：增量扫描会重读，正好验证“过期触发且只刷一次”。
      // （无时间戳会话首轮进冻结桶后不再重读，见下文增量测试。）
      listSessions: async () => [{ header: { id: 'a' as never, createdAt: Date.now() } }],
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

describe('scan read concurrency', () => {
  it('reads session logs sequentially (peak 1) to bound host restore memory', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => 's' + i)
    let inFlight = 0
    let peak = 0
    const query: SessionQueryLike = {
      listSessions: async () => ids.map((id) => record(id)),
      readSession: async (id) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { events: [invocationEvent(String(id))] }
      },
    }
    // No checkpoint → full path, all 8 sessions read, one at a time: a heavy
    // corpus costs wall time (issue #7), never a memory spike.
    const stats = await readSkillStats(query)
    expect(stats).toHaveLength(8)
    expect(peak).toBe(1)
  })
})

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
    expect(await reader()).toEqual([]) // 首次调用不等待扫描（无上次总数可端）
    await flush()
    expect(await reader()).toEqual([
      { name: 'oldskill', count: 5, lastUsed: NOW - 20 * DAY },
      { name: 'tdd', count: 2, lastUsed: 0 },
    ])
    // 冻结会话没有被重读；增量扫描也落盘（含新总数）→ 回调恰好一次。
    expect(reads).toEqual(['fresh'])
    expect(checkpoints).toBe(1)
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
      lastTotals: [
        { name: 'a', count: 1, lastUsed: 5 },
        { name: 'b', count: 2, lastUsed: 0 },
      ],
    })
  })

  it('serves persisted lastTotals instantly on cold start, then merges the rescan', async () => {
    const reads: string[] = []
    const query = fakeQuery(
      [record('fresh', NOW - 1 * DAY)],
      { fresh: [invocationEvent('tdd', 1)] },
      reads,
    )
    const saved: Array<Record<string, unknown>> = []
    const reader = createSkillStatsReader(query, 60_000, {
      now: () => NOW,
      checkpoint: {
        windowDays: 0,
        frozenBefore: 0,
        frozenSessions: {},
        lastFullReconcile: NOW, // 对账刚做过 → 增量路径
        lastTotals: [{ name: 'oldskill', count: 9, lastUsed: 7 }],
      },
      onCheckpoint: (cp) => { saved.push(cp as unknown as Record<string, unknown>) },
    })
    // 冷启动直接端上次总数，同时后台重扫；重扫后以新鲜值为准（旧数不复活）。
    expect(await reader()).toEqual([{ name: 'oldskill', count: 9, lastUsed: 7 }])
    await flush()
    expect(await reader()).toEqual([{ name: 'tdd', count: 1, lastUsed: 0 }])
    expect(reads).toEqual(['fresh'])
    expect(saved).toHaveLength(1)
    expect((saved[0] as { lastTotals: unknown }).lastTotals).toEqual([{ name: 'tdd', count: 1, lastUsed: 0 }])
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

  it('keeps sessions without createdAt in the frozen bucket after the first read', async () => {
    // 无时间戳会话按时间永远冻不住：首轮全量读到调用就进缓存，
    // 增量扫描不再重读（issue #7：否则每轮都重读）。
    const reads: string[] = []
    const query = fakeQuery(
      [record('no-stamp'), record('fresh', NOW - 1 * DAY)],
      { 'no-stamp': [invocationEvent('x', 1)], fresh: [invocationEvent('y', 1)] },
      reads,
    )
    let clock = NOW
    const checkpoint: SkillStatsCheckpoint = { windowDays: 0, frozenBefore: 0, frozenSessions: {}, lastFullReconcile: 0 }
    const reader = createSkillStatsReader(query, 60_000, { now: () => clock, checkpoint })
    expect(await reader()).toEqual([])
    await flush()
    expect(reads).toEqual(['no-stamp', 'fresh']) // 首轮全量：两个都读
    expect(checkpoint.frozenSessions['no-stamp']).not.toBeUndefined()
    clock += 120_000 // TTL 过期 → 增量扫描
    await reader()
    await flush()
    expect(reads).toEqual(['no-stamp', 'fresh', 'fresh']) // 只重读 fresh，no-stamp 不再读
  })
})

// ------------------------------------------------ 冷路径（persistence seam）

/** One fake persisted session. */
function coldEntry(id: string, createdAt: number | undefined, rev: string, events: SessionEvent[] | 'corrupt'): { id: string; createdAt: number | undefined; rev: string; events: SessionEvent[] | 'corrupt' } {
  return { id, createdAt, rev, events }
}

/** Fake persistence seam recording opens/closes (handles must always close). */
function fakePersistence(
  entries: ReturnType<typeof coldEntry>[],
  trace: { lists: number; opens: string[]; closes: string[] },
  failList = false,
): SessionPersistenceLike {
  return {
    list: async () => {
      trace.lists += 1
      if (failList) throw new Error('backend down')
      return entries.map((entry) => ({
        header: { id: entry.id as never, ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}) },
        revision: entry.rev,
      }))
    },
    open: async (id) => {
      trace.opens.push(String(id))
      const entry = entries.find((candidate) => candidate.id === String(id))
      if (entry === undefined || entry.events === 'corrupt') throw new Error('unreadable')
      const events = entry.events
      return {
        read: async () => ({ events }),
        close: () => { trace.closes.push(String(id)) },
      }
    },
  }
}

function coldTrace(): { lists: number; opens: string[]; closes: string[] } {
  return { lists: 0, opens: [], closes: [] }
}

describe('readColdSkillStats', () => {
  it('totals invocations across sessions and sorts by name', async () => {
    const trace = coldTrace()
    const persistence = fakePersistence([
      coldEntry('a', NOW - 1 * DAY, 'r1', [invocationEvent('tdd', 1), invocationEvent('tdd', 2)]),
      coldEntry('b', NOW - 2 * DAY, 'r1', [invocationEvent('code-review', 1), skillToolCall('tdd', 2)]),
    ], trace)
    expect(await readColdSkillStats(persistence)).toEqual([
      { name: 'code-review', count: 1, lastUsed: 0 },
      { name: 'tdd', count: 3, lastUsed: 0 },
    ])
    expect(trace.opens).toEqual(['a', 'b'])
    expect(trace.closes).toEqual(['a', 'b']) // 每个 handle 都关闭
  })

  it('never opens out-of-window logs', async () => {
    const trace = coldTrace()
    const persistence = fakePersistence([
      coldEntry('old', NOW - 10 * DAY, 'r1', [invocationEvent('oldskill', 1)]),
      coldEntry('fresh', NOW - 1 * DAY, 'r1', [invocationEvent('tdd', 1)]),
    ], trace)
    const checkpoint = { windowDays: 7, frozenBefore: 0, frozenSessions: {}, lastFullReconcile: 0 }
    const reader = createSkillStatsReader({ listSessions: async () => [], readSession: async () => ({ events: [] }) }, 60_000, {
      now: () => NOW,
      checkpoint,
      windowDays: () => 7,
      persistence,
    })
    expect(await reader()).toEqual([])
    await flush()
    expect(await reader()).toEqual([{ name: 'tdd', count: 1, lastUsed: 0 }])
    expect(trace.opens).toEqual(['fresh']) // old 连开都没开
  })

  it('skips corrupt sessions without failing the scan', async () => {
    const trace = coldTrace()
    const persistence = fakePersistence([
      coldEntry('bad', NOW - 1 * DAY, 'r1', 'corrupt'),
      coldEntry('good', NOW - 1 * DAY, 'r1', [invocationEvent('tdd', 1)]),
    ], trace)
    expect(await readColdSkillStats(persistence)).toEqual([{ name: 'tdd', count: 1, lastUsed: 0 }])
  })

  it('re-reads only sessions whose revision changed', async () => {
    const trace = coldTrace()
    const entries = [
      coldEntry('steady', NOW - 5 * DAY, 'r1', [invocationEvent('tdd', 1)]),
      coldEntry('growing', NOW - 1 * DAY, 'r1', [invocationEvent('tdd', 1)]),
    ]
    const persistence = fakePersistence(entries, trace)
    let clock = NOW
    const query: SessionQueryLike = { listSessions: async () => [], readSession: async () => ({ events: [] }) }
    const checkpoints: Array<Record<string, unknown>> = []
    const reader = createSkillStatsReader(query, 60_000, {
      now: () => clock,
      persistence,
      onCheckpoint: (cp) => { checkpoints.push(cp as unknown as Record<string, unknown>) },
    })
    expect(await reader()).toEqual([])
    await flush()
    expect(await reader()).toEqual([{ name: 'tdd', count: 2, lastUsed: 0 }])
    expect(trace.opens).toEqual(['steady', 'growing'])

    // growing 续写（revision 变化），steady 不变：第二轮只重读 growing。
    entries[1]!.rev = 'r2'
    entries[1]!.events = [invocationEvent('tdd', 1), invocationEvent('tdd', 2)]
    clock += 120_000 // TTL 过期，触发后台重扫
    expect(await reader()).toEqual([{ name: 'tdd', count: 2, lastUsed: 0 }]) // 先回 stale
    await flush()
    expect(await reader()).toEqual([{ name: 'tdd', count: 3, lastUsed: 0 }])
    expect(trace.opens).toEqual(['steady', 'growing', 'growing'])
    // 检查点里记了两个 revision，下次重启不用重读。
    const saved = checkpoints.at(-1)?.['coldRevisions'] as Record<string, { rev: string }>
    expect(saved['steady']?.rev).toBe('r1')
    expect(saved['growing']?.rev).toBe('r2')
  })

  it('reads live sessions through the query seam without double-counting', async () => {
    const trace = coldTrace()
    const persistence = fakePersistence([
      coldEntry('live-one', NOW - 1 * DAY, 'r1', [invocationEvent('persisted-part', 1)]),
      coldEntry('calm', NOW - 2 * DAY, 'r1', [invocationEvent('tdd', 1)]),
    ], trace)
    const query: SessionQueryLike = {
      listSessions: async () => [],
      readSession: async (id) => ({
        // live 会话的内存态比落盘新：全量当前日志（含已落盘部分）。
        events: String(id) === 'live-one'
          ? [invocationEvent('persisted-part', 1), invocationEvent('live-part', 2)]
          : [],
      }),
    }
    const reader = createSkillStatsReader(query, 60_000, {
      now: () => NOW,
      persistence,
      listLiveIds: async () => ['live-one' as never],
      readLiveSession: (id) => query.readSession(id),
    })
    expect(await reader()).toEqual([])
    await flush()
    // live-one 只按 live 读了一次（persisted-part 不翻倍），calm 走 revision 缓存。
    expect(await reader()).toEqual([
      { name: 'live-part', count: 1, lastUsed: 0 },
      { name: 'persisted-part', count: 1, lastUsed: 0 },
      { name: 'tdd', count: 1, lastUsed: 0 },
    ])
    expect(trace.opens).toEqual(['calm'])
  })

  it('keeps previous totals when the listing fails', async () => {
    const trace = coldTrace()
    const persistence = fakePersistence([coldEntry('a', NOW - 1 * DAY, 'r1', [invocationEvent('tdd', 1)])], trace, true)
    const query: SessionQueryLike = { listSessions: async () => [], readSession: async () => ({ events: [] }) }
    const reader = createSkillStatsReader(query, 60_000, {
      now: () => NOW,
      persistence,
      checkpoint: {
        windowDays: 0,
        frozenBefore: 0,
        frozenSessions: {},
        lastFullReconcile: NOW,
        lastTotals: [{ name: 'oldskill', count: 9, lastUsed: 7 }],
      },
    })
    expect(await reader()).toEqual([{ name: 'oldskill', count: 9, lastUsed: 7 }])
    await flush()
    expect(await reader()).toEqual([{ name: 'oldskill', count: 9, lastUsed: 7 }]) // 失败保留旧数
    expect(trace.opens).toEqual([])
  })
})

describe('asPersistenceSeam', () => {
  it('rejects non-service values without I/O', () => {
    expect(asPersistenceSeam(undefined)).toBeUndefined()
    expect(asPersistenceSeam(null)).toBeUndefined()
    expect(asPersistenceSeam({})).toBeUndefined()
    expect(asPersistenceSeam({ list: async () => [] })).toBeUndefined()
    expect(asPersistenceSeam({ open: async () => ({}) })).toBeUndefined()
  })

  it('adapts list/open/read/close with shape validation', async () => {
    const closes: string[] = []
    const seam = asPersistenceSeam({
      list: async () => [{ header: { id: 'a', createdAt: 5 }, revision: 42 }],
      open: async (id: unknown) => ({
        read: async (offset: unknown) => {
          expect(offset).toBe(0)
          return { events: [invocationEvent('tdd', 1)] }
        },
        close: () => { closes.push(String(id)) },
      }),
    })
    expect(seam).not.toBeUndefined()
    const snapshots = await seam!.list()
    expect(snapshots).toEqual([{ header: { id: 'a', createdAt: 5 }, revision: '42' }])
    const handle = await seam!.open('a' as never, 'read')
    expect((await handle.read()).events).toHaveLength(1)
    await handle.close()
    expect(closes).toEqual(['a'])
  })

  it('throws on malformed snapshots, handles, and reads', async () => {
    const badList = asPersistenceSeam({ list: async () => [{ nope: true }], open: async () => ({}) })!
    await expect(badList.list()).rejects.toThrow()
    const badOpen = asPersistenceSeam({ list: async () => [], open: async () => ({}) })!
    await expect(badOpen.open('a' as never, 'read')).rejects.toThrow()
    const badRead = asPersistenceSeam({
      list: async () => [],
      open: async () => ({ read: async () => ({ nope: 1 }), close: () => {} }),
    })!
    await expect((await badRead.open('a' as never, 'read')).read()).rejects.toThrow()
  })
})
