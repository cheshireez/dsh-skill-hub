/**
 * General tab, source view: one card per upstream collection with check /
 * sync / follow-delete actions and the tri-state switch, plus the
 * uncategorized "personal" card. Project skills live in WorkspaceView.
 */

import { useMemo, useState, type JSX } from 'react'
import { tt } from '../helpers.ts'
import { filterBySource, groupSwitchView, isProjectSource, visibleCollections } from '../grouping.ts'
import { SkillRows } from './SkillRows.tsx'
import { GroupSummary } from './GroupSummary.tsx'
import { GroupHeader } from './GroupHeader.tsx'
import { GroupSection } from './GroupSection.tsx'
import { useDragReorder } from './useDragReorder.ts'
import { ReorderButtons } from './ReorderButtons.tsx'
import { CollectionCard } from './CollectionCard.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export function SourcesView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const { catalog, groupsState, sourceFilter, origins, sorted, collapsedGroups, viewNames, sourceCheck, actionNames, checkingSource, syncingSource, batchBusy, busyNames, toggleGroupCollapse, checkSources, requestSync, requestDelete, requestDeleteGroup, toggleGroup } = hub
  const [topDragKey, setTopDragKey] = useState<string | null>(null)
  const [topOverKey, setTopOverKey] = useState<string | null>(null)
  const duplicateNames = useMemo(() => new Set(catalog?.duplicateNames ?? []), [catalog])

  // 顶层分组统一拖拽（col:xxx / personal 全部可拖）
  const sourceFiltered = filterBySource(sorted, sourceFilter, origins).filter((skill) => !isProjectSource(skill.source))
  const visible = visibleCollections(groupsState?.collections ?? [], sourceFiltered)
  const collections = visible.map((entry) => entry.collection)
  const uncategorized = sourceFiltered.filter((skill) => origins[skill.name] === undefined)
  const allPersonalNames = uncategorized.map((skill) => skill.name)
  const hasPersonal = allPersonalNames.length > 0
  const defaultTopKeys: string[] = [
    ...collections.map((collection) => 'col:' + collection.name),
    ...(hasPersonal ? ['uncategorized-source'] : []),
  ]
  const storedTopOrder = groupsState?.sourceGroupOrder ?? []
  const topOrderedKeys = (() => {
    if (storedTopOrder.length === 0) return defaultTopKeys
    const set = new Set(storedTopOrder)
    const result = storedTopOrder.filter((key) => defaultTopKeys.includes(key))
    for (const key of defaultTopKeys) if (!set.has(key)) result.push(key)
    return result.length > 0 ? result : defaultTopKeys
  })()
  const handleTopDrop = (targetKey: string): void => {
    if (topDragKey === null || topDragKey === targetKey) return
    const from = topOrderedKeys.indexOf(topDragKey)
    const to = topOrderedKeys.indexOf(targetKey)
    if (from === -1 || to === -1) return
    const next = [...topOrderedKeys]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    void hub.reorderSourceGroups(next)
  }
  const drag = useDragReorder({ dragKey: topDragKey, overKey: topOverKey, setDragKey: setTopDragKey, setOverKey: setTopOverKey, onDrop: handleTopDrop })
  const moveTop = (key: string, direction: -1 | 1): void => {
    const from = topOrderedKeys.indexOf(key)
    const to = from + direction
    if (from === -1 || to < 0 || to >= topOrderedKeys.length) return
    const next = [...topOrderedKeys]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    void hub.reorderSourceGroups(next)
  }
  const rowProps = { uses: hub.uses, hubConfig: hub.hubConfig, busyNames, editMode: hub.editMode, tagBusy: hub.tagBusy, duplicateNames, statusFilter: hub.statusFilter, toggle: hub.toggle, openDetail: hub.openDetail, requestDeleteSkill: hub.requestDeleteSkill }

  const isEmptyTop = collections.length === 0 && !hasPersonal
  return (
    <>
      {isEmptyTop ? <div className={css.empty}>{tt('groups.noCollections')}</div> : null}
      {topOrderedKeys.map((topKey) => {
        if (topKey.startsWith('col:')) {
          const colName = topKey.slice(4)
          const entry = visible.find((item) => item.collection.name === colName)
          if (entry === undefined) return null
          const { collection, skills } = entry
          const collapsed = collapsedGroups.has('col:' + collection.name)
          const view = groupSwitchView(collection.skillNames, viewNames)
          const check = sourceCheck[collection.name]
          const hasWritable = collection.skillNames.some((name) => actionNames.has(name))
          return (
            <CollectionCard
              key={'col:' + collection.name}
              collection={collection}
              skills={skills}
              collapsed={collapsed}
              view={view}
              check={check}
              hasWritable={hasWritable}
              editMode={hub.editMode}
              canMoveUp={topOrderedKeys.indexOf(topKey) > 0}
              canMoveDown={topOrderedKeys.indexOf(topKey) < topOrderedKeys.length - 1}
              onMove={(direction) => { moveTop(topKey, direction) }}
              checkingSource={checkingSource}
              syncingSource={syncingSource}
              batchBusy={batchBusy}
              rowProps={rowProps}
              dragProps={drag(topKey)}
              toggleGroupCollapse={toggleGroupCollapse}
              checkSources={checkSources}
              requestSync={requestSync}
              requestDelete={requestDelete}
              toggleGroup={toggleGroup}
              requestDeleteGroup={requestDeleteGroup}
            />
          )
        }
        if (topKey === 'uncategorized-source' && hasPersonal) {
          const collapsed = collapsedGroups.has('uncategorized-source')
          return (
            <GroupSection key="uncategorized-source" dragProps={drag('uncategorized-source')}>
              <GroupHeader
                title={<>{tt('groups.personal')} · {allPersonalNames.length}<GroupSummary members={allPersonalNames} uses={hub.uses} hubConfig={hub.hubConfig} /></>}
                collapsed={collapsed}
                onToggle={() => { toggleGroupCollapse('uncategorized-source') }}
                leading={<span className={css.dragHandle} aria-hidden title={tt('drag.reorder')}>⋮⋮</span>}
                actions={hub.editMode ? (
                  <>
                    <ReorderButtons
                      canMoveUp={topOrderedKeys.indexOf(topKey) > 0}
                      canMoveDown={topOrderedKeys.indexOf(topKey) < topOrderedKeys.length - 1}
                      onMove={(direction) => { moveTop(topKey, direction) }}
                    />
                    <button type='button' className={css.opBtn + ' ' + css.opDanger} title={tt('source.deleteGroupHint', { count: allPersonalNames.length })} onClick={(event) => { event.stopPropagation(); requestDeleteGroup(tt('groups.personal'), allPersonalNames) }}>{tt('source.deleteGroup')}</button>
                  </>
                ) : undefined}
              />
              {!collapsed ? (
                <SkillRows skills={uncategorized} rowProps={rowProps} />
              ) : null}
            </GroupSection>
          )
        }
        return null
      })}
    </>
  )
}
