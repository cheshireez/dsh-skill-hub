/**
 * CollectionCard — 一个上游来源集合卡片：组头（来源链接 + 成员数 + 用量
 * 汇总）、检查/同步/跟删徽章、三态开关、编辑态删除分组，以及展开后的
 * 启用行与禁用行。数据、动作与顶层拖拽 props 均由 SourcesView 传入。
 */

import type { JSX } from 'react'
import type { CatalogSkill, CollectionGroup, DisabledSkill, SourceCheckResult } from '../../protocol.ts'
import type { GroupSwitchView } from '../grouping.ts'
import { tt } from '../helpers.ts'
import { SourceStatusBadge } from './SourceStatusBadge.tsx'
import { SkillRow, type SkillRowProps } from './SkillRow.tsx'
import { DisabledRow } from './DisabledRow.tsx'
import { GroupSummary } from './GroupSummary.tsx'
import { GroupSwitchButton } from './GroupSwitchButton.tsx'
import type { DragReorderProps } from './useDragReorder.ts'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export interface CollectionCardProps {
  collection: CollectionGroup
  /** 该集合内已启用、且通过筛选的技能。 */
  skills: CatalogSkill[]
  /** 该集合内已禁用、且通过筛选的记录。 */
  disabledMembers: DisabledSkill[]
  /** 该集合卡片是否折叠。 */
  collapsed: boolean
  /** 成员开关状态（groupSwitchView 派生）。 */
  view: GroupSwitchView
  /** 该来源的上游检查结果。 */
  check: SourceCheckResult | undefined
  /** 组内至少一个成员可写（三态开关可点）。 */
  hasWritable: boolean
  /** 编辑模式（显示删除分组）。 */
  editMode: boolean
  /** 正在检查的来源名。 */
  checkingSource: string | null
  /** 正在同步的来源名。 */
  syncingSource: string | null
  /** 整组操作忙碌。 */
  batchBusy: boolean
  /** SkillRow / DisabledRow 共用的收窄 props（skill/record 由行内传入）。 */
  rowProps: Omit<SkillRowProps, 'skill'>
  /** 顶层拖拽 props（SourcesView 的 useDragReorder 产出）。 */
  dragProps: DragReorderProps
  toggleGroupCollapse: SkillHubState['toggleGroupCollapse']
  checkSources: SkillHubState['checkSources']
  requestSync: SkillHubState['requestSync']
  requestDelete: SkillHubState['requestDelete']
  toggleGroup: SkillHubState['toggleGroup']
  requestDeleteGroup: SkillHubState['requestDeleteGroup']
  enableDisabled: SkillHubState['enableDisabled']
  openDetail: SkillHubState['openDetail']
}

export function CollectionCard(props: CollectionCardProps): JSX.Element {
  const {
    collection, skills, disabledMembers, collapsed, view, check, hasWritable, editMode,
    checkingSource, syncingSource, batchBusy, rowProps, dragProps,
    toggleGroupCollapse, checkSources, requestSync, requestDelete, toggleGroup, requestDeleteGroup, enableDisabled, openDetail,
  } = props
  const { busyNames, duplicateNames, uses, hubConfig } = rowProps
  return (
    <section {...dragProps}>
      <div className={css.groupHead}>
        <span className={css.dragHandle} aria-hidden title={tt('drag.reorder')}>⋮⋮</span>
        <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('col:' + collection.name) }}>
          <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
          <span className={css.groupTitle}>
            <a className={css.sourceLink} href={'https://github.com/' + collection.name} target='_blank' rel='noreferrer' onClick={(event) => { event.stopPropagation() }}>{collection.name}</a>
            {' · ' + collection.skillNames.length}
            <GroupSummary members={collection.skillNames} uses={uses} hubConfig={hubConfig} />
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
          {editMode ? <button
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
            <DisabledRow key={record.name} record={record} busy={busyNames.has(record.name)} duplicate={duplicateNames.has(record.name)} onEnable={() => { void enableDisabled(record) }} onOpen={() => { void openDetail(record.name) }} />
          ))}
        </>
      ) : null}
    </section>
  )
}
