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

/* ------------------------------------------------------------------ roles */

/** Names that must be switched to reach a target enablement layout. */
export interface RoleActivationPlan {
  toEnable: string[]
  toDisable: string[]
}

/**
 * Only skills the hub can actually switch take part in a role activation.
 * Project skills live in the Workspace tab; read-only/bundled/runtime rows
 * cannot be toggled at all. `actionNames` comes from the catalog flow.
 */
function switchableSkills(skills: readonly CatalogSkill[], actionNames: ReadonlySet<string>): CatalogSkill[] {
  return skills.filter((skill) => !isProjectSource(skill.source) && actionNames.has(skill.name))
}

/**
 * Skills a role activation would otherwise pause: enabled, switchable, and
 * not a member. The confirm dialog lists them so the user can spare any of
 * them instead of accepting an all-or-nothing switch.
 */
export function rolePausableSkills(
  members: readonly string[],
  skills: readonly CatalogSkill[],
  actionNames: ReadonlySet<string>,
): string[] {
  const memberSet = new Set(members)
  const names: string[] = []
  for (const skill of switchableSkills(skills, actionNames)) {
    if (!memberSet.has(skill.name) && skill.modelOverride !== true) names.push(skill.name)
  }
  return names
}

/**
 * Plan "activate this role": turn the role's members on and every other
 * switchable skill off, except the names in `keepEnabled` the user chose to
 * spare. Already-correct rows are omitted so a second run is a no-op
 * (idempotent).
 */
export function roleActivationPlan(
  members: readonly string[],
  skills: readonly CatalogSkill[],
  actionNames: ReadonlySet<string>,
  keepEnabled?: ReadonlySet<string>,
): RoleActivationPlan {
  const memberSet = new Set(members)
  const toEnable: string[] = []
  const toDisable: string[] = []
  for (const skill of switchableSkills(skills, actionNames)) {
    const enabled = skill.modelOverride !== true
    if (memberSet.has(skill.name)) {
      if (!enabled) toEnable.push(skill.name)
    } else if (enabled) {
      // Spared by the user: leave the switch exactly as it is.
      if (keepEnabled?.has(skill.name) === true) continue
      toDisable.push(skill.name)
    }
  }
  return { toEnable, toDisable }
}

/** Switch states captured right before a role activation, kept for restore. */
export interface RoleSnapshot {
  roleId: string
  roleName: string
  at: number
  states: Array<{ name: string; enabled: boolean }>
}

export function takeRoleSnapshot(
  roleId: string,
  roleName: string,
  skills: readonly CatalogSkill[],
  actionNames: ReadonlySet<string>,
): RoleSnapshot {
  return {
    roleId,
    roleName,
    at: Date.now(),
    states: switchableSkills(skills, actionNames).map((skill) => ({ name: skill.name, enabled: skill.modelOverride !== true })),
  }
}

/**
 * Plan "restore before the last role activation". Skills installed after the
 * snapshot are left untouched — pausing them would silently undo a newer
 * user decision.
 */
