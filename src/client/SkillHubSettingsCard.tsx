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
import { ColorField, PluginSettingsCard, SwitchField } from './settings-card.tsx'
import { booleanField, CardForm, colorField, type CardShell, type FieldState, type FormScope } from './settings-form.ts'

/** The card's projected state. */
export interface SkillHubSettingsState extends CardShell {
  enabled: FieldState
  announceToAgent: FieldState
  dotModelColor: FieldState
  dotUserColor: FieldState
  showUseCount: FieldState
  showUseTime: FieldState
  showSourceColumn: FieldState
  showGroupSummary: FieldState
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
    this.form = new CardForm(scope, [booleanField('enabled'), booleanField('announceToAgent'), colorField('dotModelColor'), colorField('dotUserColor'), booleanField('showUseCount'), booleanField('showUseTime'), booleanField('showSourceColumn'), booleanField('showGroupSummary')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): SkillHubSettingsState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      announceToAgent: this.form.field('announceToAgent'),
      dotModelColor: this.form.field('dotModelColor'),
      dotUserColor: this.form.field('dotUserColor'),
      showUseCount: this.form.field('showUseCount'),
      showUseTime: this.form.field('showUseTime'),
      showSourceColumn: this.form.field('showSourceColumn'),
      showGroupSummary: this.form.field('showGroupSummary'),
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
      <SwitchField
        label={t('settings.announceToAgent')}
        hint={t('settings.announceToAgentHint')}
        {...fieldProps}
        {...state.announceToAgent}
        onEdit={(text) => { props.edit('announceToAgent', text) }}
        onReset={() => { props.resetField('announceToAgent') }}
      />
      <ColorField
        id='skill-hub-dot-model-color'
        label={t('settings.dotModelColor')}
        hint={t('settings.dotModelColorHint')}
        inheritLabel={t('settings.inherit')}
        {...fieldProps}
        {...state.dotModelColor}
        onEdit={(text) => { props.edit('dotModelColor', text) }}
        onReset={() => { props.resetField('dotModelColor') }}
      />
      <ColorField
        id='skill-hub-dot-user-color'
        label={t('settings.dotUserColor')}
        hint={t('settings.dotUserColorHint')}
        inheritLabel={t('settings.inherit')}
        {...fieldProps}
        {...state.dotUserColor}
        onEdit={(text) => { props.edit('dotUserColor', text) }}
        onReset={() => { props.resetField('dotUserColor') }}
      />
      <SwitchField
        label={t('settings.showUseCount')}
        hint={t('settings.showUseCountHint')}
        {...fieldProps}
        {...state.showUseCount}
        onEdit={(text) => { props.edit('showUseCount', text) }}
        onReset={() => { props.resetField('showUseCount') }}
      />
      <SwitchField
        label={t('settings.showUseTime')}
        hint={t('settings.showUseTimeHint')}
        {...fieldProps}
        {...state.showUseTime}
        onEdit={(text) => { props.edit('showUseTime', text) }}
        onReset={() => { props.resetField('showUseTime') }}
      />
      <SwitchField
        label={t('settings.showSourceColumn')}
        hint={t('settings.showSourceColumnHint')}
        {...fieldProps}
        {...state.showSourceColumn}
        onEdit={(text) => { props.edit('showSourceColumn', text) }}
        onReset={() => { props.resetField('showSourceColumn') }}
      />
      <SwitchField
        label={t('settings.showGroupSummary')}
        hint={t('settings.showGroupSummaryHint')}
        {...fieldProps}
        {...state.showGroupSummary}
        onEdit={(text) => { props.edit('showGroupSummary', text) }}
        onReset={() => { props.resetField('showGroupSummary') }}
      />
    </PluginSettingsCard>
  )
}

