/**
 * Group-header usage summary: total invocation count chip + the group's most
 * recent last-used time. Honours the showGroupSummary config switch.
 */

import type { JSX } from 'react'
import type { HubConfig } from '../../protocol.ts'
import { relativeTimeText } from './format.ts'
import css from './panel.module.css'

/** The narrowed hub surface one group summary consumes. */
export interface GroupSummaryProps {
  /** The group's member skill names. */
  members: readonly string[]
  /** skillName → usage stats. */
  uses: ReadonlyMap<string, { count: number; lastUsed?: number }>
  /** Effective hub config; null while it has not loaded. */
  hubConfig: HubConfig | null
}

export function GroupSummary(props: GroupSummaryProps): JSX.Element {
  const { members, uses, hubConfig } = props
  let total = 0
  let latest: number | undefined
  for (const name of members) {
    const stat = uses.get(name)
    if (stat === undefined) continue
    total += stat.count
    if (stat.lastUsed !== undefined && (latest === undefined || stat.lastUsed > latest)) latest = stat.lastUsed
  }
  return (
    <span className={css.groupTitleInner}>
      {hubConfig?.showGroupSummary !== false && total > 0 ? <span className={css.useCount}>{total}</span> : null}
      {hubConfig?.showGroupSummary !== false && latest !== undefined ? <span className={css.useTime + ' ' + css.groupTime}>{relativeTimeText(latest)}</span> : null}
    </span>
  )
}
