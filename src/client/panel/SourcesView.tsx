/**
 * Sources tab: the flat skill list or the grouped view — a project-level
 * three-tier tree (workspaces from workspace.json, each optionally split by
 * .dsh/.agents), one card per upstream collection with check/sync/
 * follow-delete actions and the tri-state switch, plus the uncategorized
 * "personal" card (project skills never count as personal).
 */

import type { JSX } from 'react'
import { tt } from '../helpers.ts'
import { filterBySource, groupSwitchView, isProjectSource, PRIVATE_SOURCE } from '../grouping.ts'
import { SourceStatusBadge } from './SourceStatusBadge.tsx'
import { SkillRow } from './SkillRow.tsx'
import { DisabledRow } from './DisabledRow.tsx'
import { GroupSummary } from './GroupSummary.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

/** 项目级三级树：项目级 → 具体工作区（可折叠、可细分）→ .dsh/.agents。 */
function ProjectTree(props: { hub: SkillHubState }): JSX.Element | null {
  const { hub } = props
  const { sorted, sourceFilter, origins, collapsedGroups, subdividedProjects, toggleGroupCollapse, toggleSubdivide } = hub
  const projectSkills = filterBySource(sorted, sourceFilter, origins).filter((skill) => isProjectSource(skill.source))
  if (projectSkills.length === 0) return null
  // workspace 缺失（过渡态）时按 source 降级分组，避免空标题。
  const byProject = new Map<string, { title: string; skills: typeof projectSkills }>()
  for (const skill of projectSkills) {
    const key = skill.workspace ?? skill.source
    const entry = byProject.get(key)
    if (entry === undefined) {
      byProject.set(key, {
        title: skill.workspaceTitle ?? skill.workspace ?? tt('groups.project'),
        skills: [skill],
      })
    } else {
      entry.skills.push(skill)
    }
  }
  const topCollapsed = collapsedGroups.has('project')
  return (
    <section className={css.section}>
      <div className={css.groupHead}>
        <button type='button' className={css.disclosure} aria-expanded={!topCollapsed} onClick={() => { toggleGroupCollapse('project') }}>
          <span className={css.chevron + (topCollapsed ? ' ' + css.chevronCollapsed : '')} />
          <span className={css.groupTitle}>
            {tt('groups.project')} · {byProject.size}
          </span>
        </button>
      </div>
      {!topCollapsed ? [...byProject.entries()].map(([key, proj]) => {
        const projKey = 'project:' + key
        const projCollapsed = collapsedGroups.has(projKey)
        const subdivided = subdividedProjects.has(key)
        return (
          <div key={projKey} className={css.section + ' ' + css.projectNest}>
            <div className={css.groupHead}>
              <button type='button' className={css.disclosure} aria-expanded={!projCollapsed} onClick={() => { toggleGroupCollapse(projKey) }}>
                <span className={css.chevron + (projCollapsed ? ' ' + css.chevronCollapsed : '')} />
                <span className={css.groupTitle}>
                  {proj.title} · {proj.skills.length}
                  <GroupSummary members={proj.skills.map((skill) => skill.name)} hub={hub} />
                </span>
              </button>
              <span className={css.groupOps}>
                <button type='button' className={css.opBtn} onClick={(event) => { event.stopPropagation(); toggleSubdivide(key) }}>
                  {subdivided ? tt('groups.merge') : tt('groups.subdivide')}
                </button>
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
                      <div key={srcKey} className={css.section + ' ' + css.projectNest}>
                        <div className={css.groupHead}>
                          <button type='button' className={css.disclosure} aria-expanded={!srcCollapsed} onClick={() => { toggleGroupCollapse(srcKey) }}>
                            <span className={css.chevron + (srcCollapsed ? ' ' + css.chevronCollapsed : '')} />
                            <span className={css.groupTitle}>
                              {tt(('badge.source.' + source) as 'badge.source.project-dsh' | 'badge.source.project-agents')} · {list.length}
                            </span>
                          </button>
                        </div>
                        {!srcCollapsed ? list.map((skill) => <SkillRow key={skill.name} skill={skill} hub={hub} />) : null}
                      </div>
                    )
                  })}
                </div>
              ) : proj.skills.map((skill) => <SkillRow key={skill.name} skill={skill} hub={hub} />)
            ) : null}
          </div>
        )
      }) : null}
    </section>
  )
}

export function SourcesView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const { catalog, groupsState, skillView, sourceFilter, origins, sorted, normalized, collapsedGroups, viewNames, sourceCheck, actionNames, checkingSource, syncingSource, batchBusy, busyNames, toggleGroupCollapse, checkSources, requestSync, requestDelete, toggleGroup, enableDisabled } = hub

  if (skillView === 'flat') {
    return <>{filterBySource(sorted, sourceFilter, origins).map((skill) => <SkillRow key={skill.name} skill={skill} hub={hub} />)}</>
  }

  return (
    <>
      <ProjectTree hub={hub} />
      {groupsState !== null && groupsState.collections.length === 0 ? <div className={css.empty}>{tt('groups.noCollections')}</div> : null}
      {groupsState?.collections.map((collection) => {
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
          <section key={'col:' + collection.name} className={css.section}>
            <div className={css.groupHead}>
              <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('col:' + collection.name) }}>
                <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                <span className={css.groupTitle}>
                  <a className={css.sourceLink} href={'https://github.com/' + collection.name} target='_blank' rel='noreferrer' onClick={(event) => { event.stopPropagation() }}>{collection.name}</a>
                  {' · ' + collection.skillNames.length}
                  <GroupSummary members={collection.skillNames} hub={hub} />
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
                <button type='button' role='switch' aria-checked={view.state !== 'off'} aria-label={collection.name}
                  className={css.switch + (view.state === 'on' ? ' ' + css.switchOn : view.state === 'mixed' ? ' ' + css.switchMixed : '')}
                  disabled={batchBusy || collection.skillNames.length === 0 || (view.state !== 'off' && !hasWritable)}
                  title={view.state !== 'off' && !hasWritable ? tt('groups.noWritable') : undefined}
                  onClick={(event) => { event.stopPropagation(); toggleGroup('col:' + collection.name, collection.name, view.state) }}>
                  <span className={css.switchThumb} />
                </button>
              </span>
            </div>
            {!collapsed ? (
              <>
                {skills.map((skill) => <SkillRow key={skill.name} skill={skill} hub={hub} />)}
                {disabledMembers.map((record) => (
                  <DisabledRow key={record.name} record={record} busy={busyNames.has(record.name)} onEnable={() => { void enableDisabled(record) }} />
                ))}
              </>
            ) : null}
          </section>
        )
      })}
      {(() => {
        // 「个人」组：无来源记录 且 非项目技能（项目技能归项目树）。
        const uncategorized = filterBySource(sorted, sourceFilter, origins).filter((skill) => origins[skill.name] === undefined && !isProjectSource(skill.source))
        if (uncategorized.length === 0) return null
        const collapsed = collapsedGroups.has('uncategorized-source')
        return (
          <section className={css.section}>
            <div className={css.groupHead}>
              <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('uncategorized-source') }}>
                <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                <span className={css.groupTitle}>
                  {tt('groups.personal')} · {uncategorized.length}
                  <GroupSummary members={uncategorized.map((skill) => skill.name)} hub={hub} />
                </span>
              </button>
            </div>
            {!collapsed ? uncategorized.map((skill) => <SkillRow key={skill.name} skill={skill} hub={hub} />) : null}
          </section>
        )
      })()}
    </>
  )
}
