/**
 * 上移/下移按钮：拖拽排序的键盘替代。编辑模式下才渲染，首/末项自动禁用。
 * 三个调用点（项目卡片、来源集合卡片、场景卡片）共用同一套可访问性语义。
 */

import type { JSX, MouseEvent } from 'react'
import { tt } from '../helpers.ts'
import css from './panel.module.css'

/** Props one reorder pair needs: current position edges plus the move callback. */
export interface ReorderButtonsProps {
  /** False when the item is already first. */
  canMoveUp: boolean
  /** False when the item is already last. */
  canMoveDown: boolean
  /** Move the item one slot; -1 = up, 1 = down. */
  onMove: (direction: -1 | 1) => void
}

export function ReorderButtons(props: ReorderButtonsProps): JSX.Element {
  const { canMoveUp, canMoveDown, onMove } = props
  return (
    <>
      <button
        type='button'
        className={css.opBtn + ' ' + css.iconBtn}
        disabled={!canMoveUp}
        aria-label={tt('reorder.up')}
        title={tt('reorder.up')}
        onClick={(event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onMove(-1) }}
      >↑</button>
      <button
        type='button'
        className={css.opBtn + ' ' + css.iconBtn}
        disabled={!canMoveDown}
        aria-label={tt('reorder.down')}
        title={tt('reorder.down')}
        onClick={(event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onMove(1) }}
      >↓</button>
    </>
  )
}
