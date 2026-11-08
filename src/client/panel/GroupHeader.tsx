/**
 * GroupHeader — 分组头部的统一骨架：可选的拖拽把手、折叠按钮、标题和右侧操作。
 * 组标题可以带链接/统计等富内容；交互内容由调用方通过 ReactNode 传入。
 */

import type { ReactNode, JSX } from 'react'
import css from './panel.module.css'

export interface GroupHeaderProps {
  title: ReactNode
  /** 折叠状态；仅在传入 onToggle 时生效。 */
  collapsed?: boolean
  /** 点击标题区域时切换折叠。 */
  onToggle?: () => void
  /** 左侧额外内容（通常是拖拽把手）。 */
  leading?: ReactNode
  /** 右侧操作区。 */
  actions?: ReactNode
}

export function GroupHeader(props: GroupHeaderProps): JSX.Element {
  const { title, collapsed = false, onToggle, leading, actions } = props
  return (
    <div className={css.groupHead}>
      {leading}
      {onToggle !== undefined ? (
        <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={onToggle}>
          <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
          <span className={css.groupTitle}>{title}</span>
        </button>
      ) : (
        <span className={css.groupTitle}>{title}</span>
      )}
      {actions !== undefined ? <span className={css.groupOps}>{actions}</span> : null}
    </div>
  )
}
