/**
 * Group-header usage summary: total invocation count chip + the group's most
 * recent last-used time. Honours the showGroupSummary config switch.
 */

import type { JSX } from 'react'
import { relativeTimeText } from './format.ts'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export function GroupSummary(props: { members: readonly string[]; hub: SkillHubState }): JSX.Element {
  const { members, hub } = props
  let total = 0
  let latest: number | undefined
  for (const name of members) {
    const stat = hub.uses.get(name)
    if (stat === undefined) continue
    total += stat.count
    if (stat.lastUsed !== undefined && (latest === undefined || stat.lastUsed > latest)) latest = stat.lastUsed
  }
  return (
    <span className={css.groupTitleInner}>
      {hub.hubConfig?.showGroupSummary !== false && total > 0 ? <span className={css.useCount}>{total}</span> : null}
      {hub.hubConfig?.showGroupSummary !== false && latest !== undefined ? <span className={css.useTime + ' ' + css.groupTime}>{relativeTimeText(latest)}</span> : null}
    </span>
  )
}
