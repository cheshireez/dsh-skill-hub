/**
 * Roles view: user-defined skill sets (one card per role). "Switch to" enables
 * the role's members and pauses every other switchable skill — the confirm
 * dialog lists those skills so any of them can be spared. The pre-switch
 * layout is saved to localStorage so it can be restored in one click. Skills
 * not assigned to any role are reachable from a collapsed card at the bottom.
 *
 * "Source" (upstream repo) and "location" (discovery root) are separate axes;
 * a role is the only user-curated one, and may mix skills from any of them.
 */

import { useMemo, useState, type JSX } from 'react'
import { tt } from '../helpers.ts'
import {
  groupSwitchView, isProjectSource,
  roleActivationPlan, rolePausableSkills, roleRestorePlan, takeRoleSnapshot,
  type RoleActivationPlan, type RoleSnapshot,
} from '../grouping.ts'
import type { SkillTag } from '../../protocol.ts'
import { SkillRows } from './SkillRows.tsx'
import { GroupSummary } from './GroupSummary.tsx'
import { GroupSwitchButton } from './GroupSwitchButton.tsx'
import { GroupHeader } from './GroupHeader.tsx'
import { GroupSection } from './GroupSection.tsx'
import { useDragReorder } from './useDragReorder.ts'
import { ReorderButtons } from './ReorderButtons.tsx'
import { ConfirmDialog, RoleActivateDialog } from './dialogs.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

const SNAPSHOT_KEY = 'dsh-skill-hub.role-snapshot'

function readSnapshot(): RoleSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    if (raw === null) return null
    const value = JSON.parse(raw) as RoleSnapshot
    return typeof value.roleId === 'string' && Array.isArray(value.states) ? value : null
  } catch { return null }
}

function writeSnapshot(value: RoleSnapshot | null): void {
  try {
    if (value === null) localStorage.removeItem(SNAPSHOT_KEY)
    else localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(value))
  } catch { /* Private mode: the in-memory snapshot still works this session. */ }
}

/**
 * `keep` holds the non-member skills the user spared in the confirm dialog;
 * the plan is recomputed from it on confirm, so an unticked list keeps the
 * original all-or-nothing switch.
 */
type PendingAction
  = { kind: 'activate'; tag: SkillTag; keep: ReadonlySet<string> }
  | { kind: 'restore'; snapshot: RoleSnapshot; plan: RoleActivationPlan }

