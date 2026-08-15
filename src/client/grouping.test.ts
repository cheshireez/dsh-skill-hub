import { describe, expect, it } from 'vitest'
import type { CatalogSkill, SkillTag } from '../protocol.ts'
import { conflictsOnClose, filterBySource, formatRelativeTime, groupNamesOf, groupSwitchView, uncategorizedSkills } from './grouping.ts'

function skill(name: string, source = 'user-dsh', writable = true): CatalogSkill {
  return {
    name,
    description: '',
    invocation: { modelInvocable: true, userInvocable: true },
    source,
    provider: 'filesystem',
    writable,
  }
}

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

describe('uncategorizedSkills', () => {
  it('excludes skills in any tag or origin', () => {
    const skills = [skill('tagged'), skill('origin'), skill('free')]
    const tags: SkillTag[] = [{ id: '1', name: 't', skillNames: ['tagged'] }]
    const origins = { origin: 'superpowers' }
    expect(uncategorizedSkills(skills, tags, origins).map((s) => s.name)).toEqual(['free'])
  })
})

describe('filterBySource', () => {
  it('filters by source and returns all for "all"', () => {
    const skills = [skill('a', 'user-dsh'), skill('b', 'bundled')]
    expect(filterBySource(skills, 'user-dsh').map((s) => s.name)).toEqual(['a'])
    expect(filterBySource(skills, 'all')).toHaveLength(2)
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
