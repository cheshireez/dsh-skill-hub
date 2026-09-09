/**
 * Scenes tab: user tag groups (one card per scene with the tri-state switch
 * and edit entry) plus the new-scene form. Scenes are the user's own
 * enable/disable units (e.g. a Godot scene vs a Java scene); upstream repos
 * are managed in the sources tab.
 */

import { useMemo, useState, type JSX } from 'react'
import { tt } from '../helpers.ts'
import { groupSwitchView } from '../grouping.ts'
import { SkillRow } from './SkillRow.tsx'
import { DisabledRow } from './DisabledRow.tsx'
import { GroupSummary } from './GroupSummary.tsx'
import { GroupSwitchButton } from './GroupSwitchButton.tsx'
import { useDragReorder } from './useDragReorder.ts'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export function ScenesView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const { catalog, groupsState, sorted, normalized, collapsedGroups, viewNames, actionNames, batchBusy, busyNames, newTagName, setNewTagName, tagBusy, createTag, toggleGroupCollapse, toggleGroup, setEditingTag, setEditName, setMembersDraft, setEditSearch, enableDisabled } = hub
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  /** 重复技能名集合：整表只建一次，行内用 has 取代逐行线性 includes。 */
  const duplicateNames = useMemo(() => new Set(catalog?.duplicateNames ?? []), [catalog])
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
  /** SkillRow 收窄后的 props：父组件统一传入它实际消费的字段。 */
  const rowProps = { uses: hub.uses, hubConfig: hub.hubConfig, busyNames, editMode: hub.editMode, tagBusy, duplicateNames, toggle: hub.toggle, openDetail: hub.openDetail, requestDeleteSkill: hub.requestDeleteSkill }
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

      {groupsState !== null && groupsState.tags.length === 0 ? <div className={css.empty}>{tt('groups.empty')}</div> : null}
      {groupsState?.tags.map((tag) => {
        const skills = sorted.filter((skill) => tag.skillNames.includes(skill.name))
        const disabledMembers = (catalog?.disabled ?? []).filter((record) => tag.skillNames.includes(record.name) && (normalized.length === 0 || record.name.toLocaleLowerCase().includes(normalized) || record.description.toLocaleLowerCase().includes(normalized)))
        const collapsed = collapsedGroups.has('tag:' + tag.id)
        const view = groupSwitchView(tag.skillNames, viewNames)
        const hasWritable = tag.skillNames.some((name) => actionNames.has(name))
        return (
          <section key={'tag:' + tag.id} {...drag(tag.id)}>
            <div className={css.groupHead}>
              <span className={css.dragHandle} aria-hidden title="拖拽调整顺序">⋮⋮</span>
              <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('tag:' + tag.id) }}>
                <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                <span className={css.groupTitle}>
                  {tag.name} · {tag.skillNames.length}
                  <GroupSummary members={tag.skillNames} uses={hub.uses} hubConfig={hub.hubConfig} />
                </span>
              </button>
              <span className={css.groupOps}>
                <GroupSwitchButton
                  state={view.state}
                  label={tag.name}
                  memberCount={tag.skillNames.length}
                  batchBusy={batchBusy}
                  hasWritable={hasWritable}
                  onToggle={() => { toggleGroup('tag:' + tag.id, tag.name, view.state) }}
                />
                <button type='button' className={css.opBtn} onClick={() => { setEditingTag(tag); setEditName(tag.name); setMembersDraft(new Set(tag.skillNames)); setEditSearch('') }}>{tt('groups.edit')}</button>
              </span>
            </div>
            {!collapsed ? (
              <>
                {skills.map((skill) => <SkillRow key={skill.name} skill={skill} {...rowProps} />)}
                {disabledMembers.map((record) => (
                  <DisabledRow key={record.name} record={record} busy={busyNames.has(record.name)} duplicate={duplicateNames.has(record.name)} onEnable={() => { void enableDisabled(record) }} onOpen={() => { void hub.openDetail(record.name) }} />
                ))}
              </>
            ) : null}
          </section>
        )
      })}
    </>
  )
}
