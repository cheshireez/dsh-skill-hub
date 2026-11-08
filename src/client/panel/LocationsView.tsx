/**
 * General tab, location view: one card per discovery root — the directory a
 * skill's files actually live in (`~/.dsh/skills`, `~/.agents/skills`, the
 * Codex / Claude / CC Switch roots, …).
 *
 * Location is the third axis: the origin collections group skills by the
 * upstream repo they were installed from, roles are hand-curated, and this view
 * answers "what is installed where". Project skills stay in the workspace tab,
 * which groups them by workspace path instead.
 */

import { useMemo, type JSX } from 'react'
import { tt } from '../helpers.ts'
import { filterBySource, groupByLocation, groupSwitchView, type GroupSwitchState, type LocationGroup } from '../grouping.ts'
import { SkillRows } from './SkillRows.tsx'
import { GroupSummary } from './GroupSummary.tsx'
import { GroupSwitchButton } from './GroupSwitchButton.tsx'
import { GroupHeader } from './GroupHeader.tsx'
import { GroupSection } from './GroupSection.tsx'
import { locationLabel } from './source-label.ts'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export function LocationsView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const { catalog, collapsedGroups, viewNames, actionNames, batchBusy, busyNames, toggleGroupCollapse } = hub
  const duplicateNames = useMemo(() => new Set(catalog?.duplicateNames ?? []), [catalog])
  // The upstream-origin filter applies here too (same as the source view);
  // `hub.sorted` already carries search + invocation + status + sort order.
  const scoped = filterBySource(hub.sorted, hub.sourceFilter, hub.origins)
  const groups = groupByLocation(scoped)
  // The card title already names the root, so the per-row root badge is noise here.
  const rowProps = { uses: hub.uses, hubConfig: hub.hubConfig, busyNames, editMode: hub.editMode, tagBusy: hub.tagBusy, duplicateNames, statusFilter: hub.statusFilter, hideSourceBadge: true, toggle: hub.toggle, openDetail: hub.openDetail, requestDeleteSkill: hub.requestDeleteSkill }

  /**
   * Whole-root toggle. This deliberately bypasses `toggleGroup`: that one
   * resolves members from the tag/collection map and runs the cross-group
   * conflict check, neither of which applies to a discovery root (the same
   * skill legitimately lives in exactly one root, and also in a role).
   */
  const toggleLocation = (group: LocationGroup, state: GroupSwitchState): void => {
    const names = group.skills.map((skill) => skill.name).filter((name) => actionNames.has(name))
    if (names.length === 0) return
    void hub.batchToggleNames(names, state === 'off')
  }

  if (groups.length === 0) return <div className={css.empty}>{tt('panel.empty')}</div>
  return (
    <>
      {groups.map((group) => {
        const name = locationLabel(group.id)
        const key = 'loc:' + group.id
        const collapsed = collapsedGroups.has(key)
        const memberNames = group.skills.map((skill) => skill.name)
        const view = groupSwitchView(memberNames, viewNames)
        const hasWritable = memberNames.some((member) => actionNames.has(member))
        return (
          <GroupSection key={key}>
            <GroupHeader
              title={<>{name} · {group.skills.length}<GroupSummary members={memberNames} uses={hub.uses} hubConfig={hub.hubConfig} /></>}
              collapsed={collapsed}
              onToggle={() => { toggleGroupCollapse(key) }}
              actions={
                <GroupSwitchButton
                  state={view.state}
                  label={name}
                  memberCount={memberNames.length}
                  batchBusy={batchBusy}
                  hasWritable={hasWritable}
                  onToggle={() => { toggleLocation(group, view.state) }}
                />
              }
            />
            {!collapsed ? <SkillRows skills={group.skills} rowProps={rowProps} /> : null}
          </GroupSection>
        )
      })}
    </>
  )
}
