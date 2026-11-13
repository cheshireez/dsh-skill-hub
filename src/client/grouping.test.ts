import { describe, expect, it } from 'vitest'
import type { CatalogSkill, CollectionGroup, SkillTag } from '../protocol.ts'
import { conflictsOnClose, countInstalled, filterBySource, filterSkillsByQuery, filterSkillsByStatus, formatRelativeTime, groupByLocation, groupNamesOf, groupSwitchView, PRIVATE_SOURCE, roleActivationPlan, rolePausableSkills, roleRestorePlan, sortSkills, takeRoleSnapshot, visibleCollections } from './grouping.ts'

function skill(name: string, writable = true): CatalogSkill {
  return {
    name,
    description: '',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'filesystem',
    source: 'user-dsh',
    writable,
  }
}

const names = (skills: readonly CatalogSkill[]): string[] => skills.map((s) => s.name)

describe('filterSkillsByQuery', () => {
  const rows: CatalogSkill[] = [
    { ...skill('alpha'), description: 'PDF toolkit', displayName: 'Alpha Pro', shortDescription: 'pdf helper' },
    { ...skill('beta'), description: 'spreadsheet', invocation: { modelInvocable: false, userInvocable: true } },
    { ...skill('gamma'), description: 'slides', invocation: { modelInvocable: true, userInvocable: false } },
  ]

  it('matches name, description, display name and short description', () => {
    expect(names(filterSkillsByQuery(rows, 'alph', 'all'))).toEqual(['alpha'])
    expect(names(filterSkillsByQuery(rows, 'PDF', 'all'))).toEqual(['alpha'])
    expect(names(filterSkillsByQuery(rows, 'sheet', 'all'))).toEqual(['beta'])
  })

  it('trims the query and keeps every row when it is blank', () => {
    expect(names(filterSkillsByQuery(rows, '  beta  ', 'all'))).toEqual(['beta'])
    expect(filterSkillsByQuery(rows, '   ', 'all')).toHaveLength(3)
  })

  it('applies the invocation filter before the query', () => {
    expect(names(filterSkillsByQuery(rows, '', 'model'))).toEqual(['alpha', 'gamma'])
    expect(names(filterSkillsByQuery(rows, '', 'user'))).toEqual(['alpha', 'beta'])
    expect(names(filterSkillsByQuery(rows, 'beta', 'model'))).toEqual([])
  })
})

describe('filterSkillsByStatus', () => {
  const rows: CatalogSkill[] = [
    { ...skill('on'), toggleable: true },
    { ...skill('off'), toggleable: true, modelOverride: true },
    // An override without switch ability is malformed state; the disabled view
    // only lists rows the hub can actually switch back on.
    { ...skill('stuck'), toggleable: false, modelOverride: true },
  ]

  it('all keeps every row', () => {
    expect(names(filterSkillsByStatus(rows, 'all'))).toEqual(['on', 'off', 'stuck'])
  })

  it('enabled drops rows carrying an override', () => {
    expect(names(filterSkillsByStatus(rows, 'enabled'))).toEqual(['on'])
  })

  it('disabled keeps switchable override rows only', () => {
    expect(names(filterSkillsByStatus(rows, 'disabled'))).toEqual(['off'])
  })
})

describe('groupByLocation', () => {
  const rows: CatalogSkill[] = [
    { ...skill('a'), source: 'agent-codex' },
    { ...skill('b'), source: 'user-dsh' },
    { ...skill('c'), source: 'user-dsh' },
    { ...skill('d'), source: 'agent-ccswitch' },
    { ...skill('p'), source: 'project-dsh', workspace: '/tmp/ws' },
  ]

  it('buckets by discovery root, local roots first, and skips project skills', () => {
    const groups = groupByLocation(rows)
    expect(groups.map((group) => group.id)).toEqual(['user-dsh', 'agent-ccswitch', 'agent-codex'])
    expect(groups[0].skills.map((s) => s.name)).toEqual(['b', 'c'])
    expect(groups.flatMap((group) => group.skills.map((s) => s.name))).not.toContain('p')
  })

  it('returns nothing when every skill is project-level', () => {
    expect(groupByLocation([{ ...skill('p'), source: 'project-agents' }])).toEqual([])
  })
})

describe('groupSwitchView', () => {
  it('is on when every member is enabled, off when none, mixed otherwise', () => {
    const enabled = new Set(['a', 'b', 'c'])
    expect(groupSwitchView(['a', 'b', 'c'], enabled).state).toBe('on')
    expect(groupSwitchView(['a'], new Set()).state).toBe('off')
    expect(groupSwitchView(['a', 'b'], new Set(['a'])).state).toBe('mixed')
  })

  it('lists the enabled and disabled sides', () => {
    const view = groupSwitchView(['a', 'b', 'c'], new Set(['a', 'c']))
    expect(view.enabled).toEqual(['a', 'c'])
    expect(view.disabled).toEqual(['b'])
  })
})