export function ScenesView(props: { hub: SkillHubState; scope: 'general' | 'workspace' }): JSX.Element {
  const { hub, scope } = props
  const { catalog, groupsState, collapsedGroups, viewNames, actionNames, batchBusy, busyNames, newTagName, setNewTagName, tagBusy, createTag, toggleGroupCollapse, toggleGroup, setEditingTag, setEditName, setMembersDraft, setEditSearch } = hub
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [snapshot, setSnapshot] = useState<RoleSnapshot | null>(readSnapshot)
  const [busy, setBusy] = useState(false)
  const [unassignedOpen, setUnassignedOpen] = useState(false)
  const duplicateNames = useMemo(() => new Set(catalog?.duplicateNames ?? []), [catalog])
  const allSkills = catalog?.skills ?? []
  // Role cards deliberately ignore the persisted status/source filters: a role
  // is a roster the user curated by hand, so hiding members — or the whole card
  // once every member is filtered out — reads as data loss. The search and
  // invocation filters still apply, because those are explicit and momentary.
  //
  // Scope is not applied here either: a skill that also exists in a project
  // directory is reported with a `project-*` source (the registry keeps the
  // highest-ranked root), so narrowing by scope emptied whole role cards in the
  // general view. "Unassigned" still follows the tab's scope below, since that
  // card is the per-tab catch-all rather than a curated roster.
  const roleSkills = hub.searchedSorted
  const tags = groupsState?.tags ?? []
  const assignedNames = useMemo(() => new Set(tags.flatMap((tag) => tag.skillNames)), [tags])
  // Follows the search too, so both halves of the view narrow together.
  const unassigned = hub.searchedSorted
    .filter((skill) => (scope === 'workspace' ? isProjectSource(skill.source) : !isProjectSource(skill.source)))
    .filter((skill) => !assignedNames.has(skill.name))

  const planFor = (tag: SkillTag, keep?: ReadonlySet<string>): RoleActivationPlan => roleActivationPlan(tag.skillNames, allSkills, actionNames, keep)
  const requestActivate = (tag: SkillTag): void => {
    const plan = planFor(tag)
    if (plan.toEnable.length + plan.toDisable.length === 0) return
    setPending({ kind: 'activate', tag, keep: new Set() })
  }
  const requestRestore = (): void => {
    if (snapshot === null) return
    setPending({ kind: 'restore', snapshot, plan: roleRestorePlan(snapshot, allSkills, actionNames) })
  }
  const runPending = (): void => {
    if (pending === null) return
    const action = pending
    setPending(null)
    void (async () => {
      setBusy(true)
      try {
        if (action.kind === 'activate') {
          const plan = planFor(action.tag, action.keep)
          // Sparing every candidate can empty the plan; a no-op must not leave
          // behind a restore bar promising to undo something that never happened.
          if (plan.toEnable.length + plan.toDisable.length === 0) return
          // Save before writing: a partial failure must still be restorable.
          const before = takeRoleSnapshot(action.tag.id, action.tag.name, allSkills, actionNames)
          writeSnapshot(before)
          setSnapshot(before)
          await hub.batchToggleNames(plan.toEnable, true)
          await hub.batchToggleNames(plan.toDisable, false)
        } else {
          await hub.batchToggleNames(action.plan.toEnable, true)
          await hub.batchToggleNames(action.plan.toDisable, false)
          writeSnapshot(null)
          setSnapshot(null)
        }
      } finally {
        setBusy(false)
      }
    })()
  }

  const handleDrop = (targetId: string): void => {
    if (dragId === null || dragId === targetId || groupsState === null) return
    const ids = groupsState.tags.map((t) => t.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    void hub.reorderTags(next)
  }
  const drag = useDragReorder({ dragKey: dragId, overKey: overId, setDragKey: setDragId, setOverKey: setOverId, onDrop: handleDrop })
  const moveTag = (index: number, direction: -1 | 1): void => {
    const ids = tags.map((tag) => tag.id)
    const to = index + direction
    if (to < 0 || to >= ids.length) return
    const next = [...ids]
    const [moved] = next.splice(index, 1)
    next.splice(to, 0, moved)
    void hub.reorderTags(next)
  }
  // `statusFilter: 'all'` — SkillRows re-applies the status filter for list
  // views; a role card must show its roster in full, so it opts out here.
  const rowProps = { uses: hub.uses, hubConfig: hub.hubConfig, busyNames, editMode: hub.editMode, tagBusy, duplicateNames, statusFilter: 'all' as const, toggle: hub.toggle, openDetail: hub.openDetail, requestDeleteSkill: hub.requestDeleteSkill }
  const blocked = busy || batchBusy
  const pendingActivate = pending !== null && pending.kind === 'activate' ? pending : null
  const pendingPausable = pendingActivate !== null ? rolePausableSkills(pendingActivate.tag.skillNames, allSkills, actionNames) : []
  const pendingPlan = pendingActivate !== null ? planFor(pendingActivate.tag, pendingActivate.keep) : null
  /** Recompute the kept set against the live catalog instead of trusting stale names. */
  const updateKeep = (mutate: (pausable: readonly string[], kept: ReadonlySet<string>) => ReadonlySet<string>): void => {
    setPending((current) => {
      if (current === null || current.kind !== 'activate') return current
      const pausable = rolePausableSkills(current.tag.skillNames, allSkills, actionNames)
      return { ...current, keep: mutate(pausable, current.keep) }
    })
  }
  return (
    <>
      <form className={css.form} onSubmit={(event) => { void createTag(event) }}>
        <div className={css.buttons}>
          <input
            className={css.input + ' ' + css.grow}
            value={newTagName}
            onChange={(event) => { setNewTagName(event.target.value) }}
            placeholder={tt('groups.namePlaceholder')}
          />
          <button type='submit' className={css.button + ' ' + css.primary} disabled={tagBusy || newTagName.trim() === ''}>{tt('groups.new')}</button>
        </div>
      </form>

      {snapshot !== null ? (
        <div className={css.roleBar}>
          <span className={css.roleBarText}>{tt('role.snapshotHint', { name: snapshot.roleName })}</span>
          <button type='button' className={css.button} disabled={blocked} onClick={requestRestore}>{tt('role.restore')}</button>
        </div>
      ) : null}

      {groupsState !== null && tags.length === 0 ? <div className={css.empty}>{tt('groups.empty')}</div> : null}
      {tags.map((tag, index) => {
        const skills = roleSkills.filter((skill) => tag.skillNames.includes(skill.name))
        if (skills.length === 0) return null
        const visibleCount = skills.length
        const collapsed = collapsedGroups.has('tag:' + tag.id)
        const view = groupSwitchView(tag.skillNames, viewNames)
        const hasWritable = tag.skillNames.some((name) => actionNames.has(name))
        const activation = planFor(tag)
        const canActivate = activation.toEnable.length + activation.toDisable.length > 0
        return (
          <GroupSection key={'tag:' + tag.id} dragProps={drag(tag.id)}>
            <GroupHeader
              title={<>{tag.name} · {visibleCount}<GroupSummary members={tag.skillNames} uses={hub.uses} hubConfig={hub.hubConfig} /></>}
              collapsed={collapsed}
              onToggle={() => { toggleGroupCollapse('tag:' + tag.id) }}
              leading={<span className={css.dragHandle} aria-hidden title={tt('drag.reorder')}>⋮⋮</span>}
              actions={<>
                <button
                  type='button'
                  className={css.opBtn}
                  disabled={blocked || !canActivate}
                  title={canActivate ? tt('role.activate') : tt('role.noWritable')}
                  onClick={() => { requestActivate(tag) }}
                >{tt('role.activate')}</button>
                <GroupSwitchButton
                  state={view.state}
                  label={tag.name}
                  memberCount={tag.skillNames.length}
                  batchBusy={blocked}
                  hasWritable={hasWritable}
                  onToggle={() => { toggleGroup('tag:' + tag.id, tag.name, view.state) }}
                />
                {hub.editMode ? (
                  <ReorderButtons
                    canMoveUp={index > 0}
                    canMoveDown={index < tags.length - 1}
                    onMove={(direction) => { moveTag(index, direction) }}
                  />
                ) : null}
                <button type='button' className={css.opBtn} onClick={() => { setEditingTag(tag); setEditName(tag.name); setMembersDraft(new Set(tag.skillNames)); setEditSearch('') }}>{tt('groups.edit')}</button>
              </>}
            />
            {!collapsed ? <SkillRows skills={skills} rowProps={rowProps} /> : null}
          </GroupSection>
        )
      })}

      {unassigned.length > 0 ? (
        <GroupSection>
          <GroupHeader
            title={tt('role.unassigned', { count: unassigned.length })}
            collapsed={!unassignedOpen}
            onToggle={() => { setUnassignedOpen((value) => !value) }}
          />
          {unassignedOpen ? <SkillRows skills={unassigned} rowProps={rowProps} /> : null}
        </GroupSection>
      ) : null}

      {pendingActivate !== null && pendingPlan !== null ? (
        <RoleActivateDialog
          roleName={pendingActivate.tag.name}
          enableCount={pendingPlan.toEnable.length}
          pausable={pendingPausable}
          keep={pendingActivate.keep}
          onToggle={(name, keep) => {
            updateKeep((_pausable, kept) => {
              const next = new Set(kept)
              if (keep) next.add(name)
              else next.delete(name)
              return next
            })
          }}
          onKeepAll={() => { updateKeep((pausable) => new Set(pausable)) }}
          onKeepNone={() => { updateKeep(() => new Set()) }}
          onCancel={() => { setPending(null) }}
          onConfirm={runPending}
        />
      ) : pending !== null && pending.kind === 'restore' ? (
        <ConfirmDialog
          title={tt('role.restoreTitle')}
          text={tt('role.restoreText', { name: pending.snapshot.roleName, count: pending.plan.toEnable.length + pending.plan.toDisable.length })}
          confirmLabel={tt('role.restoreConfirm')}
          onCancel={() => { setPending(null) }}
          onConfirm={runPending}
        />
      ) : null}
    </>
  )
}
