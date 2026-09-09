/**
 * The tri-state group switch shared by the source cards and the scene cards:
 * one switch whose state is derived from the group's members (all enabled →
 * 'on', none → 'off', otherwise 'mixed'). Only the group identity, its member
 * count and the toggle callback differ between the two call sites.
 */

import type { JSX, MouseEvent } from 'react'
import type { GroupSwitchState } from '../grouping.ts'
import { tt } from '../helpers.ts'
import css from './panel.module.css'

/** Props one group switch needs: the derived state plus its group identity. */
export interface GroupSwitchButtonProps {
  /** Derived switch state of the group (all/none/some members enabled). */
  state: GroupSwitchState
  /** Accessible name of the group (aria-label). */
  label: string
  /** Member count; an empty group cannot be toggled. */
  memberCount: number
  /** True while a batch toggle is in flight. */
  batchBusy: boolean
  /** True when at least one member is writable. */
  hasWritable: boolean
  /** Toggle the whole group; the click's stopPropagation is applied here. */
  onToggle: () => void
}

export function GroupSwitchButton(props: GroupSwitchButtonProps): JSX.Element {
  const { state, label, memberCount, batchBusy, hasWritable, onToggle } = props
  return (
    <button type='button' role='switch' aria-checked={state !== 'off'} aria-label={label}
      className={css.switch + (state === 'on' ? ' ' + css.switchOn : state === 'mixed' ? ' ' + css.switchMixed : '')}
      disabled={batchBusy || memberCount === 0 || (state !== 'off' && !hasWritable)}
      title={state !== 'off' && !hasWritable ? tt('groups.noWritable') : undefined}
      onClick={(event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onToggle() }}>
      <span className={css.switchThumb} />
    </button>
  )
}
