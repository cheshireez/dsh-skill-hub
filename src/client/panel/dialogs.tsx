/**
 * Shared dialog family for the panel: one overlay shell plus the specific
 * dialogs (group-close conflict, sync/delete confirm, branch picker, and
 * market sync selection). Every dialog closes on outside click and keeps
 * the same role/aria shell; the panel owns all dialog state.
 */

import { useEffect, type JSX, type ReactNode } from 'react'
import type { CollectionGroup, SkillTag } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import { groupNamesOf } from '../grouping.ts'
import css from './panel.module.css'

/** A group-close conflict waiting for the user's decision. */
export interface ConflictDialogState {
  /** Group key: 'tag:<id>' or 'col:<name>'. */
  key: string
  name: string
  /** Conflicting skill names (enabled here and in other groups). */
  conflicts: string[]
}

/** A destructive/sync confirmation waiting for the user's decision. */
export interface ConfirmDialogState {
  kind: 'sync' | 'delete'
  repo: string
  /** Skills the action applies to. */
  skills: string[]
}

/** Branch picker shown when a repo has no release and no pinned ref. */
export interface BranchChoiceState {
  repo: string
  branches: string[]
  selected: string
}

/** Post-sync skill update dialog: which tracked skills to refresh. */
export interface MarketSyncDialogState {
  repo: string
  ref: string
  skills: string[]
  selected: ReadonlySet<string>
}

/** Overlay + centered alert-dialog shell; outside click or Escape cancels. */
function DialogShell(props: { onClose: () => void; children: ReactNode }): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  })
  return (
    <div className={css.dialogOverlay} onClick={props.onClose}>
      <div className={css.dialog} role='alertdialog' aria-modal='true' onClick={(event) => { event.stopPropagation() }}>
        {props.children}
      </div>
    </div>
  )
}

/** Simple confirm dialog: title + text + optional skill list + cancel/confirm. */
export function ConfirmDialog(props: {
  title: string
  text: string
  /** Optional skill names listed between the text and the buttons. */
  items?: readonly string[]
  confirmLabel: string
  /** Danger-styled confirm button (destructive actions). */
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const { title, text, items, confirmLabel, danger, onCancel, onConfirm } = props
  return (
    <DialogShell onClose={onCancel}>
      <h3 className={css.dialogTitle}>{title}</h3>
      <p className={css.dialogText}>{text}</p>
      {items !== undefined ? (
        <ul className={css.dialogList}>
          {items.map((name) => <li key={name}><span className={css.rowNameText}>{name}</span></li>)}
        </ul>
      ) : null}
      <div className={css.dialogActions}>
        <button type='button' className={css.button} onClick={onCancel}>{tt('form.cancel')}</button>
        <button type='button' className={css.button + (danger === true ? ' ' + css.danger : ' ' + css.primary)} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </DialogShell>
  )
}

/** Group-close conflict: which skills stay on, and which other groups also enable them. */
export function ConflictDialog(props: {
  dialog: ConflictDialogState
  tags: readonly SkillTag[]
  collections: readonly CollectionGroup[]
  onClose: () => void
  onKeepOn: () => void
  onCloseAll: () => void
}): JSX.Element {
  const { dialog, tags, collections, onClose, onKeepOn, onCloseAll } = props
  return (
    <DialogShell onClose={onClose}>
      <h3 className={css.dialogTitle}>{tt('groups.conflictTitle')}</h3>
      <p className={css.dialogText}>{tt('groups.conflictText')}</p>
      <ul className={css.dialogList}>
        {dialog.conflicts.map((name) => (
          <li key={name}>
            <span className={css.rowNameText}>{name}</span>
            {' — ' + groupNamesOf(name, [...tags], [...collections]).join(', ')}
          </li>
        ))}
      </ul>
      <div className={css.dialogActions}>
        <button type='button' className={css.button} onClick={onKeepOn}>{tt('groups.keepOn')}</button>
        <button type='button' className={css.button + ' ' + css.primary} onClick={onCloseAll}>{tt('groups.closeAll')}</button>
      </div>
    </DialogShell>
  )
}

/** Branch picker for a repo without releases (pins the ref, then rescans). */
export function BranchChoiceDialog(props: {
  choice: BranchChoiceState
  busy: boolean
  onSelect: (branch: string) => void
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const { choice, busy, onSelect, onCancel, onConfirm } = props
  return (
    <DialogShell onClose={onCancel}>
      <h3 className={css.dialogTitle}>{tt('market.branchTitle')}</h3>
      <p className={css.dialogText}>{tt('market.branchHint')}</p>
      <select className={css.select + ' ' + css.dialogSelect} value={choice.selected}
        onChange={(event) => { onSelect(event.target.value) }}>
        {choice.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
      </select>
      <div className={css.dialogActions}>
        <button type='button' className={css.button} onClick={onCancel}>{tt('form.cancel')}</button>
        <button type='button' className={css.button + ' ' + css.primary} disabled={busy} onClick={onConfirm}>{tt('market.branchConfirm')}</button>
      </div>
    </DialogShell>
  )
}

/** Post-sync selection: which tracked skills to batch-update to the new version. */
export function MarketSyncDialog(props: {
  dialog: MarketSyncDialogState
  busy: boolean
  onToggle: (name: string, checked: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const { dialog, busy, onToggle, onCancel, onConfirm } = props
  return (
    <DialogShell onClose={onCancel}>
      <h3 className={css.dialogTitle}>{tt('market.syncTitle')}</h3>
      <p className={css.dialogText}>{tt('market.syncText', { ref: dialog.ref })}</p>
      {dialog.skills.length === 0 ? (
        <p className={css.dialogText}>{tt('market.syncNone')}</p>
      ) : (
        <div className={css.dialogList}>
          {dialog.skills.map((name) => (
            <label key={name} className={css.dialogRow}>
              <input type='checkbox' checked={dialog.selected.has(name)}
                onChange={(event) => { onToggle(name, event.target.checked) }} />
              <span className={css.rowNameText}>{name}</span>
            </label>
          ))}
        </div>
      )}
      <div className={css.dialogActions}>
        <button type='button' className={css.button} onClick={onCancel}>{tt('market.syncCancel')}</button>
        <button type='button' className={css.button + ' ' + css.primary} disabled={busy || dialog.skills.length === 0} onClick={onConfirm}>
          {busy ? tt('source.syncing') : tt('source.sync')}
        </button>
      </div>
    </DialogShell>
  )
}
