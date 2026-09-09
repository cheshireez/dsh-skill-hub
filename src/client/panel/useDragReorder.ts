/**
 * Drag-reorder wiring shared by the top-level group cards and the scene cards:
 * one draggable container per key, with the section/dragging/dragOver class
 * composition and the drag handler sequence kept in a single place. The
 * dragged/drag-over state and the reorder callback stay owned by the list.
 */

import type { DragEvent } from 'react'
import css from './panel.module.css'

/** Props one draggable reorder container spreads onto its element. */
export interface DragReorderProps {
  className: string
  draggable: true
  onDragStart: (event: DragEvent<HTMLElement>) => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDragLeave: () => void
  onDrop: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}

/** The drag state and reorder callback one list owns. */
export interface DragReorderOptions {
  /** Key of the container currently being dragged, or null. */
  dragKey: string | null
  /** Key of the container currently hovered by a drag, or null. */
  overKey: string | null
  setDragKey: (key: string | null) => void
  setOverKey: (key: string | null) => void
  /** Commit moving the dragged container onto `key` (the drop target). */
  onDrop: (key: string) => void
}

/**
 * Build the drag-reorder props for one container key.
 * @param options - the list's drag state and its reorder callback.
 * @returns a factory producing the props for a given container key.
 */
export function useDragReorder(options: DragReorderOptions): (key: string) => DragReorderProps {
  const { dragKey, overKey, setDragKey, setOverKey, onDrop } = options
  return (key: string): DragReorderProps => {
    const isDragging = dragKey === key
    const isOver = overKey === key && dragKey !== key
    return {
      className: css.section + (isDragging ? ' ' + css.dragging : '') + (isOver ? ' ' + css.dragOver : ''),
      draggable: true,
      onDragStart: (event) => { setDragKey(key); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', key) },
      onDragOver: (event) => { event.preventDefault(); if (overKey !== key) setOverKey(key) },
      onDragLeave: () => { if (overKey === key) setOverKey(null) },
      onDrop: (event) => { event.preventDefault(); onDrop(key); setOverKey(null) },
      onDragEnd: () => { setDragKey(null); setOverKey(null) },
    }
  }
}
