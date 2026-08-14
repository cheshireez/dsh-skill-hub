/**
 * dsh-skill-hub — host half. Mounts the /api/skill-hub route family (full
 * skill catalog from the official ctx.skills registry, skill detail,
 * enable/disable toggle, new-skill scaffold) plus a system-prompt
 * announcement. The browser half (./client) renders the sidebar entry and
 * the skill hub panel. Everything rides official NPM SDK packages — no dsh
 * source changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { SkillHubProvider } from './provider.ts'
import { makeRoutes } from './routes.ts'
import { SkillHubStore } from './store.ts'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'skill-hub'

/**
 * Settings namespace of the skill hub — the section the web settings surface
 * edits and the plugin-management card binds. Spelled here rather than
 * imported: the browser half spells the same value and must not depend on a
 * Host package.
 */
export const SKILL_HUB_SETTINGS_NAMESPACE = settingsNamespace('dsh-skill-hub')

/** Services required before the skill-hub surfaces can mount. */
export const inject = ['webServer', 'skills', 'systemPrompt']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** When true (default), a system-prompt section announces the hub to every agent. */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, prompt section). */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(true),
  enabled: z.boolean().default(true),
})

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 152

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const SKILL_HUB_GUIDANCE = '本机已安装 dsh-skill-hub 插件（DSH Web GUI 技能中枢）：设置 →「技能」分区为管理主页；设置 → 插件列表中有本插件的配置卡片（启用/公告开关）。能力：完整本地技能目录（项目/自定义/用户/内置全部来源，走官方 ctx.skills 注册表，含第三方 provider）；搜索、按来源分组；启用/禁用技能（重命名 SKILL.md 并记录于 ~/.dsh/dsh-skill-hub.json，文件不删除、可随时恢复）；查看技能正文；发现诊断（列出被忽略技能的原因：缺 frontmatter、缺 name/description、非法名称）；新建技能向导（写入 ~/.dsh/skills 或 ~/.agents/skills）。限制：仅用户级技能（user-dsh/user-agents 根目录）可写，项目/内置/运行时技能只读展示；路由仅回环可访问。用户提到「技能管理 / 技能列表 / 技能开关 / 新建技能」时即指本插件，请据此协作。'

/**
 * Mount the skill hub routes and announcement.
 * @param ctx - host plugin context carrying webServer/skills/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  let current: () => Config = () => config ?? {}
  const resolve = (): Config => ({
    announceToAgent: current().announceToAgent ?? true,
    enabled: current().enabled ?? true,
  })

  const store = new SkillHubStore()
  let disposeRoutes: (() => void) | undefined
  let disposeSection: (() => void) | undefined
  // The hub's own provider contributes user/project skills to the registry's
  // GLOBAL layer — the web app deliberately keeps that layer empty (presets
  // own per-scope discovery), and the GUI needs a session-independent view.
  let disposeProvider: (() => void) | undefined
  let providerControl: SkillProviderControl | undefined

  // Register (or drop) every surface to match the current config. Each
  // group is kept under one disposer: re-registering first tears the old
  // one down so duplicate-name registrations never throw.
  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeProvider !== undefined) {
      disposeProvider()
      disposeProvider = undefined
    }
    const value = resolve()
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-skill-hub',
        order: SECTION_ORDER,
        text: SKILL_HUB_GUIDANCE,
      })
    }
    // registerProvider returns the exact cordis effect disposer: the fiber
    // unregisters the provider and invalidates catalog caches on teardown.
    providerControl = undefined
    disposeProvider = ctx.effect(
      () => ctx.skills.registerProvider((control) => {
        providerControl = control
        return new SkillHubProvider(control)
      }),
      'dsh-skill-hub: provider',
    )
    disposeRoutes = ctx.effect(
      () => {
        const disposers = makeRoutes({
          skills: ctx.skills,
          store,
          invalidate: () => { providerControl?.invalidate() },
        }).map((route) => ctx.webServer.register(route))
        return () => {
          for (const dispose of disposers) dispose()
        }
      },
      'dsh-skill-hub: routes',
    )
  }

  // The web settings surface edits the same config through the registered
  // section; both hooks re-run sync() so surfaces track the live source
  // (mirrors dsh-ssh).
  installSettingsSection(ctx, SKILL_HUB_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => {
      current = source
      sync()
    },
    onChange: sync,
  })

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSettingsSection never fires its hooks).
  sync()
}
