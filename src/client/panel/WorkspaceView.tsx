/**
 * Workspace tab: only project-level skills for the selected workspace. The
 * workspace path itself is edited from the shared filter panel, so this view
 * stays a pure project tree.
 */

import { useMemo, type JSX } from 'react'
import { tt } from '../helpers.ts'
import { isProjectSource } from '../grouping.ts'
import { ProjectTree } from './ProjectTree.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export function WorkspaceView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const projectSkills = useMemo(() => hub.sorted.filter((skill) => isProjectSource(skill.source)), [hub.sorted])
  // 必须 memo：`new Set()` 每次渲染都是新引用，行级 memo 会全部失效。
  const duplicateNames = useMemo(() => new Set(hub.catalog?.duplicateNames ?? []), [hub.catalog])
  if (projectSkills.length === 0) {
    return <div className={css.empty}>{tt('panel.workspaceEmpty')}</div>
  }
  const rowProps = {
    uses: hub.uses,
    hubConfig: hub.hubConfig,
    busyNames: hub.busyNames,
    editMode: hub.editMode,
    tagBusy: hub.tagBusy,
    duplicateNames,
    // Project skills are toggled through invocation overrides, never through
    // the disabled sidecar. Keep rows visible so the switch always represents
    // the current model-invocation state.
    statusFilter: 'all' as const,
    toggle: hub.toggle,
    openDetail: hub.openDetail,
    requestDeleteSkill: hub.requestDeleteSkill,
  }
  return (
    <ProjectTree
      editMode={hub.editMode}
      canMoveUp={false}
      canMoveDown={false}
      onMove={() => {}}
      skills={projectSkills}
      collapsedGroups={hub.collapsedGroups}
      toggleGroupCollapse={hub.toggleGroupCollapse}
      subdividedProjects={hub.subdividedProjects}
      toggleSubdivide={hub.toggleSubdivide}
      rowProps={rowProps}
    />
  )
}
