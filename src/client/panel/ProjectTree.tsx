/**
 * ProjectTree — 项目级顶层卡片：把项目技能按 workspace 聚合（可折叠），
 * 并支持按 .dsh/.agents 细分两层。顶层拖拽 props 由 SourcesView 传入，
 * 拖拽排序状态与回调仍归 SourcesView 所有。
 */

import type { JSX } from 'react'
import type { CatalogSkill } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import { SkillRow, type SkillRowProps } from './SkillRow.tsx'
import { GroupSummary } from './GroupSummary.tsx'
import { ReorderButtons } from './ReorderButtons.tsx'
import type { DragReorderProps } from './useDragReorder.ts'
import css from './panel.module.css'

export interface ProjectTreeProps {
  /** 项目级技能（已按来源筛选）。 */
  skills: CatalogSkill[]
  /** 折叠的树键（'project' / 'project:<workspace>' / 'project:<workspace>:<source>'）。 */
  collapsedGroups: ReadonlySet<string>
  toggleGroupCollapse: (key: string) => void
  /** 已细分（按 .dsh/.agents）的项目键。 */
  subdividedProjects: ReadonlySet<string>
  toggleSubdivide: (key: string) => void
  /** SkillRow 收窄后的 props（skill 由行内传入）；uses / hubConfig 也取自它。 */
  rowProps: Omit<SkillRowProps, 'skill'>
  /** 顶层拖拽 props（SourcesView 的 useDragReorder 产出）。 */
  dragProps: DragReorderProps
  /** 编辑模式（显示上移/下移按钮）。 */
  editMode: boolean
  /** 顶层排序位置边界。 */
  canMoveUp: boolean
  canMoveDown: boolean
  /** 键盘排序：-1 上移，1 下移。 */
  onMove: (direction: -1 | 1) => void
}

export function ProjectTree(props: ProjectTreeProps): JSX.Element {
  const { skills, collapsedGroups, toggleGroupCollapse, subdividedProjects, toggleSubdivide, rowProps, dragProps, editMode, canMoveUp, canMoveDown, onMove } = props
  const topCollapsed = collapsedGroups.has('project')
  // 按 workspace 聚合，与拆分前逻辑一致
  const byProject = new Map<string, { title: string; skills: CatalogSkill[] }>()
  for (const skill of skills) {
    const key = skill.workspace ?? skill.source
    const entry = byProject.get(key)
    if (entry === undefined) byProject.set(key, { title: skill.workspaceTitle ?? skill.workspace ?? tt('groups.project'), skills: [skill] })
    else entry.skills.push(skill)
  }
  return (
    <section {...dragProps}>
      <div className={css.groupHead}>
        <span className={css.dragHandle} aria-hidden title={tt('drag.reorder')}>⋮⋮</span>
        <button type='button' className={css.disclosure} aria-expanded={!topCollapsed} onClick={() => { toggleGroupCollapse('project') }}>
          <span className={css.chevron + (topCollapsed ? ' ' + css.chevronCollapsed : '')} />
          <span className={css.groupTitle}>{tt('groups.project')} · {byProject.size}</span>
        </button>
        {editMode ? (
          <span className={css.groupOps}>
            <ReorderButtons canMoveUp={canMoveUp} canMoveDown={canMoveDown} onMove={onMove} />
          </span>
        ) : null}
      </div>
      {!topCollapsed ? [...byProject.entries()].map(([key, proj]) => {
        const projKey = 'project:' + key
        const projCollapsed = collapsedGroups.has(projKey)
        const subdivided = subdividedProjects.has(key)
        return (
          <div key={projKey} className={css.projectNest}>
            <div className={css.groupHead}>
              <button type='button' className={css.disclosure} aria-expanded={!projCollapsed} onClick={() => { toggleGroupCollapse(projKey) }}>
                <span className={css.chevron + (projCollapsed ? ' ' + css.chevronCollapsed : '')} />
                <span className={css.groupTitle}>{proj.title} · {proj.skills.length}<GroupSummary members={proj.skills.map((s) => s.name)} uses={rowProps.uses} hubConfig={rowProps.hubConfig} /></span>
              </button>
              <span className={css.groupOps}>
                <button type='button' className={css.opBtn} onClick={(event) => { event.stopPropagation(); toggleSubdivide(key) }}>{subdivided ? tt('groups.merge') : tt('groups.subdivide')}</button>
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