describe('conflictsOnClose', () => {
  it('flags enabled members that live in another group', () => {
    const members = ['a', 'b', 'c']
    const enabled = new Set(['a', 'b'])
    const others = [{ members: ['c', 'a'] }, { members: ['x'] }]
    expect(conflictsOnClose(members, enabled, others)).toEqual(['a'])
  })

  it('ignores disabled members and groups without the member', () => {
    const members = ['a', 'b']
    const enabled = new Set(['b'])
    const others = [{ members: ['a'] }]
    expect(conflictsOnClose(members, enabled, others)).toEqual([])
  })
})

describe('groupNamesOf', () => {
  it('collects tag and collection names for a skill', () => {
    const tags: SkillTag[] = [{ id: '1', name: 'web', skillNames: ['a'] }]
    const collections = [{ name: 'repo/x', skillNames: ['a', 'b'] }, { name: 'repo/y', skillNames: ['b'] }]
    expect(groupNamesOf('a', tags, collections)).toEqual(['web', 'repo/x'])
    expect(groupNamesOf('b', tags, collections)).toEqual(['repo/x', 'repo/y'])
    expect(groupNamesOf('c', tags, collections)).toEqual([])
  })
})

describe('filterBySource', () => {
  it('filters by origin repo, buckets untracked skills as private, and returns all for "all"', () => {
    const origins = { a: 'repo/x', b: 'repo/y' }
    const skills = [skill('a'), skill('b'), skill('c')]
    expect(filterBySource(skills, 'repo/x', origins).map((s) => s.name)).toEqual(['a'])
    expect(filterBySource(skills, PRIVATE_SOURCE, origins).map((s) => s.name)).toEqual(['c'])
    expect(filterBySource(skills, 'all', origins)).toHaveLength(3)
  })

  it('never buckets project skills as private (they belong to the project tree)', () => {
    const origins = {}
    const proj = skill('proj')
    proj.source = 'project-dsh'
    const projAgents = skill('proj-agents')
    projAgents.source = 'project-agents'
    const skills = [skill('personal'), proj, projAgents]
    expect(filterBySource(skills, PRIVATE_SOURCE, origins).map((s) => s.name)).toEqual(['personal'])
    expect(filterBySource(skills, 'all', origins)).toHaveLength(3)
  })
})

describe('visibleCollections', () => {
  const collections: CollectionGroup[] = [
    { name: 'repo/x', skillNames: ['enabled-one', 'paused-one'] },
    { name: 'repo/ghost', skillNames: ['gone'] },
  ]

  it('keeps collections with visible members and drops empty shells', () => {
    const visible = visibleCollections(collections, [skill('enabled-one')])
    expect(visible.map((entry) => entry.collection.name)).toEqual(['repo/x'])
    expect(visible[0].skills.map((s) => s.name)).toEqual(['enabled-one'])
  })

  it('includes paused skills because they stay in the skills list', () => {
    const paused = { ...skill('paused-one'), modelOverride: true }
    const visible = visibleCollections(collections, [paused])
    expect(visible.map((entry) => entry.collection.name)).toEqual(['repo/x'])
    expect(visible[0].skills[0]?.modelOverride).toBe(true)
  })

  it('drops every collection when no member is visible', () => {
    expect(visibleCollections(collections, [])).toEqual([])
  })
})

describe('sortSkills', () => {
  it('sorts by name ascending', () => {
    const skills = [skill('zeta'), skill('alpha'), skill('beta')]
    expect(sortSkills(skills, 'name').map((s) => s.name)).toEqual(['alpha', 'beta', 'zeta'])
  })

  it('sorts by added time descending, unknown times last', () => {
    const skills = [
      { ...skill('old'), addedAt: 100 },
      { ...skill('new'), addedAt: 300 },
      { ...skill('unknown') },
    ]
    expect(sortSkills(skills, 'added').map((s) => s.name)).toEqual(['new', 'old', 'unknown'])
  })

  it('sorts by invocation count descending, unknown counts as zero', () => {
    const skills = [skill('few'), skill('many'), skill('none')]
    const uses: Record<string, number | undefined> = { few: 2, many: 9 }
    expect(sortSkills(skills, 'uses', (name) => uses[name]).map((s) => s.name)).toEqual(['many', 'few', 'none'])
  })

  it('does not mutate the input list', () => {
    const skills = [skill('b'), skill('a')]
    const sorted = sortSkills(skills, 'name')
    expect(sorted.map((s) => s.name)).toEqual(['a', 'b'])
    expect(skills.map((s) => s.name)).toEqual(['b', 'a'])
  })
})