export function roleRestorePlan(
  snapshot: RoleSnapshot,
  skills: readonly CatalogSkill[],
  actionNames: ReadonlySet<string>,
): RoleActivationPlan {
  const before = new Map(snapshot.states.map((state) => [state.name, state.enabled]))
  const toEnable: string[] = []
  const toDisable: string[] = []
  for (const skill of switchableSkills(skills, actionNames)) {
    const target = before.get(skill.name)
    if (target === undefined) continue
    const enabled = skill.modelOverride !== true
    if (target && !enabled) toEnable.push(skill.name)
    if (!target && enabled) toDisable.push(skill.name)
  }
  return { toEnable, toDisable }
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

// 停用技能已在 `catalog.skills` 里带 `modelOverride` 呈现；sidecar 的
// `disabled[]` 退为纯台账（占名、恢复归属、详情反推），不再作为第二种技能行
// 渲染。因此不再需要 dropShadowedDisabled / visibleDisabledRecords 这条链路。

/** Status filter values shared by the list shell and the row components. */
export type SkillStatusFilter = 'all' | 'enabled' | 'disabled'
/** Invocation filter values (who may trigger the skill). */
export type InvocationFilter = 'all' | 'model' | 'user'

/**
 * Free-text + invocation filtering. Deliberately view-independent: every view
 * applies it, including the role cards, because typing in the search box is an
 * explicit, momentary narrowing.
 */
export function filterSkillsByQuery(
  skills: readonly CatalogSkill[],
  query: string,
  invocation: InvocationFilter,
): CatalogSkill[] {
  const normalized = query.trim().toLocaleLowerCase()
  return skills.filter((skill) => {
    if (invocation === 'model' && !skill.invocation.modelInvocable) return false
    if (invocation === 'user' && !skill.invocation.userInvocable) return false
    if (normalized.length === 0) return true
    return skill.name.toLocaleLowerCase().includes(normalized)
      || skill.description.toLocaleLowerCase().includes(normalized)
      || skill.displayName?.toLocaleLowerCase().includes(normalized)
      || skill.shortDescription?.toLocaleLowerCase().includes(normalized)
  })
}

/**
 * The status filter belongs to list views only. Role cards skip it: a role is a
 * roster the user curated by hand, so hiding paused members — or losing the
 * whole card once every member is filtered out — reads as data loss.
 */
export function filterSkillsByStatus(skills: readonly CatalogSkill[], status: SkillStatusFilter): CatalogSkill[] {
  if (status === 'all') return [...skills]
  return skills.filter((skill) => {
    // Project and external read-only skills are never moved into the disabled
    // sidecar; their switch is an invocation override. Keep every toggleable
    // override row for the "disabled" view, not only project ones.
    if (status === 'disabled') return skill.toggleable === true && skill.modelOverride === true
    return skill.modelOverride !== true
  })
}

/** One discovery root (where the skill files live) with its members. */
export interface LocationGroup {
  /** Discovery source id: `user-dsh`, `user-agents`, `agent-codex`, … */
  id: string
  skills: CatalogSkill[]
}

/** Local roots come first — they are the ones the hub can actually write. */
const LOCAL_LOCATIONS = ['user-dsh', 'user-agents']

function locationRank(id: string): number {
  const index = LOCAL_LOCATIONS.indexOf(id)
  return index === -1 ? LOCAL_LOCATIONS.length : index
}

/**
 * Group skills by the discovery root that produced them (`CatalogSkill.source`).
 * This is the "location" axis, orthogonal to the upstream origin (`origins`)
 * and to roles. Project skills are left out on purpose: the workspace tab
 * already groups them, and a project root is really its workspace path.
 */
export function groupByLocation(skills: readonly CatalogSkill[]): LocationGroup[] {
  const buckets = new Map<string, CatalogSkill[]>()
  for (const skill of skills) {
    if (isProjectSource(skill.source)) continue
    const bucket = buckets.get(skill.source)
    if (bucket === undefined) buckets.set(skill.source, [skill])
    else bucket.push(skill)
  }
  return [...buckets.entries()]
    .map(([id, members]) => ({ id, skills: members }))
    .sort((a, b) => locationRank(a.id) - locationRank(b.id) || a.id.localeCompare(b.id))
}

/** One origin collection with the members visible under the current filters. */
export interface VisibleCollection {  collection: CollectionGroup
  skills: CatalogSkill[]
}

/**
 * Match origin collections against the currently visible skills, dropping
 * collections with no visible member. Paused skills stay in `skills` with
 * `modelOverride`, so there is no second "disabled rows" stream to merge.
 */
export function visibleCollections(
  collections: readonly CollectionGroup[],
  visibleSkills: readonly CatalogSkill[],
): VisibleCollection[] {
  const visible: VisibleCollection[] = []
  for (const collection of collections) {
    const skills = visibleSkills.filter((skill) => collection.skillNames.includes(skill.name))
    if (skills.length > 0) visible.push({ collection, skills })
  }
  return visible
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
