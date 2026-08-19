/**
 * Shared display helpers for the panel views (skill rows, detail view, and
 * dialogs): dot color styling, relative/absolute time text, and commit-SHA
 * shortening. Kept in one place so the views render identically.
 *
 * The invocation-status dot defaults live here (not in the settings card) so
 * both the panel legend and the chat `/` skill menu draw from one source and
 * so this primitives-free module stays unit-testable.
 */

import type { CSSProperties } from 'react'
import { formatRelativeTime } from '../grouping.ts'
import { tt } from '../helpers.ts'

/** Model-invocable dot color default. Single source for the TS side; the
 *  panel's CSS mirrors it via --hub-model (panel.module.css). */
export const DEFAULT_DOT_MODEL_COLOR = '#2f81f7'
/** User-invocable dot color default. Single source for the TS side; the
 *  panel's CSS mirrors it via --hub-user (panel.module.css). */
export const DEFAULT_DOT_USER_COLOR = '#3fb950'

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
