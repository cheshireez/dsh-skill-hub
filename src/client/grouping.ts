/**
 * Pure grouping helpers for the skill-hub panel (no React/DOM deps, so the
 * merge/classify/filter logic stays unit-testable).
 *
 * The "分组" view unifies two ways a skill can belong to a group:
 *  - user tags (sidecar SkillTag)
 *  - origin collections (sidecar sources → backend-aggregated CollectionGroup)
 *
 * Switch semantics: a skill's enabled state is global (the file is renamed
 * once), so a group switch is derived from its members' actual states:
 * all members enabled → 'on', all disabled → 'off', otherwise 'mixed'.
 * Closing a group whose member is enabled in another group is a conflict the
 * GUI resolves with a dialog; the helpers below compute both sides.
 */

import type { CatalogSkill, CollectionGroup, SkillTag } from '../protocol.ts'

/** Grouped switch state derived from member enablement. */
export type GroupSwitchState = 'on' | 'off' | 'mixed'

/** The derived switch view of one group. */
export interface GroupSwitchView {
  state: GroupSwitchState
  /** Writable members currently enabled. */
  enabled: string[]
  /** Writable members currently disabled. */
  disabled: string[]
}

/**
 * Derive a group switch view from its member names and the set of currently
 * enabled skill names (catalog.skills). Members not in the enabled set count
 * as disabled (catalog.disabled or absent read-only rows).
 */
export function groupSwitchView(members: readonly string[], enabledNames: ReadonlySet<string>): GroupSwitchView {
  const enabled: string[] = []
  const disabled: string[] = []
  for (const name of members) {
    if (enabledNames.has(name)) enabled.push(name)
    else disabled.push(name)
  }
  const state: GroupSwitchState = disabled.length === 0 ? 'on' : enabled.length === 0 ? 'off' : 'mixed'
  return { state, enabled, disabled }
}

/** Names of every group a skill belongs to (tags + collections). */
export function groupNamesOf(name: string, tags: readonly SkillTag[], collections: readonly CollectionGroup[]): string[] {
  const names: string[] = []
  for (const tag of tags) if (tag.skillNames.includes(name)) names.push(tag.name)
  for (const collection of collections) if (collection.skillNames.includes(name)) names.push(collection.name)
  return names
}

/**
 * Members of a group that are currently enabled AND also belong to at least
 * one other group — the set a "close" action must ask about.
 */
export function conflictsOnClose(
  members: readonly string[],
  enabledNames: ReadonlySet<string>,
  otherGroups: ReadonlyArray<{ members: readonly string[] }>,
): string[] {
  return members.filter((name) => {
    if (!enabledNames.has(name)) return false
    return otherGroups.some((group) => group.members.includes(name))
  })
}

/** Skills that belong to no tag and no origin collection. */
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
