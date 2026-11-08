/** Centered create-skill dialog; mirrors Skills Manager's modal flow. */
import type { FormEvent, JSX } from 'react'
import type { WritableRoot } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import { DialogShell } from './dialogs.tsx'
import css from './panel.module.css'

export interface CreateSkillDialogProps {
  name: string
  desc: string
  body: string
  root: WritableRoot
  workspace: string
  workspaces: ReadonlyArray<{ path: string; title: string }>
  busy: boolean
  message: { kind: 'error' | 'success'; text: string } | null
  onNameChange: (value: string) => void
  onDescChange: (value: string) => void
  onBodyChange: (value: string) => void
  onWorkspaceChange: (value: string) => void
  onRootChange: (value: WritableRoot) => void
  onSubmit: (event: FormEvent) => void
  onClose: () => void
}

export function CreateSkillDialog(props: CreateSkillDialogProps): JSX.Element {
  const { name, desc, body, root, workspace, workspaces, busy, message, onNameChange, onDescChange, onBodyChange, onWorkspaceChange, onRootChange, onSubmit, onClose } = props
  const canSubmit = name.trim().length > 0 && desc.trim().length > 0 && body.trim().length > 0
  return (
    <DialogShell onClose={onClose} role='dialog' className={css.createDialog}>
      <form className={css.createForm} onSubmit={onSubmit} aria-label={tt('form.createTitle')}>
        <h3 className={css.dialogTitle}>{tt('form.createTitle')}</h3>
        <p className={css.dialogText}>{tt('form.createNote')}</p>
        <div className={css.formRow}>
          <label className={css.formLabel}>{tt('form.name')}</label>
          <input className={css.input} value={name} onChange={(event) => { onNameChange(event.target.value) }} placeholder='code-review' autoFocus />
        </div>
        <div className={css.formRow}>
          <label className={css.formLabel}>{tt('form.desc')}</label>
          <input className={css.input} value={desc} onChange={(event) => { onDescChange(event.target.value) }} placeholder={tt('form.descPlaceholder')} />
        </div>
        <div className={css.formRow}>
          <label className={css.formLabel}>{tt('form.body')}</label>
          <textarea className={css.input + ' ' + css.createBody} value={body} onChange={(event) => { onBodyChange(event.target.value) }} placeholder={tt('form.bodyPlaceholder')} rows={8} />
        </div>
        <div className={css.formRow}>
          <label className={css.formLabel}>{tt('form.root')}</label>
          <select className={css.select} value={workspace !== '' ? 'workspace:' + workspace : root} onChange={(event) => {
            const value = event.target.value
            if (value.startsWith('workspace:')) {
              onWorkspaceChange(value.slice('workspace:'.length))
            } else {
              onWorkspaceChange('')
              onRootChange(value as WritableRoot)
            }
          }}>
            <option value='user-dsh'>~/.dsh/skills</option>
            <option value='user-agents'>~/.agents/skills</option>
            {workspaces.map((entry) => <option key={entry.path} value={'workspace:' + entry.path}>{entry.title}</option>)}
          </select>
        </div>
        {message !== null ? <div className={message.kind === 'error' ? css.formError : css.formSuccess}>{message.text}</div> : null}
        <div className={css.dialogActions}>
          <button type='button' className={css.button} onClick={onClose}>{tt('form.cancel')}</button>
          <button type='submit' className={css.button + ' ' + css.primary} disabled={busy || !canSubmit}>{busy ? tt('form.busy') : tt('form.submit')}</button>
        </div>
      </form>
    </DialogShell>
  )
}
