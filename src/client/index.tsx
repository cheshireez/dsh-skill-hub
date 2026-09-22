/**
 * Browser-half entry for the dsh-skill-hub plugin — runs inside the dsh
 * web GUI.
 *
 * Registers the dsh-skill-hub locale dictionaries and mounts:
 *  - a top-level Settings section (Settings → 技能) hosting the skill hub
 *    panel: catalog, search, enable/disable, diagnostics, new-skill form;
 *  - the chat "/" menu skill dots, colored from the same config the panel reads.
 *
 * The plugin's own configuration has NO custom card: since dsh 0.1.7 the
 * Plugins manager auto-generates one from this plugin's Loader entry schema
 * (src/index.ts Config), so the browser half only reads that form to color the
 * dots — it never writes it.
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
// Type-only: pulls the Context merge for ctx.inputTriggers (slash-dots wiring).
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the plugin-manager SlotMap merge (plugins.bundle.config).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the connection/reset event.
import type {} from '@deepseek-ai/dsh-client-connection/client'

// The slots service is owned by ui-renderer, which this build does not depend
// on; augment the Context locally so the browser half typechecks.
declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: any
  }
}
import { HUB_ENTRY_ID, type HubSettingsValue } from '../protocol.ts'
import { SkillHubApi } from './api.ts'
import { en, zh, type HubKey } from './locales.ts'
import { applySettingsNavIcon } from './settings-nav-icon.ts'
import { setupSkillSlashDots } from './slash-dots.tsx'
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
 * (`ctx.configForms.get` resolves them on the caller's fiber), and
 * `configForms` is the shared settings-form service itself; mirror the
 * official settings-plugins inject list.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'configForms', 'inputTriggers']

/** Type-only surface (export discipline: no value exports beyond the plugin contract). */
export type { SkillHubPanelProps } from './panel/SkillHubPanel.tsx'
export type { HubKey } from './locales.ts'

/**
 * Mount the settings card and the skill hub section.
 * @param ctx - client root context (slots, locale).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-skill-hub: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = new SkillHubApi()

  // The hub's config form is the same Loader entry the host writes and the
  // Plugins manager renders; the browser half reads it only to color the dots
  // (single form instance, so slash-dots keeps one subscription).
  const scope = ctx.configForms.get<HubSettingsValue>(HUB_ENTRY_ID)

  // Chat `/` 菜单技能圆点：为每个候选行加可调用性圆点（蓝=模型可调，绿=仅用户），颜色与面板图例同步；仅装饰，不自动预填 "/"
  // inject 含 inputTriggers 保证 fiber 就绪后再 wrap，slash-dots 内的 undefined 防御仅用于单元测试 mock
  ctx.effect(() => setupSkillSlashDots(ctx, api, scope), 'dsh-skill-hub: slash dots')

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
