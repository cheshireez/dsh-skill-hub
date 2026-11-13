// @vitest-environment jsdom
/**
 * useCatalogFlow 回归测试。三块：
 *
 * 1. 纯函数 `flipSkillEnabled` / `rollbackSkillToSnapshot` —— 决定「点开关后
 *    UI 立刻变、失败再弹回」的正确性。
 * 2. hook 的重渲染命门：5 秒轮询返回的 catalog 与上次逐字节相同时必须
 *    **不提交 state**，否则整条派生链（搜索/状态过滤/排序）和每一行 React
 *    组件都会重跑，即使一个技能都没变。
 * 3. `toggle` 的引用必须跨 catalog 更新保持稳定，否则 `SkillRow` 的 memo
 *    每次轮询都失效（优化等于没做）。
 *
 * 另外钉住两条既有行为：慢的旧轮询不得覆盖新结果、toggle 失败只回滚目标行。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { CatalogResponse, CatalogSkill } from '../../../protocol.ts'
import type { SkillHubApi } from '../../api.ts'
import { flipSkillEnabled, rollbackSkillToSnapshot, useCatalogFlow } from './useCatalogFlow.ts'
import type { FlowNotices } from './shared.ts'

// React's act() requires this flag in a non-testing-library environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function skill(name: string, overrides: Partial<CatalogSkill> = {}): CatalogSkill {
  return {
    name,
    description: name + ' description',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'filesystem',
    writable: true,
    source: 'user-dsh',
    ...overrides,
  }
}

function catalog(skills: CatalogSkill[] = [skill('alpha')], overrides: Partial<CatalogResponse> = {}): CatalogResponse {
  return {
    ok: true,
    pluginVersion: '0.3.32',
    complete: true,
    skills,
    disabled: [],
    diagnostics: [],
    announcement: { skills: skills.length, chars: 10, approxTokens: 4, budget: 8000, overBudget: false },
    ...overrides,
  }
}

function notices(): FlowNotices {
  return { fail: vi.fn(), clearFail: vi.fn(), succeed: vi.fn(), setTagBusy: vi.fn(), setBatchBusy: vi.fn() }
}

function mockApi() {
  return {
    catalog: vi.fn<() => Promise<CatalogResponse>>(async () => catalog()),
    toggle: vi.fn<() => Promise<CatalogResponse>>(async () => catalog()),
    toggleBatch: vi.fn(async () => ({ catalog: catalog(), failures: [] as Array<{ name: string; error: string }> })),
    skill: vi.fn(),
    fixDiagnostic: vi.fn(),
    create: vi.fn(),
  }
}

type Harness = { current: ReturnType<typeof useCatalogFlow> }

/** 最小 renderHook：不引 @testing-library，和 icons.test.tsx 保持同一套手工 DOM。 */
function renderFlow(api: ReturnType<typeof mockApi>, flowNotices = notices()): {
  result: Harness
  renders: () => number
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const result: Harness = { current: undefined as unknown as ReturnType<typeof useCatalogFlow> }
  // 与真实调用点一致：`uses` / `collapsePersonal` / `clearSourceFilter` 在
  // 生产里都是稳定引用（state 或 useCallback）。这里若每次渲染新建，会掩盖
  // `load` / `toggle` 的依赖泄漏。
  const uses = new Map<string, { count: number; lastUsed?: number }>()
  const noop = (): void => {}
  let count = 0
  function Probe(): null {
    count += 1
    result.current = useCatalogFlow(api as unknown as SkillHubApi, uses, flowNotices, noop, noop)
    return null
  }
  act(() => { root.render(<Probe />) })
  return {
    result,
    renders: () => count,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe('flipSkillEnabled', () => {
  it('关闭：给目标行加上 modelOverride，其它行保持不变', () => {
    const before = catalog([skill('a'), skill('b')])
    const after = flipSkillEnabled(before, 'a', false)
    expect(after?.skills.find((entry) => entry.name === 'a')?.modelOverride).toBe(true)
    expect(after?.skills.find((entry) => entry.name === 'b')?.modelOverride).toBeUndefined()
    // 不可变：原对象没被改
    expect(before.skills[0].modelOverride).toBeUndefined()
  })

  it('打开：删掉目标行的 modelOverride', () => {
    const before = catalog([skill('a', { modelOverride: true })])
    const after = flipSkillEnabled(before, 'a', true)
    expect(after?.skills[0].modelOverride).toBeUndefined()
  })

  it('找不到该技能或 catalog 为 null 时原样返回', () => {
    const before = catalog([skill('a')])
    expect(flipSkillEnabled(before, 'zzz', false)).toBe(before)
    expect(flipSkillEnabled(null, 'a', false)).toBeNull()
  })
})

describe('rollbackSkillToSnapshot', () => {
  it('只把目标行恢复成快照，其它行保留当前值', () => {
    const snapshot = catalog([skill('a'), skill('b')])
    // 请求期间 b 被别的操作改了：当前 b 有 override
    const current = catalog([skill('a', { modelOverride: true }), skill('b', { modelOverride: true })])
    const restored = rollbackSkillToSnapshot(current, snapshot, 'a')
    expect(restored.skills.find((entry) => entry.name === 'a')?.modelOverride).toBeUndefined()
    expect(restored.skills.find((entry) => entry.name === 'b')?.modelOverride).toBe(true)
  })
})

describe('useCatalogFlow', () => {
  let harness: ReturnType<typeof renderFlow> | undefined

  afterEach(() => {
    harness?.unmount()
    harness = undefined
  })

  it('does not commit state when a poll returns the same catalog', async () => {
    const api = mockApi()
    harness = renderFlow(api)
    await act(async () => { await harness!.result.current.load() })
    const afterFirstLoad = harness.renders()

    // 逐字节相同的响应：再提交一次会让整条派生链和每一行重渲染。
    await act(async () => { await harness!.result.current.load() })
    expect(harness.renders()).toBe(afterFirstLoad)
  })

  it('commits state when the catalog really changed', async () => {
    const api = mockApi()
    harness = renderFlow(api)
    await act(async () => { await harness!.result.current.load() })
    const afterFirstLoad = harness.renders()

    ;(api.catalog as Mock).mockResolvedValueOnce(catalog([skill('alpha'), skill('beta')]))
    await act(async () => { await harness!.result.current.load() })
    expect(harness.renders()).toBeGreaterThan(afterFirstLoad)
    expect(harness.result.current.catalog?.skills.map((entry) => entry.name)).toEqual(['alpha', 'beta'])
  })

  it('keeps the toggle callback referentially stable across catalog updates', async () => {
    const api = mockApi()
    harness = renderFlow(api)
    await act(async () => { await harness!.result.current.load() })
    const before = harness.result.current.toggle

    ;(api.catalog as Mock).mockResolvedValueOnce(catalog([skill('alpha'), skill('beta')]))
    await act(async () => { await harness!.result.current.load() })

    // 引用一变，SkillRow 的 memo 就整列表失效 —— 这是行级 memo 的前提。
    expect(harness.result.current.toggle).toBe(before)
  })

  it('ignores a slow older poll that resolves after a newer one', async () => {
    const api = mockApi()
    let resolveFirst!: (value: CatalogResponse) => void
    const first = new Promise<CatalogResponse>((resolve) => { resolveFirst = resolve })
    ;(api.catalog as Mock).mockReturnValueOnce(first).mockResolvedValueOnce(catalog([skill('newer')]))

    harness = renderFlow(api)
    let slow: Promise<void> | undefined
    act(() => { slow = harness!.result.current.load() })
    await act(async () => { await harness!.result.current.load() })
    await act(async () => { resolveFirst(catalog([skill('older')])); await slow })

    expect(harness.result.current.catalog?.skills.map((entry) => entry.name)).toEqual(['newer'])
  })

  it('rolls back only the target row when a toggle fails', async () => {
    const api = mockApi()
    ;(api.catalog as Mock).mockResolvedValue(catalog([skill('alpha'), skill('beta')]))
    const flowNotices = notices()
    harness = renderFlow(api, flowNotices)
    await act(async () => { await harness!.result.current.load() })

    ;(api.toggle as Mock).mockRejectedValueOnce(new Error('boom'))
    const alpha = harness.result.current.catalog!.skills[0]
    await act(async () => { await harness!.result.current.toggle(alpha, false) })

    // 乐观更新被回滚，另一行原样保留，错误如实上报。
    expect(harness.result.current.catalog!.skills[0].modelOverride).toBeUndefined()
    expect(harness.result.current.catalog!.skills[1].modelOverride).toBeUndefined()
    expect(flowNotices.fail).toHaveBeenCalledWith('boom')
  })

  it('treats the disabled ledger as display-only, never as a second source of paused rows', async () => {
    const api = mockApi()
    // 台账里有一条 alpha，但 provider 没给 alpha 打 modelOverride（真值不在台账里）。
    ;(api.catalog as Mock).mockResolvedValue(catalog([skill('alpha')], {
      disabled: [{ name: 'alpha', description: 'ledger only', path: '/p/alpha/SKILL.md', root: 'user-dsh', disabledAt: 1 }],
    }))
    harness = renderFlow(api)
    await act(async () => { await harness!.result.current.load() })

    // 「停用」视图必须为空：判定只看 modelOverride，台账不能凭空造出一行。
    act(() => { harness!.result.current.setStatusFilter('disabled') })
    expect(harness.result.current.filtered).toEqual([])
    act(() => { harness!.result.current.setStatusFilter('enabled') })
    expect(harness.result.current.filtered.map((entry) => entry.name)).toEqual(['alpha'])
  })

  it('applies the optimistic update while the toggle is in flight', async () => {
    const api = mockApi()
    ;(api.catalog as Mock).mockResolvedValue(catalog([skill('alpha')]))
    harness = renderFlow(api)
    await act(async () => { await harness!.result.current.load() })

    let settle!: (value: CatalogResponse) => void
    ;(api.toggle as Mock).mockReturnValueOnce(new Promise<CatalogResponse>((resolve) => { settle = resolve }))
    const alpha = harness.result.current.catalog!.skills[0]
    let pending: Promise<void> | undefined
    act(() => { pending = harness!.result.current.toggle(alpha, false) })

    // 请求还没回来，界面必须已经切到停用态（否则 5 秒轮询期间点开关像没反应）。
    expect(harness.result.current.catalog!.skills[0].modelOverride).toBe(true)
    expect(harness.result.current.busyNames.has('alpha')).toBe(true)

    await act(async () => { settle(catalog([skill('alpha', { modelOverride: true })])); await pending })
    expect(harness.result.current.busyNames.has('alpha')).toBe(false)
  })
})
