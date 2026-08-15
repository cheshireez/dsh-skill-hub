/**
 * Pure grouping helpers for the skill-hub panel (no React/DOM deps, so the
 * merge/classify/filter logic stays unit-testable).
 *
 * The "分类" view unifies three ways a skill can belong to a group:
 *  - user tags (sidecar SkillTag)
 *  - origin collections (sidecar origins → backend-aggregated CollectionGroup)
 *  - author sets (frontmatter `sets` on the skill)
 */

import type { CatalogSkill, CollectionGroup, SkillTag } from '../protocol.ts'

/** One merged collection group shown in the "集合" section. */
export interface UnifiedCollection {
  /** Group name (deduplicated across origin collections and author sets). */
  name: string
  /** Member skill names (union of origin + sets membership), sorted. */
  skillNames: string[]
  /** Where the membership comes from. */
  kind: 'collection' | 'sets' | 'both'
}

/**
 * Merge origin collections (backend-aggregated from sidecar origins) with the
 * author `sets` declared on each skill, into one deduplicated list sorted by
 * name. A group present in both sources takes the union of members.
 */
export function mergeCollections(
  skills: readonly CatalogSkill[],
  collections: readonly CollectionGroup[],
): UnifiedCollection[] {
  const members = new Map<string, { names: Set<string>; hasOrigin: boolean; hasSets: boolean }>()
  const ensure = (name: string): { names: Set<string>; hasOrigin: boolean; hasSets: boolean } => {
    let entry = members.get(name)
    if (entry === undefined) {
      entry = { names: new Set(), hasOrigin: false, hasSets: false }
      members.set(name, entry)
    }
    return entry
  }
  for (const collection of collections) {
    const entry = ensure(collection.name)
    entry.hasOrigin = true
    for (const name of collection.skillNames) entry.names.add(name)
  }
  for (const skill of skills) {
    for (const set of skill.sets ?? []) {
      const entry = ensure(set)
      entry.hasSets = true
      entry.names.add(skill.name)
    }
  }
  return [...members.entries()]
    .map(([name, entry]) => ({
      name,
      skillNames: [...entry.names].sort((a, b) => a.localeCompare(b)),
      kind: (entry.hasOrigin && entry.hasSets ? 'both' : entry.hasOrigin ? 'collection' : 'sets') as UnifiedCollection['kind'],
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Skills that belong to no tag, no origin collection, and no author set. */
export function uncategorizedSkills(
  skills: readonly CatalogSkill[],
  tags: readonly SkillTag[],
  origins: Record<string, string>,
): CatalogSkill[] {
  const inTags = new Set<string>()
  for (const tag of tags) for (const name of tag.skillNames) inTags.add(name)
  return skills.filter((skill) => {
    if (inTags.has(skill.name)) return false
    if (origins[skill.name] !== undefined) return false
    if ((skill.sets ?? []).length > 0) return false
    return true
  })
}

/** Apply the source filter ('all' or a specific source value). */
export function filterBySource(skills: readonly CatalogSkill[], source: string): CatalogSkill[] {
  if (source === 'all') return [...skills]
  return skills.filter((skill) => skill.source === source)
}

/** Localized relative-time tuple; the caller resolves it via tt(). */
export interface RelativeTime {
  key: 'time.justNow' | 'time.minutesAgo' | 'time.hoursAgo' | 'time.daysAgo' | 'time.weeksAgo'
  value?: number
}

/** Format an epoch-ms timestamp as a short relative time bucket. */
export function formatRelativeTime(ms: number, now = Date.now()): RelativeTime {
  const diff = Math.max(0, now - ms)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return { key: 'time.justNow' }
  if (minutes < 60) return { key: 'time.minutesAgo', value: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { key: 'time.hoursAgo', value: hours }
  const days = Math.floor(hours / 24)
  if (days < 7) return { key: 'time.daysAgo', value: days }
  return { key: 'time.weeksAgo', value: Math.floor(days / 7) }
}
