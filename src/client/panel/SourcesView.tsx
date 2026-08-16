/**
 * Sources tab: the flat skill list or the grouped view (one card per
 * upstream collection with check/sync/follow-delete actions and the
 * tri-state switch, plus the uncategorized "personal" card).
 */

import type { JSX } from 'react'
import { tt } from '../helpers.ts'
import { filterBySource, groupSwitchView, PRIVATE_SOURCE } from '../grouping.ts'
import { SourceStatusBadge } from './SourceStatusBadge.tsx'
import { SkillRow } from './SkillRow.tsx'
import { DisabledRow } from './DisabledRow.tsx'
import { GroupSummary } from './GroupSummary.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export function SourcesView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const { catalog, groupsState, skillView, sourceFilter, origins, sorted, normalized, collapsedGroups, viewNames, sourceCheck, actionNames, checkingSource, syncingSource, batchBusy, busyNames, toggleGroupCollapse, checkSources, requestSync, requestDelete, toggleGroup, enableDisabled } = hub

  if (skillView === 'flat') {
    return <>{filterBySource(sorted, sourceFilter, origins).map((skill) => <SkillRow key={skill.name} skill={skill} hub={hub} />)}</>
  }

  return (
    <>
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
        const uncategorized = filterBySource(sorted, sourceFilter, origins).filter((skill) => origins[skill.name] === undefined)
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
