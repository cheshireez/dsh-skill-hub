/**
 * Source check-status badges (up-to-date / updated / deleted / error /
 * throttled / unverified). Shared by the panel's source-group headers and
 * the skill detail view.
 *
 * In the group headers the badge doubles as the re-check affordance: it
 * shows a clickable "检查更新" badge before the first check, "检查中…" while
 * checking, and the status badge (clickable again to re-check) afterwards.
 */

import type { JSX } from 'react'
import type { SourceCheckResult } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import css from './panel.module.css'

export function SourceStatusBadge(props: {
  check: SourceCheckResult | undefined
  /** 正在检查该来源（显示「检查中…」）。 */
  checking?: boolean
  /** 提供后徽章区域可点击触发检查（组头用；详情页有自己的检查按钮）。 */
  onCheck?: () => void
}): JSX.Element | null {
  const { check, checking, onCheck } = props
  if (checking === true) {
    return <span className={css.statusBadge}>{tt('source.checking')}</span>
  }
  if (check === undefined) {
    if (onCheck === undefined) return null
    return (
      <button type='button' className={css.statusBadge + ' ' + css.statusButton} title={tt('source.checkHint')} onClick={onCheck}>
        {tt('source.check')}
      </button>
    )
  }
  const badges = ((): JSX.Element | null => {
    if (check.error !== undefined) {
      return <span className={css.statusBadge + ' ' + css.statusError}>{tt('source.error')}</span>
    }
    if (check.throttled === true) {
      return <span className={css.statusBadge}>{tt('source.throttled')}</span>
    }
    if (check.unverified === true) {
      return <span className={css.statusBadge}>{tt('source.unverified')}</span>
    }
    if (check.changed) {
      return (
        <span className={css.statusBadges}>
          {check.updated.length > 0 ? <span className={css.statusBadge + ' ' + css.statusUpdated}>{tt('source.updated', { count: check.updated.length })}</span> : null}
          {check.deleted.length > 0 ? <span className={css.statusBadge + ' ' + css.statusError}>{tt('source.deleted', { count: check.deleted.length })}</span> : null}
        </span>
      )
    }
    return <span className={css.statusBadge + ' ' + css.statusOk}>{tt('source.upToDate')}</span>
  })()
  if (onCheck === undefined) return badges
  return (
    <button type='button' className={css.statusWrap} title={tt('source.checkHint')} onClick={onCheck}>
      {badges}
    </button>
  )
}
