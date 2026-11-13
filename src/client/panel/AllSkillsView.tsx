/**
 * General tab, all view: a flat list of every non-project skill. Paused skills
 * stay in the catalog with `modelOverride`, so there is no separate disabled
 * row stream to merge.
 */

import { useMemo, type JSX } from 'react'
import { tt } from '../helpers.ts'
import { filterBySource, isProjectSource } from '../grouping.ts'
import { SkillRows } from './SkillRows.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export function AllSkillsView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  // `hub.sorted` already carries search + invocation + status + sort order;
  // this view only adds the source filter on top.
  const skills = useMemo(
    () => filterBySource(hub.sorted.filter((skill) => !isProjectSource(skill.source)), hub.sourceFilter, hub.origins),
    [hub.sorted, hub.sourceFilter, hub.origins],
  )
  // 必须 memo：`new Set()` 每次渲染都是新引用，会让每一行 SkillRow 的 memo
  // 全部失效（等于没加）。依赖 `hub.catalog` 在轮询去重后是稳定的。
  const duplicateNames = useMemo(() => new Set(hub.catalog?.duplicateNames ?? []), [hub.catalog])
  if (skills.length === 0) {
    return <div className={css.empty}>{tt('panel.empty')}</div>
  }
  const rowProps = { uses: hub.uses, hubConfig: hub.hubConfig, busyNames: hub.busyNames, editMode: hub.editMode, tagBusy: hub.tagBusy, duplicateNames, statusFilter: hub.statusFilter, toggle: hub.toggle, openDetail: hub.openDetail, requestDeleteSkill: hub.requestDeleteSkill }
  return <SkillRows skills={skills} rowProps={rowProps} />
}
