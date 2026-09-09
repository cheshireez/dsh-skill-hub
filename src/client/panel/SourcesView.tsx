/**
 * Sources tab: the flat skill list or the grouped view — a project-level
 * three-tier tree (workspaces from workspace.json, each optionally split by
 * .dsh/.agents), one card per upstream collection with check/sync/
 * follow-delete actions and the tri-state switch, plus the uncategorized
 * "personal" card (project skills never count as personal).
 */

import { useMemo, useState, type JSX } from 'react'
import { tt } from '../helpers.ts'
import { filterBySource, groupSwitchView, isProjectSource, PRIVATE_SOURCE } from '../grouping.ts'
import { SourceStatusBadge } from './SourceStatusBadge.tsx'
import { SkillRow } from './SkillRow.tsx'
import { DisabledRow } from './DisabledRow.tsx'
import { GroupSummary } from './GroupSummary.tsx'
import { GroupSwitchButton } from './GroupSwitchButton.tsx'
import { useDragReorder } from './useDragReorder.ts'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export function SourcesView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const { catalog, groupsState, skillView, sourceFilter, origins, sorted, normalized, collapsedGroups, viewNames, sourceCheck, actionNames, checkingSource, syncingSource, batchBusy, busyNames, toggleGroupCollapse, checkSources, requestSync, requestDelete, requestDeleteGroup, toggleGroup, enableDisabled } = hub
  const [topDragKey, setTopDragKey] = useState<string | null>(null)
  const [topOverKey, setTopOverKey] = useState<string | null>(null)
  /** 重复技能名集合：整表只建一次，行内用 has 取代逐行线性 includes。 */
  const duplicateNames = useMemo(() => new Set(catalog?.duplicateNames ?? []), [catalog])

  // ----- 顶层分组统一拖拽（project / col:xxx / personal 全部可拖） -----
  const projectSkillsAll = filterBySource(sorted, sourceFilter, origins).filter((skill) => isProjectSource(skill.source))
  const hasProject = projectSkillsAll.length > 0
  const collections = groupsState?.collections ?? []
  const uncategorized = filterBySource(sorted, sourceFilter, origins).filter((skill) => origins[skill.name] === undefined && !isProjectSource(skill.source))
  const personalDisabled = (catalog?.disabled ?? []).filter((record) => origins[record.name] === undefined)
    .filter((record) => normalized.length === 0 || record.name.toLocaleLowerCase().includes(normalized) || record.description.toLocaleLowerCase().includes(normalized))
    .filter((record) => sourceFilter === 'all' || sourceFilter === PRIVATE_SOURCE)
  const allPersonalNames = [...uncategorized.map((s) => s.name), ...personalDisabled.map((r) => r.name)]
  const hasPersonal = allPersonalNames.length > 0
  const defaultTopKeys: string[] = [
    ...(hasProject ? ['project'] : []),
    ...collections.map((c) => 'col:' + c.name),
    ...(hasPersonal ? ['uncategorized-source'] : []),
  ]
  const storedTopOrder = groupsState?.sourceGroupOrder ?? []
  const topOrderedKeys = (() => {
    if (storedTopOrder.length === 0) return defaultTopKeys
    const set = new Set(storedTopOrder)
    const result = storedTopOrder.filter((k) => defaultTopKeys.includes(k))
    for (const k of defaultTopKeys) if (!set.has(k)) result.push(k)
    // 兼容旧 collectionOrder：若 storedTopOrder 为空但旧 order 有值，已在 defaultTopKeys 中体现 collection 顺序
    if (result.length === 0) return defaultTopKeys
    return result
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
  /** SkillRow 收窄后的 props：父组件统一传入它实际消费的字段。 */
  const rowProps = { uses: hub.uses, hubConfig: hub.hubConfig, busyNames, editMode: hub.editMode, tagBusy: hub.tagBusy, duplicateNames, toggle: hub.toggle, openDetail: hub.openDetail, requestDeleteSkill: hub.requestDeleteSkill }

  if (skillView === 'flat') {
    return <>{filterBySource(sorted, sourceFilter, origins).map((skill) => <SkillRow key={skill.name} skill={skill} {...rowProps} />)}</>
  }

  // 空状态：没有任何分组时提示
  const isEmptyTop = !hasProject && collections.length === 0 && !hasPersonal
  return (
    <>
      {isEmptyTop ? <div className={css.empty}>{tt('groups.noCollections')}</div> : null}
      {topOrderedKeys.map((topKey) => {
        // Project 顶层卡片（可拖）
        if (topKey === 'project' && hasProject) {
          const topCollapsed = collapsedGroups.has('project')
          // 按 workspace 聚合，与 ProjectTree 逻辑一致
          const byProject = new Map<string, { title: string; skills: typeof projectSkillsAll }>()
          for (const skill of projectSkillsAll) {
            const key = skill.workspace ?? skill.source
            const entry = byProject.get(key)
            if (entry === undefined) byProject.set(key, { title: skill.workspaceTitle ?? skill.workspace ?? tt('groups.project'), skills: [skill] })
            else entry.skills.push(skill)
          }
          return (
            <section key="project" {...drag('project')}>
              <div className={css.groupHead}>
                <span className={css.dragHandle} aria-hidden title="拖拽调整顺序">⋮⋮</span>
                <button type='button' className={css.disclosure} aria-expanded={!topCollapsed} onClick={() => { toggleGroupCollapse('project') }}>
                  <span className={css.chevron + (topCollapsed ? ' ' + css.chevronCollapsed : '')} />
                  <span className={css.groupTitle}>{tt('groups.project')} · {byProject.size}</span>
                </button>
              </div>
              {!topCollapsed ? [...byProject.entries()].map(([key, proj]) => {
                const projKey = 'project:' + key
                const projCollapsed = collapsedGroups.has(projKey)
                const subdivided = hub.subdividedProjects.has(key)
                return (
                  <div key={projKey} className={css.projectNest}>
                    <div className={css.groupHead}>
                      <button type='button' className={css.disclosure} aria-expanded={!projCollapsed} onClick={() => { toggleGroupCollapse(projKey) }}>
                        <span className={css.chevron + (projCollapsed ? ' ' + css.chevronCollapsed : '')} />
                        <span className={css.groupTitle}>{proj.title} · {proj.skills.length}<GroupSummary members={proj.skills.map((s) => s.name)} uses={hub.uses} hubConfig={hub.hubConfig} /></span>
                      </button>
                      <span className={css.groupOps}>
                        <button type='button' className={css.opBtn} onClick={(event) => { event.stopPropagation(); hub.toggleSubdivide(key) }}>{subdivided ? tt('groups.merge') : tt('groups.subdivide')}</button>
                      </span>
                    </div>
                    {!projCollapsed ? (
                      subdivided ? (
                        <div className={css.projectNest}>
                          {(['project-dsh', 'project-agents'] as const).map((source) => {
                            const list = proj.skills.filter((skill) => skill.source === source)
                            if (list.length === 0) return null
                            const srcKey = projKey + ':' + source
                            const srcCollapsed = collapsedGroups.has(srcKey)
                            return (
                              <div key={srcKey} className={css.projectNest}>
                                <div className={css.groupHead}>
                                  <button type='button' className={css.disclosure} aria-expanded={!srcCollapsed} onClick={() => { toggleGroupCollapse(srcKey) }}>
                                    <span className={css.chevron + (srcCollapsed ? ' ' + css.chevronCollapsed : '')} />
                                    <span className={css.groupTitle}>{tt(('badge.source.' + source) as 'badge.source.project-dsh' | 'badge.source.project-agents')} · {list.length}</span>
                                  </button>
                                </div>
                                {!srcCollapsed ? list.map((skill) => <SkillRow key={skill.name} skill={skill} {...rowProps} />) : null}
                              </div>
                            )
                          })}
                        </div>
                      ) : proj.skills.map((skill) => <SkillRow key={skill.name} skill={skill} {...rowProps} />)
                    ) : null}
                  </div>
                )
              }) : null}
            </section>
          )
        }
        // Collection 卡片（可拖，归属顶层排序）
        if (topKey.startsWith('col:')) {
          const colName = topKey.slice(4)
          const collection = collections.find((c) => c.name === colName)
          if (collection === undefined) return null
        const skills = filterBySource(sorted, sourceFilter, origins).filter((skill) => collection.skillNames.includes(skill.name))
        const disabledMembers = (catalog?.disabled ?? []).filter((record) =>
          collection.skillNames.includes(record.name)
          && (normalized.length === 0 || record.name.toLocaleLowerCase().includes(normalized) || record.description.toLocaleLowerCase().includes(normalized))
          && (sourceFilter === 'all' || (origins[record.name] ?? PRIVATE_SOURCE) === sourceFilter))
        const collapsed = collapsedGroups.has('col:' + collection.name)
        const view = groupSwitchView(collection.skillNames, viewNames)
        const check = sourceCheck[collection.name]
        const hasWritable = collection.skillNames.some((name) => actionNames.has(name))
        return (
          <section key={'col:' + collection.name} {...drag(topKey)}>
            <div className={css.groupHead}>
              <span className={css.dragHandle} aria-hidden title="拖拽调整顺序">⋮⋮</span>
              <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('col:' + collection.name) }}>
                <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                <span className={css.groupTitle}>
                  <a className={css.sourceLink} href={'https://github.com/' + collection.name} target='_blank' rel='noreferrer' onClick={(event) => { event.stopPropagation() }}>{collection.name}</a>
                  {' · ' + collection.skillNames.length}
                  <GroupSummary members={collection.skillNames} uses={hub.uses} hubConfig={hub.hubConfig} />
                </span>
              </button>
              <span className={css.groupOps}>
                <SourceStatusBadge
                  check={check}
                  checking={checkingSource === collection.name}
                  onCheck={() => { void checkSources(collection.name) }}
                />
                {check !== undefined && check.changed && check.updated.length > 0
                  ? <button type='button' className={css.opBtn} disabled={syncingSource !== null} onClick={(event) => { event.stopPropagation(); requestSync(collection.name, check.updated) }}>
                      {syncingSource === collection.name ? tt('source.syncing') : tt('source.sync')}
                    </button>
                  : null}
                {check !== undefined && check.deleted.length > 0
                  ? <button type='button' className={css.opBtn + ' ' + css.opDanger} onClick={(event) => { event.stopPropagation(); requestDelete(collection.name, check.deleted) }}>{tt('source.followDelete')}</button>
                  : null}
                <GroupSwitchButton
                  state={view.state}
                  label={collection.name}
                  memberCount={collection.skillNames.length}
                  batchBusy={batchBusy}
                  hasWritable={hasWritable}
                  onToggle={() => { toggleGroup('col:' + collection.name, collection.name, view.state) }}
                />
                {hub.editMode ? <button
                  type='button'
                  className={css.opBtn + ' ' + css.opDanger}
                  title={tt('source.deleteGroupHint', { count: collection.skillNames.length })}
                  onClick={(event) => { event.stopPropagation(); requestDeleteGroup(collection.name, collection.skillNames) }}
                >
                  {tt('source.deleteGroup')}
                </button> : null}
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
        }
        // Personal 顶层卡片（可拖）
        if (topKey === 'uncategorized-source' && hasPersonal) {
          if (allPersonalNames.length === 0) return null
          const collapsed = collapsedGroups.has('uncategorized-source')
          return (
            <section key="uncategorized-source" {...drag('uncategorized-source')}>
              <div className={css.groupHead}>
                <span className={css.dragHandle} aria-hidden title="拖拽调整顺序">⋮⋮</span>
                <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('uncategorized-source') }}>
                  <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                  <span className={css.groupTitle}>{tt('groups.personal')} · {allPersonalNames.length}<GroupSummary members={allPersonalNames} uses={hub.uses} hubConfig={hub.hubConfig} /></span>
                </button>
                <span className={css.groupOps}>
                  {hub.editMode ? <button type='button' className={css.opBtn + ' ' + css.opDanger} title={tt('source.deleteGroupHint', { count: allPersonalNames.length })} onClick={(event) => { event.stopPropagation(); requestDeleteGroup(tt('groups.personal'), allPersonalNames) }}>{tt('source.deleteGroup')}</button> : null}
                </span>
              </div>
              {!collapsed ? (
                <>
                  {uncategorized.map((skill) => <SkillRow key={skill.name} skill={skill} {...rowProps} />)}
                  {personalDisabled.map((record) => (<DisabledRow key={record.name} record={record} busy={busyNames.has(record.name)} duplicate={duplicateNames.has(record.name)} onEnable={() => { void enableDisabled(record) }} onOpen={() => { void hub.openDetail(record.name) }} />))}
                </>
              ) : null}
            </section>
          )
        }
        return null
      })}
    </>
  )
}
