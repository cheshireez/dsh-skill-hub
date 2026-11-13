/**
 * Browser-half entry for the dsh-skill-hub plugin — runs inside the dsh
 * web GUI.
 *
 * Registers the dsh-skill-hub locale dictionaries and mounts:
 *  - a top-level Settings section (Settings → 技能中枢) hosting the skill hub
 *    panel: catalog, search, enable/disable, diagnostics, new-skill form;
 *  - the chat "/" menu skill dots, colored from the same config the panel reads.
 *
 *  - a configuration card in the `plugins.bundle.config` slot, keyed by the
 *    BUNDLE PACKAGE NAME, rendered on the plugin's own page in the Plugins
 *    manager (sidebar → 插件 → dsh-skill-hub). dsh 0.1.7 has no auto-generated
 *    config page: the manager only renders that section for bundles that
 *    register this slot, and the card writes through the shared config form
 *    (`ctx.configForms.get(skill-hub)`), the same form the host routes read.
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
// Type-only: pulls the configForms service merge and the settings.section slot.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the Context merge for ctx.inputTriggers (slash-dots wiring).
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the plugin-manager SlotMap merge (plugins.bundle.config).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the connection/reset event.
import type {} from '@deepseek-ai/dsh-client-connection/client'

/**
 * The slots service is owned by ui-renderer, which this build does not depend
 * on. Its published `SlotMap` is deliberately an empty declaration-merge point,
 * and the four keys we register do not appear in any installed .d.ts — so
 * `keyof SlotMap` would be `never` here and full key typing needs the host to
 * publish those contracts. Type the call shapes instead of leaving `slots: any`:
 * a malformed registration spec or a non-disposable inject is now a compile
 * error, and the four slot names are collected below for a future migration.
 */
interface SlotRegistration {
  name: string
  key?: string
  id?: string
  order?: number
  label?: () => string
  locale?: string
  inject?: () => object
}
interface SlotsFace {
  inject(key: string, factory: () => () => void): () => void
  register(spec: SlotRegistration, component?: unknown): () => void
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: SlotsFace
  }
}
import { HUB_ENTRY_ID, type HubSettingsValue } from '../protocol.ts'
import { SkillHubApi } from './api.ts'
import { en, zh, type HubKey } from './locales.ts'
import { applySettingsNavIcon } from './settings-nav-icon.ts'
import { setupSkillSlashDots } from './slash-dots.tsx'
import { SkillHubSettingsCard, SkillHubSettingsCardController } from './SkillHubSettingsCard.tsx'
import { SkillHubPanel } from './panel/SkillHubPanel.tsx'
import { IconSkillOutline16 } from './icons.tsx'

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

  // The hub's config form is the same Loader entry the host writes and the
  // Plugins manager renders; the browser half reads it only to color the dots
  // (single form instance, so slash-dots keeps one subscription).
  const scope = ctx.configForms.get<HubSettingsValue>(HUB_ENTRY_ID)
  const settingsCard = new SkillHubSettingsCardController(scope)

  // Chat `/` 菜单技能圆点：为每个候选行加可调用性圆点（蓝=模型可调，绿=仅用户），颜色与面板图例同步；仅装饰，不自动预填 "/"
  // inject 含 inputTriggers 保证 fiber 就绪后再 wrap，slash-dots 内的 undefined 防御仅用于单元测试 mock
  ctx.effect(() => setupSkillSlashDots(ctx, api, scope), 'dsh-skill-hub: slash dots')

  // The plugin's own configuration page. It must be registered here: the
  // Plugins manager only renders the config section for bundles that appear in
  // `plugins.bundle.config` (`ledger.bundles.has(openPkg.name)`), and its key is
  // the BUNDLE PACKAGE NAME — not the settings entry id (`skill-hub`). There is
  // no auto-generated fallback page in dsh 0.1.7.
  ctx.effect(
    () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: 'dsh-skill-hub',
      locale: NS,
      inject: () => settingsCard.inject(),
    }, SkillHubSettingsCard)),
    'dsh-skill-hub: plugin config',
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

  // Wide sidebar main panel: same hub surface, 960px shell. The settings page
  // remains the canonical place for configuration; this panel is the sidebar
  // companion for browsing skills without leaving the conversation.
  ctx.effect(
    () => ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: 'skill-hub',
      locale: NS,
      inject: () => ({}),
    }, () => <SkillHubPanel api={api} mode='sidebar' />)),
    'dsh-skill-hub: sidebar main panel',
  )

  // Sidebar entry icon, directly under 插件 in the left rail.
  ctx.effect(
    () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: 'skill-hub',
      order: 30,
      label: () => t('entry.label'),
      locale: NS,
    }, IconSkillOutline16)),
    'dsh-skill-hub: sidebar entry',
  )

  // Settings nav icon. dsh 0.2.2-rc.2 起宿主提供 `settings.section.icon`
  // （list / root，注册 id 必须等于目标 section 的 id），图标随 section 声明
  // 一起渲染。
  //
  // 无条件注册：注册进未声明的 key 只是「不渲染」，不会抛错。老宿主自然
  // 拿不到效果，由下面的 DOM 兜底接手。
  ctx.effect(
    () => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
      name: 'settings.section.icon',
      id: HUB_ENTRY_ID,
      order: 0,
      inject: () => ({}),
    }, (owner: { size: number }) => <IconSkillOutline16 size={owner.size} />)),
    'dsh-skill-hub: settings section icon',
  )
  // 兜底：没有该 slot 的宿主（0.2.2-rc.2 之前）在设置弹窗里把默认齿轮换成
  // 同一个图标。官方 slot 生效时两者都指向同一张图，视觉无差异。
  ctx.effect(() => applySettingsNavIcon(), 'dsh-skill-hub: settings nav icon')
}
