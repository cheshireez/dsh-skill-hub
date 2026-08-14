/**
 * Browser-half entry for the dsh-skill-hub plugin — runs inside the dsh
 * web GUI.
 *
 * Registers the dsh-skill-hub locale dictionaries and mounts two Settings
 * surfaces, both through official slots (no DOM injection):
 *  - a plugin-management card in the `settings.plugin.item` slot (Settings →
 *    插件 → 可配置插件列表), bound to the `dsh-skill-hub` settings
 *    namespace via ctx.settingsScope — the family-bucket card pattern
 *    (PluginSettingsCard + CardForm vendored from dsh-task-board);
 *  - a top-level Settings section (Settings → 技能) hosting the skill hub
 *    panel: catalog, search, enable/disable, diagnostics, new-skill form.
 *
 * Failure policy: mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 *
 * Export discipline (packages/client rule): the /client surface carries
 * what cordis loading needs plus types only — all value exports stay
 * internal.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings-scope service merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings-plugins SlotMap merge (settings.plugin.item).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SkillHubApi } from './api.ts'
import { en, zh, type HubKey } from './locales.ts'
import { SkillHubSettingsCard, SkillHubSettingsCardController } from './SkillHubSettingsCard.tsx'
import { SkillHubPanel } from './panel/SkillHubPanel.tsx'

/** Locale namespace this plugin owns. */
const NS = 'dsh-skill-hub'

/** Settings namespace the host half registers (the card edits it). */
const SETTINGS_NS = 'dsh-skill-hub'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-skill-hub surface copy. */
    'dsh-skill-hub': HubKey
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'settingsScope']

/** Type-only surface (export discipline: no value exports beyond the plugin contract). */
export type { SkillHubPanelProps } from './panel/SkillHubPanel.tsx'
export type { SkillHubSettingsState } from './SkillHubSettingsCard.tsx'
export type { HubKey } from './locales.ts'

/**
 * Mount the settings card and the skill hub section.
 * @param ctx - client root context (slots, locale, settingsScope).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-skill-hub: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = new SkillHubApi()

  const settingsCard = new SkillHubSettingsCardController(
    ctx.settingsScope.bind({ namespace: SETTINGS_NS }),
  )

  // Plugin-management card: Settings → 插件 → 可配置插件列表.
  // Runtime note: the official settings-plugins package registers cards with
  // an 'inject' face at runtime, but its published slot contract does not
  // declare it, so the typed register overload rejects the option. Cast the
  // call (runtime-identical to the official cards) and keep the card fully typed.
  ctx.effect(
    () => ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'dsh-skill-hub',
      order: 115,
      locale: NS,
      inject: () => settingsCard.inject(),
    } as never, SkillHubSettingsCard as never)),
    'dsh-skill-hub: settings card',
  )

  // Top-level Settings section: the skill management page.
  ctx.effect(
    () => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'skills',
      order: 12,
      label: () => t('entry.label'),
      locale: NS,
      inject: () => ({}),
    }, () => <SkillHubPanel api={api} />)),
    'dsh-skill-hub: settings section',
  )
}

