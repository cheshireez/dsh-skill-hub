import { describe, expect, it } from 'vitest'
import type { CatalogSkill, CollectionGroup, SkillTag } from '../protocol.ts'
import { filterBySource, formatRelativeTime, mergeCollections, uncategorizedSkills } from './grouping.ts'

function skill(name: string, source = 'user-dsh', sets?: string[]): CatalogSkill {
  return {
    name,
    description: '',
    invocation: { modelInvocable: true, userInvocable: true },
    source,
    provider: 'filesystem',
    writable: true,
    ...(sets !== undefined ? { sets } : {}),
  }
}

describe('mergeCollections', () => {
  it('merges origin collections and author sets, unioning members', () => {
    const skills = [skill('a', 'user-dsh', ['web', 'frontend']), skill('b', 'user-dsh', ['web'])]
    const collections: CollectionGroup[] = [
      { name: 'web', skillNames: ['b', 'c'] },
      { name: 'superpowers', skillNames: ['d'] },
    ]
    const merged = mergeCollections(skills, collections)
    const web = merged.find((g) => g.name === 'web')
    expect(web?.kind).toBe('both')
    expect(web?.skillNames).toEqual(['a', 'b', 'c'])
    expect(merged.find((g) => g.name === 'superpowers')?.kind).toBe('collection')
    expect(merged.find((g) => g.name === 'superpowers')?.skillNames).toEqual(['d'])
    expect(merged.find((g) => g.name === 'frontend')?.kind).toBe('sets')
    expect(merged.find((g) => g.name === 'frontend')?.skillNames).toEqual(['a'])
    // sorted by name
    expect(merged.map((g) => g.name)).toEqual(['frontend', 'superpowers', 'web'])
  })
})

describe('uncategorizedSkills', () => {
  it('excludes skills in any tag, origin, or sets', () => {
    const skills = [skill('tagged'), skill('origin'), skill('setted', 'user-dsh', ['x']), skill('free')]
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
