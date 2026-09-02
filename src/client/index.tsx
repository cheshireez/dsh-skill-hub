/**
 * Browser-half entry for the dsh-skill-hub plugin — runs inside the dsh
 * web GUI.
 *
 * Registers the dsh-skill-hub locale dictionaries and mounts two Settings
 * surfaces, both through official slots (no DOM injection):
 *  - a plugin-management card in the `settings.plugin.item` slot (Settings →
 *    插件 → 可配置插件列表), keyed by the hub's settings namespace and bound
 *    through the official settings transport (dsh rc.7 serves every
 *    registered namespace to the web client, and the tab dispatches cards by
 *    namespace) — the family-bucket card pattern (PluginSettingsCard +
 *    CardForm vendored from dsh-task-board);
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

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings-scope service merge and the settings.section slot.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings-plugins SlotMap merge (settings.plugin.item).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: pulls the Context merge for ctx.inputTriggers (slash-dots wiring).
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the connection/reset event.
import type {} from '@deepseek-ai/dsh-client-connection/client'

// 0.1.2-alpha.2: slots service moved to ui-renderer; provide local augmentation for build.
declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: any
  }
}
import type { HubSettingsValue } from '../protocol.ts'
import { SkillHubApi } from './api.ts'
import { en, zh, type HubKey } from './locales.ts'
import { applySettingsNavIcon } from './settings-nav-icon.ts'
import { SkillHubSettingsCard, SkillHubSettingsCardController } from './SkillHubSettingsCard.tsx'
import { SkillHubPanel } from './panel/SkillHubPanel.tsx'

/** Locale namespace this plugin owns. */
const NS = 'dsh-skill-hub'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-skill-hub surface copy. */
    'dsh-skill-hub': HubKey
  }
}

/**
 * Required services (fiber inject waiting — the runtime must be up first).
 * `connection`/`remote` are the settings transport's own prerequisites
 * (`ctx.settingsScope.bind` resolves them on the caller's fiber), and
 * `settingsScope` is the namespace-scope binder itself; mirror the official
 * settings-plugins inject list.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/** Type-only surface (export discipline: no value exports beyond the plugin contract). */
export type { SkillHubPanelProps } from './panel/SkillHubPanel.tsx'
export type { SkillHubSettingsState } from './SkillHubSettingsCard.tsx'
export type { HubKey } from './locales.ts'

/**
 * Mount the settings card and the skill hub section.
 * @param ctx - client root context (slots, locale).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-skill-hub: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = new SkillHubApi()

  // The card edits the hub's settings namespace through the official
  // settings transport — the configurable-plugins tab only dispatches cards
  // whose key the Host serves, and the Host serves every registered namespace
  // since rc.7, so this is what makes the card appear (and stay in sync).
  const settingsCard = new SkillHubSettingsCardController(
    ctx.settingsScope.bind<HubSettingsValue>({ namespace: NS }),
  )

  // 斜杠菜单圆点已按需求移除：不再包 `/skill` 源，避免演示性预填 "/" 的干扰

  // Plugin-management card: Settings → 插件 → 可配置插件列表.
  // rc.7's slot contract declares this keyed slot with options `key`
  // (the settings namespace the card edits), so registration is fully typed.
  ctx.effect(
    () => ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: NS,
      locale: NS,
      inject: () => settingsCard.inject(),
    }, SkillHubSettingsCard)),
    'dsh-skill-hub: settings card',
  )

  // Top-level Settings section: the skill management page.
  ctx.effect(
    () => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'skill-hub',
      order: 12,
      label: () => t('entry.label'),
      locale: NS,
      inject: () => ({}),
    }, () => <SkillHubPanel api={api} />)),
    'dsh-skill-hub: settings section',
  )

  // Host shell has no section-icon registration; keep the nav gear swapped for the skill icon.
  ctx.effect(() => applySettingsNavIcon(), 'dsh-skill-hub: settings nav icon')
}