describe('role activation', () => {
  const paused = (name: string): CatalogSkill => ({ ...skill(name), modelOverride: true })
  const project = (name: string): CatalogSkill => ({ ...skill(name), source: 'project-dsh' })
  const actions = (...names: string[]): ReadonlySet<string> => new Set(names)

  it('enables paused members and pauses every other switchable skill', () => {
    const skills = [skill('a'), paused('b'), skill('c'), paused('d')]
    const plan = roleActivationPlan(['a', 'b'], skills, actions('a', 'b', 'c', 'd'))
    expect(plan.toEnable).toEqual(['b'])
    expect(plan.toDisable).toEqual(['c'])
  })

  it('is idempotent once the role is the only active set', () => {
    const skills = [skill('a'), skill('b'), paused('c')]
    expect(roleActivationPlan(['a', 'b'], skills, actions('a', 'b', 'c'))).toEqual({ toEnable: [], toDisable: [] })
  })

  it('never touches project skills or rows the hub cannot toggle', () => {
    const skills = [skill('a'), project('p'), skill('readonly')]
    const plan = roleActivationPlan(['a'], skills, actions('a', 'p'))
    expect(plan.toDisable).toEqual([])
    expect(roleActivationPlan([], skills, actions('a')).toDisable).toEqual(['a'])
  })

  it('lists exactly the skills an activation would pause', () => {
    const skills = [skill('member'), paused('already-off'), skill('spare'), project('p')]
    expect(rolePausableSkills(['member'], skills, actions('member', 'already-off', 'spare', 'p'))).toEqual(['spare'])
  })

  it('spares the skills the user kept, members still switch on', () => {
    const skills = [paused('member'), skill('keep'), skill('pause')]
    const plan = roleActivationPlan(['member'], skills, actions('member', 'keep', 'pause'), new Set(['keep']))
    expect(plan.toEnable).toEqual(['member'])
    expect(plan.toDisable).toEqual(['pause'])
    // Keeping a member changes nothing: members are always on.
    expect(roleActivationPlan(['member'], skills, actions('member', 'keep', 'pause'), new Set(['member'])).toEnable).toEqual(['member'])
  })

  it('sparing every pausable skill leaves the role switch with enables only', () => {
    const skills = [paused('m'), skill('x'), skill('y')]
    const pausable = rolePausableSkills(['m'], skills, actions('m', 'x', 'y'))
    const plan = roleActivationPlan(['m'], skills, actions('m', 'x', 'y'), new Set(pausable))
    expect(plan).toEqual({ toEnable: ['m'], toDisable: [] })
  })

  it('restores the pre-activation layout from a snapshot', () => {
    const before = [skill('a'), paused('b'), skill('c')]
    const snapshot = takeRoleSnapshot('r1', 'Review', before, actions('a', 'b', 'c'))
    const after = [paused('a'), skill('b'), paused('c')]
    const plan = roleRestorePlan(snapshot, after, actions('a', 'b', 'c'))
    expect(plan.toEnable).toEqual(['a', 'c'])
    expect(plan.toDisable).toEqual(['b'])
  })

  it('leaves skills installed after the snapshot untouched', () => {
    const snapshot = takeRoleSnapshot('r1', 'Review', [skill('a')], actions('a'))
    expect(roleRestorePlan(snapshot, [paused('a'), skill('new')], actions('a', 'new'))).toEqual({ toEnable: ['a'], toDisable: [] })
  })
})

describe('formatRelativeTime', () => {
  const now = 1_700_000_000_000
  it('buckets relative times correctly', () => {
    expect(formatRelativeTime(now, now)).toEqual({ key: 'time.justNow' })
    expect(formatRelativeTime(now - 30_000, now)).toEqual({ key: 'time.justNow' })
    expect(formatRelativeTime(now - 5 * 60_000, now)).toEqual({ key: 'time.minutesAgo', value: 5 })
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toEqual({ key: 'time.hoursAgo', value: 3 })
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toEqual({ key: 'time.daysAgo', value: 2 })
    expect(formatRelativeTime(now - 14 * 86_400_000, now)).toEqual({ key: 'time.weeksAgo', value: 2 })
  })

  it('clamps future timestamps to just now', () => {
    expect(formatRelativeTime(now + 5_000, now)).toEqual({ key: 'time.justNow' })
  })
})

describe('countInstalled', () => {
  const record = { skills: ['one', 'two', 'gone'] }

  it('counts only names that still exist in the catalog', () => {
    expect(countInstalled(record, new Set(['one', 'two']), true)).toBe(2)
  })

  it('reports 0 when every recorded name is an orphan', () => {
    expect(countInstalled(record, new Set(), true)).toBe(0)
  })

  it('falls back to the recorded length before the catalog has loaded', () => {
    // 冷启动那一瞬间 catalog 还是 null，不能把「已装 3 个」闪成 0。
    expect(countInstalled(record, new Set(), false)).toBe(3)
  })

  it('reports 0 for a repo with no source record', () => {
    expect(countInstalled(undefined, new Set(['one']), true)).toBe(0)
  })
})
