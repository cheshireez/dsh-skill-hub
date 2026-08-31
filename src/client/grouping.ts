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
import { isProjectSource } from '../protocol.ts'

export { isProjectSource }

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

/** Origin-repo filter value: skills with no source record (private skills). */
export const PRIVATE_SOURCE = 'private'

/**
 * Apply the origin filter ('all' or a specific origin repo; skills without a
 * source record count as PRIVATE_SOURCE). The origins map is the store's
 * skillName → repo derivation, so filtering follows the tracked source
 * records instead of the filesystem root a skill happens to live under.
 * 项目级技能（有 workspace 归属）永远不算「个人」。
 */
export function filterBySource(skills: readonly CatalogSkill[], source: string, origins: Readonly<Record<string, string>>): CatalogSkill[] {
  if (source === 'all') return [...skills]
  return skills.filter((skill) => {
    if (isProjectSource(skill.source)) return false
    return (origins[skill.name] ?? PRIVATE_SOURCE) === source
  })
}

/** Catalog sort keys offered by the filter bar. */
export type SortKey = 'name' | 'added' | 'uses'

/**
 * Sort a skill list in place-safe copy order: name ascending, added
 * descending (newest first, unknown addedAt last), or uses descending
 * (most-called first). Unknown values always trail.
 */
export function sortSkills(skills: readonly CatalogSkill[], key: SortKey, getUses?: (name: string) => number | undefined): CatalogSkill[] {
  const list = [...skills]
  if (key === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name))
  } else if (key === 'added') {
    list.sort((a, b) => (b.addedAt ?? -Infinity) - (a.addedAt ?? -Infinity))
  } else if (key === 'uses') {
    list.sort((a, b) => (getUses?.(b.name) ?? 0) - (getUses?.(a.name) ?? 0))
  }
  return list
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
