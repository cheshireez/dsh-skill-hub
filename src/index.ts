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
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-query'
import type { HubConfig } from './protocol.ts'
import { SkillHubProvider } from './provider.ts'
import { makeRoutes } from './routes.ts'
import { createSkillStatsReader, type SkillStatsReader } from './stats.ts'
import { SkillHubStore } from './store.ts'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'skill-hub'

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
export const SKILL_HUB_GUIDANCE = [
  '本机已安装 dsh-skill-hub 插件（DSH Web GUI 技能中枢）：设置 →「技能」分区为管理主页；设置 → 插件列表中有本插件的配置卡片（启用/公告开关）。能力：完整本地技能目录（项目/自定义/用户/内置全部来源，走官方 ctx.skills 注册表，含第三方 provider）；搜索、按来源分组；启用/禁用技能（重命名 SKILL.md 并记录于 ~/.dsh/dsh-skill-hub.json，文件不删除、可随时恢复）；查看技能正文；发现诊断（列出被忽略技能的原因：缺 frontmatter、缺 name/description、非法名称）；新建技能向导（写入 ~/.dsh/skills 或 ~/.agents/skills）。限制：仅用户级技能（user-dsh/user-agents 根目录）可写，项目/内置/运行时技能只读展示；路由仅回环可访问。用户提到「技能管理 / 技能列表 / 技能开关 / 新建技能」时即指本插件，请据此协作。',
  'The dsh-skill-hub plugin is installed (the DSH Web GUI skill hub): Settings → "Skills" is the management page; Settings → Plugins lists this plugin\'s configuration card (enable / announcement toggles). Capabilities: full local skill catalog (project / custom / user / bundled roots via the official ctx.skills registry, including third-party providers); search; grouping by source; enable/disable skills (renames SKILL.md and records it in ~/.dsh/dsh-skill-hub.json; files are never deleted and can be restored anytime); view skill bodies; discovery diagnostics (reasons a skill is ignored: missing frontmatter, missing name/description, invalid name); new-skill wizard (writes to ~/.dsh/skills or ~/.agents/skills). Limits: only user-level skills (user-dsh/user-agents roots) are writable; project/bundled/runtime skills are read-only; routes are loopback-only. When the user mentions "skill management / skill list / skill toggle / new skill", this plugin is what they mean — collaborate accordingly.'
].join('\n\n')

/** Defaults the hub applies when neither the cordis config nor the sidecar says otherwise. */
const DEFAULTS: HubConfig = { enabled: true, announceToAgent: true }

/**
 * Mount the skill hub routes and announcement.
 * @param ctx - host plugin context carrying webServer/skills/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  // The hub owns its runtime configuration: the cordis composition entry
  // seeds the defaults, and the web settings card persists edits into the
  // sidecar store (~/.dsh/dsh-skill-hub.json). The host's settings service
  // deliberately refuses to expose third-party namespaces to the web client
  // (dsh-host-apiproxy's allowlist), so the card talks to /api/skill-hub/config
  // instead of the settings transport.
  const base = config ?? {}
  const resolveSaved = (saved: Partial<HubConfig>): HubConfig => ({
    enabled: saved.enabled ?? base.enabled ?? DEFAULTS.enabled,
    announceToAgent: saved.announceToAgent ?? base.announceToAgent ?? DEFAULTS.announceToAgent,
  })
  let current: () => HubConfig = () => resolveSaved({})
  // The raw saved config layer (fields the user explicitly overrode); the
  // config route reports it so the web card can mark overridden fields.
  let savedState: Partial<HubConfig> = {}

  const store = new SkillHubStore()
  let disposeRoutes: (() => void) | undefined
  let disposeSection: (() => void) | undefined
  // The hub's own provider contributes user/project skills to the registry's
  // GLOBAL layer — the web app deliberately keeps that layer empty (presets
  // own per-scope discovery), and the GUI needs a session-independent view.
  let disposeProvider: (() => void) | undefined
  let providerControl: SkillProviderControl | undefined
  // Optional invocation-count source; only set once a session-query service
  // is present (see the soft inject below). Absent deployments just omit the
  // stats route's data rather than failing to load.
  let stats: SkillStatsReader | undefined

  // Persist a config patch, re-point the live config, and re-sync every
  // surface. Runs inside the config route handler; the response is written
  // after sync() has settled the new registration set.
  const updateConfig = async (patch: Partial<HubConfig>): Promise<HubConfig> => {
    await store.setConfig(patch)
    savedState = await store.getConfig()
    const next = resolveSaved(savedState)
    current = () => next
    sync()
    return next
  }

  // Register (or drop) every surface to match the current config. Each
  // group is kept under one disposer: re-registering first tears the old
  // one down so duplicate-name registrations never throw. The route family
  // (including the config route) stays mounted even with the master switch
  // off so the settings card can always read and re-enable the hub; the
  // business routes answer 503 while disabled.
  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeProvider !== undefined) {
      disposeProvider()
      disposeProvider = undefined
    }
    const value = current()
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-skill-hub',
        order: SECTION_ORDER,
        text: SKILL_HUB_GUIDANCE,
      })
    }
    if (value.enabled) {
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
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    disposeRoutes = ctx.effect(
      () => {
        const disposers = makeRoutes({
          skills: ctx.skills,
          store,
          invalidate: () => { providerControl?.invalidate() },
          stats,
          config: current,
          saved: () => savedState,
          updateConfig,
        }).map((route) => ctx.webServer.register(route))
        return () => {
          for (const dispose of disposers) dispose()
        }
      },
      'dsh-skill-hub: routes',
    )
  }

  // Initial registration from the composition entry, then adopt the saved
  // sidecar config once the store has read it (re-sync re-points surfaces).
  sync()
  void store.getConfig().then((saved) => {
    savedState = saved
    current = () => resolveSaved(saved)
    sync()
  })

  // Optional trigger statistics: while a session-query service exists, wire a
  // cached invocation-count reader into the stats route. Re-running sync()
  // re-registers the routes with the reader attached (mirrors the optional
  // stats wiring — no sessionQuery service ever mounted means none of this
  // runs).
  ctx.inject(['sessionQuery'], (sctx) => {
    stats = createSkillStatsReader(sctx.sessionQuery)
    sync()
  })
}
