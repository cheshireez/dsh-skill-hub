/**
 * The dsh-skill-hub plugin settings card: bridges the hub's own config route
 * (ApiConfigScope → /api/skill-hub/config) onto the family-style staged card
 * form (enabled master switch + agent announcement). Registered into the
 * official `settings.plugin.item` slot so the plugin shows up in Settings →
 * 插件. The scope is a FormScope, so the card never touches the settings
 * service (the host refuses third-party namespaces).
 */

import type { ReactElement } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { BooleanField, PluginSettingsCard, SwitchField } from './settings-card.tsx'
import { booleanField, CardForm, type CardShell, type FieldState, type FormScope } from './settings-form.ts'

/** The card's projected state. */
export interface SkillHubSettingsState extends CardShell {
  enabled: FieldState
  announceToAgent: FieldState
}

/** Props the slot renderer receives (locale copy + injected form actions). */
export interface SkillHubSettingsCardProps {
  t: (key: string) => string
  useSkillHubSettingsCard: <T>(selector: (snapshot: SkillHubSettingsState) => T) => T
  save: () => void
  discard: () => void
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
}

/** Bridges the hub's config scope onto the card's staged form. */
export class SkillHubSettingsCardController {
  private readonly form: CardForm
  private readonly store: SnapshotStore<SkillHubSettingsState>

  /** @param scope - the hub config scope the card edits (ApiConfigScope). */
  constructor(scope: FormScope) {
    this.form = new CardForm(scope, [booleanField('enabled'), booleanField('announceToAgent')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): SkillHubSettingsState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      announceToAgent: this.form.field('announceToAgent'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot hook and its form actions.
   */
  inject(): { hooks: { skillHubSettingsCard: SnapshotStore<SkillHubSettingsState> } } & ReturnType<CardForm['actions']> {
    return {
      hooks: { skillHubSettingsCard: this.store },
      ...this.form.actions(),
    }
  }
}

/**
 * Render the dsh-skill-hub card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function SkillHubSettingsCard(props: SkillHubSettingsCardProps): ReactElement {
  const { t } = props
  const state = props.useSkillHubSettingsCard((snapshot) => snapshot)
  const disabled = !state.writable
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    disabled,
  }
  return (
    <PluginSettingsCard
      t={t}
      titleKey='settings.title'
      descriptionKey='settings.description'
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SwitchField
        label={t('settings.enabled')}
        hint={t('settings.enabledHint')}
        {...fieldProps}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <BooleanField
        id='settings-skill-hub-announce'
        label={t('settings.announceToAgent')}
        hint={t('settings.announceToAgentHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.announceToAgent}
        onEdit={(text) => { props.edit('announceToAgent', text) }}
        onReset={() => { props.resetField('announceToAgent') }}
      />
    </PluginSettingsCard>
  )
}

