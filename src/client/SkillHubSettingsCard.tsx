/**
 * The dsh-skill-hub plugin settings card: bridges the hub's settings
 * namespace (bound through the official settings transport) onto the
 * family-style staged card form (enabled master switch + agent announcement).
 * Registered into the official `settings.plugin.item` slot keyed by that
 * namespace, so the plugin shows up in Settings → 插件 on dsh rc.7+.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SkillHubApi } from './api.ts'
import { ColorField, NumberField, PluginSettingsCard, SwitchField } from './settings-card.tsx'
import { booleanField, CardForm, colorField, numberField, type CardShell, type FieldState, type FormScope } from './settings-form.ts'
// Single source for the TS-side dot defaults (the panel CSS mirrors these).
import { DEFAULT_DOT_MODEL_COLOR, DEFAULT_DOT_USER_COLOR } from './panel/format.ts'
// Re-export for any consumer that imported them from the card before the move.
export { DEFAULT_DOT_MODEL_COLOR, DEFAULT_DOT_USER_COLOR }

/** The card's projected state. */
export interface SkillHubSettingsState extends CardShell {
  enabled: FieldState
  announceToAgent: FieldState
  dotModelColor: FieldState
  dotUserColor: FieldState
  showUseCount: FieldState
  showUseTime: FieldState
  showGroupSummary: FieldState
  statsWindowDays: FieldState
  statsScanMinutes: FieldState
}

/** The business face the card's slot registration injects. */
export interface SkillHubSettingsCardFace {
  hooks: {
    /** The card's snapshot store (projected form state). */
    skillHubSettingsCard: SnapshotStore<SkillHubSettingsState>
  }
  save: () => void
  discard: () => void
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
}

/** Props the slot renderer binds (locale copy + injected form actions). */
export type SkillHubSettingsCardProps =
  PropsRuntime<'settings.plugin.item'> & PropsLocale<'dsh-skill-hub'> & InjectFace<SkillHubSettingsCardFace>

/** Bridges the hub's config scope onto the card's staged form. */
export class SkillHubSettingsCardController {
  private readonly form: CardForm
  private readonly store: SnapshotStore<SkillHubSettingsState>

  /** @param scope - the hub settings scope the card edits (FormScope-compatible). */
  constructor(scope: FormScope) {
    this.form = new CardForm(scope, [booleanField('enabled'), booleanField('announceToAgent'), colorField('dotModelColor'), colorField('dotUserColor'), booleanField('showUseCount'), booleanField('showUseTime'), booleanField('showGroupSummary'), numberField('statsWindowDays', { min: 0, max: 3650 }), numberField('statsScanMinutes', { min: 1, max: 1440 })])
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
      showGroupSummary: this.form.field('showGroupSummary'),
      statsWindowDays: this.form.field('statsWindowDays'),
      statsScanMinutes: this.form.field('statsScanMinutes'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot hook and its form actions.
   */
  inject(): SkillHubSettingsCardFace {
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
  // 插件自身版本：挂载时从 config 路由取一次（与面板标题徽标同源），失败静默不显示。
  const [version, setVersion] = useState<string | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void new SkillHubApi().config()
      .then((res) => { if (!cancelled && res.ok) setVersion(res.pluginVersion) })
      .catch(() => { /* 版本徽标是装饰性的，失败不提示 */ })
    return () => { cancelled = true }
  }, [])
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
      version={version}
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
        defaultColor={DEFAULT_DOT_MODEL_COLOR}
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
        defaultColor={DEFAULT_DOT_USER_COLOR}
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
        label={t('settings.showGroupSummary')}
        hint={t('settings.showGroupSummaryHint')}
        {...fieldProps}
        {...state.showGroupSummary}
        onEdit={(text) => { props.edit('showGroupSummary', text) }}
        onReset={() => { props.resetField('showGroupSummary') }}
      />
      <NumberField
        id='skill-hub-stats-window-days'
        label={t('settings.statsWindowDays')}
        hint={t('settings.statsWindowDaysHint')}
        inheritLabel={t('settings.inherit')}
        {...fieldProps}
        text={state.statsWindowDays.text}
        overridden={state.statsWindowDays.overridden}
        invalid={state.statsWindowDays.invalid}
        onEdit={(text) => { props.edit('statsWindowDays', text) }}
        onReset={() => { props.resetField('statsWindowDays') }}
      />
      <NumberField
        id='skill-hub-stats-scan-minutes'
        label={t('settings.statsScanMinutes')}
        hint={t('settings.statsScanMinutesHint')}
        inheritLabel={t('settings.inherit')}
        {...fieldProps}
        text={state.statsScanMinutes.text}
        overridden={state.statsScanMinutes.overridden}
        invalid={state.statsScanMinutes.invalid}
        onEdit={(text) => { props.edit('statsScanMinutes', text) }}
        onReset={() => { props.resetField('statsScanMinutes') }}
      />
    </PluginSettingsCard>
  )
}
