/**
 * Shared chrome for the plugin settings card, vendored from the dsh-web-ui
 * family bucket (packages/dsh-task-board/src/client/PluginSettingsCard.tsx):
 * a disclosure header naming the plugin and what its settings govern, the
 * controls inside, and the save that writes them. Renders nothing while the
 * namespace is unavailable — a deployment that does not compose the owning
 * plugin should show no trace of it.
 */

import { useState, type ReactElement } from 'react'
import type { CardShell } from './settings-form.ts'
import css from './settings-card.module.css'

/** Card-level chrome props. */
export interface PluginSettingsCardProps {
  /** Locale translator for the owning plugin's namespace. */
  t: (key: string) => string
  /** Locale key of the card title. */
  titleKey: string
  /** Locale key of the card description. */
  descriptionKey: string
  /** The form shell state. */
  state: CardShell
  onSave: () => void
  onDiscard: () => void
  children?: ReactElement | ReactElement[]
}

/**
 * Render one plugin settings card.
 * @param props - the plugin's copy keys, its form state, and its controls.
 * @returns the card, or nothing while the namespace is still loading.
 */
export function PluginSettingsCard(props: PluginSettingsCardProps): ReactElement | null {
  const [open, setOpen] = useState(false)
  const { state } = props
  if (!state.available) return null
  const title = props.t(props.titleKey)
  const blocked = !state.dirty || state.invalid || state.saving

  const header = (
    <button
      type='button'
      className={css.header}
      aria-expanded={open}
      aria-label={props.t(open ? 'settings.collapse' : 'settings.expand') + ': ' + title}
      onClick={() => { setOpen(!open) }}
    >
      <span className={css.headText}>
        <span className={css.name}>{title}</span>
        <span className={css.description}>{props.t(props.descriptionKey)}</span>
      </span>
      {state.dirty ? <span className={css.pending}>{props.t('settings.unsaved')}</span> : null}
      <span className={open ? css.chevronOpen : css.chevron}>▾</span>
    </button>
  )

  if (!state.exposed) {
    return (
      <li className={css.card}>
        {header}
        {open ? <div className={css.body}><p className={css.notExposed} role='status'>{props.t('settings.notExposed')}</p></div> : null}
      </li>
    )
  }

  return (
    <li className={css.card}>
      {header}
      {open ? (
        <div className={css.body}>
          {!state.writable ? <p className={css.readOnly} role='status'>{props.t('settings.readOnly')}</p> : null}
          {props.children}
          <div className={css.footer}>
            {state.failed ? <p className={css.failed} role='status'>{props.t('settings.saveFailed')}</p> : null}
            <button type='button' className={css.discard} disabled={!state.dirty || state.saving} onClick={props.onDiscard}>
              {props.t('settings.discard')}
            </button>
            <button type='button' className={css.save} disabled={blocked} onClick={props.onSave}>
              {props.t(!state.saving ? 'settings.save' : 'settings.saving')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/** One staged boolean field: 继承 / 开 / 关. */
export interface BooleanFieldProps {
  id: string
  label: string
  hint: string
  inheritLabel: string
  onLabel: string
  offLabel: string
  overriddenLabel: string
  resetLabel: string
  disabled: boolean
  text: string
  overridden: boolean
  onEdit: (text: string) => void
  onReset: () => void
}

export function BooleanField(props: BooleanFieldProps): ReactElement {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden ? (
          <span className={css.badges}>
            <span className={css.badge}>{props.overriddenLabel}</span>
            <button type='button' className={css.reset} disabled={props.disabled} onClick={props.onReset}>
              {props.resetLabel}
            </button>
          </span>
        ) : null}
      </div>
      <select id={props.id} className={css.select} value={props.text} disabled={props.disabled} onChange={(event) => { props.onEdit(event.target.value) }}>
        <option value=''>{props.inheritLabel}</option>
        <option value='true'>{props.onLabel}</option>
        <option value='false'>{props.offLabel}</option>
      </select>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}


/**
 * A compact sliding switch for the card's master enable/disable control.
 * An empty text value means the field inherits its default; the switch still
 * reflects the effective default and becomes an explicit override on click.
 */
export interface SwitchFieldProps {
  label: string
  hint: string
  disabled: boolean
  text: string
  overridden: boolean
  overriddenLabel: string
  resetLabel: string
  onEdit: (text: string) => void
  onReset: () => void
}

export function SwitchField(props: SwitchFieldProps): ReactElement {
  const checked = props.text !== 'false'
  return (
    <div className={css.field}>
      <div className={css.switchRow}>
        <div className={css.switchText}>
          <div className={css.head}>
            <span className={css.label}>{props.label}</span>
            {props.overridden ? (
              <span className={css.badges}>
                <span className={css.badge}>{props.overriddenLabel}</span>
                <button type='button' className={css.reset} disabled={props.disabled} onClick={props.onReset}>
                  {props.resetLabel}
                </button>
              </span>
            ) : null}
          </div>
          <p className={css.hint}>{props.hint}</p>
        </div>
        <button
          type='button'
          className={checked ? css.switchOn : css.switch}
          role='switch'
          aria-checked={checked}
          aria-label={props.label}
          disabled={props.disabled}
          onClick={() => { props.onEdit(String(!checked)) }}
        >
          <span className={css.switchThumb} />
        </button>
      </div>
    </div>
  )
}
