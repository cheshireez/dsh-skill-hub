/**
 * One disabled skill row (name + description + root badge + enable switch).
 * Shared by the source-group lists, the scene-group lists, and the bottom
 * disabled section.
 */

import type { JSX } from 'react'
import type { DisabledSkill, WritableRoot } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import type { HubKey } from '../locales.ts'
import css from './panel.module.css'

/** Source badge label for a disabled record, derived from its writable root. */
function disabledSourceLabel(root: WritableRoot): string {
  return tt(('badge.source.' + root) as HubKey)
}

export function DisabledRow(props: { record: DisabledSkill; busy: boolean; onEnable: () => void }): JSX.Element {
  const { record, busy, onEnable } = props
  return (
    <div className={css.row + ' ' + css.rowStatic}>
      <div className={css.rowMain}>
        <div className={css.rowName}>{record.name}</div>
        <div className={css.rowDesc}>{record.description}</div>
      </div>
      <span className={css.badges}>
        <span className={css.badge + ' ' + css.badgeSource}>{disabledSourceLabel(record.root)}</span>
      </span>
      <button type='button' role='switch' aria-checked={false} aria-label={tt('row.enable')} className={css.switch} disabled={busy} onClick={onEnable}><span className={css.switchThumb} /></button>
    </div>
  )
}
