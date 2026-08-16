/**
 * Shared display helpers for the panel views (skill rows, detail view, and
 * dialogs): dot color styling, relative/absolute time text, and commit-SHA
 * shortening. Kept in one place so the views render identically.
 */

import type { CSSProperties } from 'react'
import { formatRelativeTime } from '../grouping.ts'
import { tt } from '../helpers.ts'

/** Dot inline style from the user-chosen color (undefined keeps the CSS default). */
export function dotStyle(color: string | undefined): CSSProperties | undefined {
  if (color === undefined) return undefined
  return { background: color, borderColor: color }
}

/** Localized relative-time text for a Unix-ms timestamp. */
export function relativeTimeText(ms: number): string {
  const rt = formatRelativeTime(ms)
  return tt(rt.key, rt.value !== undefined ? { value: rt.value } : undefined)
}

/** Localized absolute time for the detail meta (e.g. "2026/8/16 11:00:00"). */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

/** Short form of a commit SHA for display. */
export function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha
}
