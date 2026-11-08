/**
 * GroupSection — 统一的 inset 分组容器。所有一级/二级分组卡片都走这里，
 * 保证 section 边框、圆角和拖拽态只有一套实现。
 */

import type { ReactNode, JSX } from 'react'
import type { DragReorderProps } from './useDragReorder.ts'
import css from './panel.module.css'

export interface GroupSectionProps {
  children: ReactNode
  /** 可选拖拽 props；未传时渲染为不可拖动的普通分组。 */
  dragProps?: DragReorderProps
  className?: string
}

export function GroupSection(props: GroupSectionProps): JSX.Element {
  const { children, dragProps, className } = props
  const classes = [css.section, dragProps?.className, className].filter((value): value is string => value !== undefined && value !== '').join(' ')
  return (
    <section {...(dragProps ?? {})} className={classes}>
      {children}
    </section>
  )
}
