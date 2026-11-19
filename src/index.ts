/**
 * dsh-skill-hub — host half. Mounts the /api/skill-hub route family (full
 * skill catalog from the official ctx.skills registry, skill detail,
 * enable/disable toggle, new-skill scaffold) plus a system-prompt
 * announcement. The browser half (./client) renders the sidebar entry and
 * the skill hub panel. Everything rides official NPM SDK packages — no dsh
 * source changes.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type { SettingsForms, SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
// dsh's own fork, NOT the plain `schemastery` package: `.volatile()` (and the
// loader's `fiber.runtime.Config` handling) only exist here. Every official
// plugin imports it under this name.
import z from '@deepseek-ai/schemastery'
// Type-only, for the `ctx.connection` augmentation (the `/api` trust fence).
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-settings'
import { CONFIG_FIELDS, HUB_CONFIG_DEFAULTS, HUB_ENTRY_ID, HEX_COLOR_RE, resolveHubConfig, type HubConfig } from './protocol.ts'
import { SkillHubProvider } from './provider.ts'
import { hostTrustFence, makeRoutes } from './routes.ts'
import { createSkillStatsReader, asPersistenceSeam, type SessionPersistenceLike, type SessionQueryLike, type SkillStatsReader } from './stats.ts'
import { SkillHubStore } from './store.ts'
import { migrateRenamedDisabledSkills, reconcileDisabledSkills, pruneStaleDisabledSkills, pruneStaleTrash } from './reconcile.ts'
import { cleanupLeftoverImportDirs, setGithubToken } from './repo.ts'
import { dshHome } from './store/paths.ts'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'skill-hub'

/**
 * Services required before the skill-hub surfaces can mount. `settings` is deliberately NOT here: the plugin reads its own volatile config refs and only reaches for the settings service when it is present (issue #11).
 *
 * `webServer` is deliberately NOT here either. It only exists in the web
 * profile (`dsh-base` + `dsh-web-app`); declaring it required makes the plugin
 * sit in `pending (waiting for service: webServer)` forever in the headless /
 * acp / sdk profiles, and the host reports `1 entry did not activate` — on a
 * bare `dsh-base` profile that escalates to `plugin tree failed to load`.
 * HTTP routes are registered conditionally instead (see the routes effect).
 */
export const inject = ['skills', 'systemPrompt']

/**
 * Plugin config, validated by the same-named schemastery schema.
 *
 * dsh 0.1.7 replaced the "plugin registers a settings namespace" model with
 * "the Loader entry's Config IS the settings namespace", so this one schema is
 * both the composition config and the settings page. Every field is volatile:
 * the Loader re-resolves volatile values in place and re-enters apply()
 * instead of rebuilding the fiber, and only volatile fields are writable
 * through the settings transport.
 */
export interface Config {
  /** When true (default), a system-prompt section announces the hub to every agent. */
  announceToAgent: Volatile<boolean>
  /** Master switch for the plugin (routes, prompt section). */
  enabled: Volatile<boolean>
  /** Show per-skill invocation count chip. Default true. */
  showUseCount: Volatile<boolean>
  /** Show per-skill last-used relative time. Default true. */
  showUseTime: Volatile<boolean>
  /** Show group-header usage summaries (count + last used). Default true. */
  showGroupSummary: Volatile<boolean>
  /** 模型可调圆点颜色（#rrggbb）；缺省用面板默认色。 */
  dotModelColor: Volatile<string | undefined>
  /** 用户可调圆点颜色（#rrggbb）；缺省用面板默认色。 */
  dotUserColor: Volatile<string | undefined>
  /** GitHub token；`role('secret')` 让 settings 层统一脱敏，缺省为匿名。 */
  githubToken: Volatile<string | undefined>
  /** 统计滚动窗口天数：只统计最近 N 天的使用；0 = 全部历史。 */
  statsWindowDays: Volatile<number>
  /** 自动统计扫描间隔（分钟，最小 1）。 */
  statsScanMinutes: Volatile<number>
}

/**
 * The durable field schemas, plain (non-volatile) so the same definitions can
 * back both the live view below and the wire form the settings page renders
 * from `.toJSON()`. `description` is what the auto-generated page shows with
 * each row; `role('secret')` makes the settings layer redact the value on
 * every wire read.
 */
const ConfigFields = {
  enabled: z.boolean().default(HUB_CONFIG_DEFAULTS.enabled).description('关闭后技能中枢的路由、入口与公告全部下线。'),
  announceToAgent: z.boolean().default(HUB_CONFIG_DEFAULTS.announceToAgent).description('在系统提示中加入本插件说明，用户提到技能管理时 Agent 知道如何协作。'),
  dotModelColor: z.string().pattern(HEX_COLOR_RE).description('技能行与聊天「/」菜单中「模型可调」圆点的颜色（#rrggbb）。'),
  dotUserColor: z.string().pattern(HEX_COLOR_RE).description('技能行与聊天「/」菜单中「仅用户可调」圆点的颜色（#rrggbb）。'),
  showUseCount: z.boolean().default(HUB_CONFIG_DEFAULTS.showUseCount).description('在技能名旁显示调用次数。'),
  showUseTime: z.boolean().default(HUB_CONFIG_DEFAULTS.showUseTime).description('在技能名行显示最近调用时间。'),
  showGroupSummary: z.boolean().default(HUB_CONFIG_DEFAULTS.showGroupSummary).description('在分组标题后汇总调用次数与最近调用时间。'),
  statsWindowDays: z.number().min(0).max(3650).default(HUB_CONFIG_DEFAULTS.statsWindowDays).description('只统计最近 N 天的使用次数；0 = 全部历史。'),
  statsScanMinutes: z.number().min(1).max(1440).default(HUB_CONFIG_DEFAULTS.statsScanMinutes).description('后台扫描会话日志的间隔（分钟，最小 1）。'),
  githubToken: z.string().role('secret').description('市场/来源走 GitHub API：匿名每小时 60 次，填 token 后 5000 次。留空即匿名（或跟随 GITHUB_TOKEN 环境变量）。'),
}

/**
 * The live plugin config the settings page edits. Field order here is the row
 * order the auto-generated page renders.
 */
export const Config = z.object({
  enabled: ConfigFields.enabled.volatile(),
  announceToAgent: ConfigFields.announceToAgent.volatile(),
  dotModelColor: ConfigFields.dotModelColor.volatile(),
  dotUserColor: ConfigFields.dotUserColor.volatile(),
  showUseCount: ConfigFields.showUseCount.volatile(),
  showUseTime: ConfigFields.showUseTime.volatile(),
  showGroupSummary: ConfigFields.showGroupSummary.volatile(),
  statsWindowDays: ConfigFields.statsWindowDays.volatile(),
  statsScanMinutes: ConfigFields.statsScanMinutes.volatile(),
  githubToken: ConfigFields.githubToken.volatile(),
})

/**
 * The settings namespace this plugin's config lives under, narrowed to the
 * settings package's branded type. The browser half resolves the same form
 * through `ctx.configForms.get(HUB_ENTRY_ID)`.
 */
export const ENTRY_ID = HUB_ENTRY_ID as SettingsNamespace

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 152

/**
 * The host's scoped duplicate-name rejection, thrown by dsh-skill's
 * `SkillLayer` / `NamedEntries` when a layer already holds a provider under
 * the same name. Only the scoped variant is matched — the unscoped one comes
 * from the global layer and means something genuinely different.
 */
function isDuplicateProviderError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('already registered in this scope')
}

/**
 * Register the hub's provider once more into every live agent's own skill
 * layer, and keep following agents as they come and go.
 *
 * Why a second registration is REQUIRED for invocation overrides: an agent's
 * skill catalog comes from the preset layer's own filesystem provider, which
 * is nearer than the global layer. dsh-skill merges layers in order and the
 * LAST write of a duplicate name wins, so a global-layer override can never
 * outrank it — the override entry must exist in a layer nearer than the
 * preset's. Registering the same shared instance per agent does exactly that
 * (the shared instance keeps a single watch timer; only the per-layer
 * controls differ, and each control invalidates its own layer's cache).
 *
 * Everything is defensive: the host may expose none of `ctx.on` / `ctx.get`,
 * an agent may carry no skills service, and the event names may change —
 * in every case this degrades to "no agent-layer override" (the global
 * catalog still applies it) instead of breaking the plugin load.
 *
 * The returned disposer MUST be bound to the plugin fibre by the caller
 * (`ctx.effect`). Unlike the global layer, an agent layer outlives a plugin
 * reload — the host replays the profile in-process while agents stay alive —
 * so a registration released only on `agent/disposed` or the next `sync()`
 * survives its fibre and makes the replaying fibre throw "already registered
 * in this scope" (issue #24).
 *
 * That leak is also why a duplicate rejection is swallowed rather than thrown
 * (see `install`): the fibre being unloaded during a self-update is the *old*
 * one, so on the upgrade out of 0.3.36 or earlier the conflict is guaranteed
 * no matter what this version does on teardown. Failing here would roll the
 * update back and make the fix impossible to install.
 */
function registerAgentSkillPolicy(
  ctx: Context,
  ensureProvider: (control: SkillProviderControl) => SkillHubProvider,
): () => void {
  interface AgentLike {
    id?: unknown
    ctx?: unknown
  }
  type AgentEvent = { agent?: AgentLike }
  type SkillsLike = { registerProvider?: (factory: (control: SkillProviderControl) => SkillHubProvider) => (() => void) | undefined }
  const host = ctx as unknown as {
    on?: (event: string, listener: (payload: AgentEvent) => void) => (() => void) | undefined
    get?: (key: string) => unknown
  }
  if (typeof host.on !== 'function') {
    ctx.logger.warn('[dsh-skill-hub] ctx.on unavailable: agent-layer invocation overrides are disabled (global catalog still applies them)')
    return () => {}
  }
  const disposers = new Map<string, () => void>()

  const install = (agent: AgentLike | undefined): void => {
    if (agent === undefined || typeof agent.id !== 'string' || disposers.has(agent.id)) return
    const agentCtx = agent.ctx as { get?: (key: string) => unknown; skills?: unknown } | undefined
    const skills = (agentCtx !== undefined && typeof agentCtx.get === 'function'
      ? agentCtx.get('skills')
      : agentCtx?.skills) as SkillsLike | undefined
    if (skills === undefined || typeof skills.registerProvider !== 'function') {
      ctx.logger.warn('[dsh-skill-hub] agent layer has no skills service; skipping agent-layer registration for ' + String(agent.id))
      return
    }
    const id = agent.id
    let dispose: (() => void) | undefined
    try {
      dispose = skills.registerProvider((control) => ensureProvider(control))
    } catch (error) {
      // Versions up to 0.3.36 kept the agent-layer registration in a plain map
      // that a fibre teardown never released (issue #24). A market
      // self-update replays the profile in-process, so the OLD — unfixed —
      // fibre is the one that just died and its "skill-hub" registration is
      // still there; the host rejects ours as a scoped duplicate.
      //
      // This must never bubble: a failed entry activation makes reloadProfile
      // roll the whole update back, which would leave users permanently unable
      // to install the version that fixes it. Skipping this one agent layer is
      // harmless — the leaked provider instance serves the same store, so
      // invocation overrides still resolve; the next process start has no
      // leaked registration at all.
      if (isDuplicateProviderError(error)) {
        ctx.logger.warn(
          '[dsh-skill-hub] agent layer ' + id + ' already holds a skill-hub provider left by the previous version; skipping agent-layer override until the next restart',
        )
        return
      }
      throw error
    }
    if (dispose !== undefined) {
      // Idempotent: releasing drops the bookkeeping entry FIRST, so a later
      // teardown pass cannot dispose the same registration twice, and a
      // re-install for the same agent is never blocked by a stale entry
      // (issue #24).
      const release = (): void => {
        if (disposers.get(id) !== release) return
        disposers.delete(id)
        dispose()
      }
      disposers.set(id, release)
      ctx.logger.info('[dsh-skill-hub] invocation-override provider registered into agent layer ' + id)
    }
  }
  const uninstall = (agent: AgentLike | undefined): void => {
    if (agent === undefined || typeof agent.id !== 'string') return
    // `release` removes itself from the map, so no manual delete here.
    disposers.get(agent.id)?.()
  }

  const stopCreated = host.on('agent/created', (payload) => install(payload.agent))
  const stopDisposed = host.on('agent/disposed', (payload) => uninstall(payload.agent))
  const agents = typeof host.get === 'function' ? host.get('agents') : undefined
  if (agents !== undefined && typeof (agents as { list?: unknown }).list === 'function') {
    for (const agent of (agents as { list: () => AgentLike[] }).list()) install(agent)
  }

  return () => {
    if (stopCreated !== undefined) stopCreated()
    if (stopDisposed !== undefined) stopDisposed()
    // Snapshot: each `release` deletes itself from the map while iterating.
    for (const release of [...disposers.values()]) release()
    disposers.clear()
  }
}

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const SKILL_HUB_GUIDANCE =
  "本机已安装 dsh-skill-hub 插件（DSH Web GUI 技能中枢）：管理主页在 设置 →「技能中枢」（通用 / 工作区 / 市场 / 回收站），配置卡片在插件管理页（折叠，点标题展开）。能力：全量技能目录的浏览与搜索（项目 / 用户 / 内置及第三方）、按来源 / 目录 / 角色整组启停、市场安装、来源跟踪与同步、跨 agent 与 ZIP 导入、调用统计、诊断与内容审计。限制：只有用户级技能能写能删；所有开关都只写 sidecar 覆盖（关闭模型自动调用，「/技能名」仍可用，源文件不动），内置与运行时技能只读，即时生效无需重启。用户提到「技能管理 / 技能列表 / 技能开关 / 技能同步 / 技能市场 / 更新技能 / 新建技能」时即指本插件，请据此协作。"

/**
 * Mount the skill hub routes and announcement.
 * @param ctx - host plugin context carrying webServer/skills/systemPrompt/settings.
 */
export function apply(ctx: Context, config?: Config): void {
  /**
   * Read the runtime config out of our own volatile config refs.
   *
   * This is the whole point of `volatile()`: the Loader updates those values
   * **in place** (`ConfigEditor.edit` → `resolveConfig(fiber.runtime, next)` →
   * `updateVolatile`) without rebuilding the fiber, so a held reference always
   * answers `.get()` with the current value. Consequences worth remembering:
   *   - no `settings.describe()` per request (it walks and projects every entry
   *     in the profile — the reason this used to be slow);
   *   - no subscription or watcher is needed for *reading*;
   *   - the plugin keeps working when the Settings service is absent
   *     (issue #11: business logic must not depend on Settings).
   */
  const readConfig = (): Partial<HubConfig> => {
    const out: Record<string, unknown> = {}
    for (const field of CONFIG_FIELDS) {
      const ref = (config as unknown as Record<string, { get?: () => unknown } | undefined> | undefined)?.[field]
      const value = ref !== undefined && typeof ref.get === 'function' ? ref.get() : ref
      if (value !== undefined) out[field] = value
    }
    return out as Partial<HubConfig>
  }
  const current = (): HubConfig => resolveHubConfig(readConfig())

  /** The Settings service, when this deployment mounts it. Absent ⇒ no user layer to read or write. */
  const settingsOf = (): SettingsForms | undefined => ctx.get('settings') as SettingsForms | undefined

  const store = new SkillHubStore()
  let disposeRoutes: (() => void) | undefined
  let disposeSection: (() => void) | undefined
  // The hub's own provider contributes user/project skills to the registry's
  // GLOBAL layer — the web app deliberately keeps that layer empty (presets
  // own per-scope discovery), and the GUI needs a session-independent view.
  let disposeProvider: (() => void) | undefined
  // The SAME provider instance is registered once more into every live agent's
  // own skill layer (nearer than the preset layer) so an invocation override
  // can outrank the preset's native filesystem provider — see
  // registerAgentSkillPolicy below.
  let disposeAgentProviders: (() => void) | undefined
  let providerInstance: SkillHubProvider | undefined
  /** One control per skill layer (global + each live agent): an override change must invalidate all of them. */
  const providerControls = new Set<SkillProviderControl>()
  // Optional invocation-count source; only set once a session-query service
  // is present (see the soft inject below). Absent deployments just omit the
  // stats route's data rather than failing to load.
  let stats: SkillStatsReader | undefined

  // The raw saved config layer (fields the user explicitly overrode); the
  // config route reports it so callers can mark overridden fields. Empty when
  // the deployment has no Settings service — the plugin still runs.
  const saved = (): Partial<HubConfig> => {
    const descriptor = settingsOf()?.describe().find((entry) => entry.ns === ENTRY_ID)
    return (descriptor?.user as Partial<HubConfig> | undefined) ?? {}
  }

  // Persist a config patch through the settings transport. A patch value of
  // undefined clears the saved override — expressed as a path `unset`, which
  // makes the field fall back to its inherited value instead of writing a
  // literal undefined (the old sidecar's reset semantics). The write reloads
  // this Loader entry, so apply() re-runs and re-syncs every surface below.
  const updateConfig = async (patch: Partial<HubConfig>): Promise<HubConfig> => {
    const ops: SettingsPathOp[] = []
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) ops.push({ op: 'unset', path: [field] })
      else ops.push({ op: 'set', path: [field], value })
    }
    const settings = settingsOf()
    if (settings === undefined) throw new Error('this deployment does not mount the settings service; config is read-only')
    if (ops.length > 0) {
      await settings.mutate(ENTRY_ID, ops)
      // A settings write updates this entry's values in place WITHOUT
      // re-entering apply() (see `current`), so the section / provider / routes
      // registered from the old values would otherwise keep serving them until
      // a restart. Re-evaluate here, where we know the write landed.
      sync()
    }
    return current()
  }

  // Register (or drop) every surface to match the current config. Each
  // group is kept under one disposer: re-registering first tears the old
  // one down so duplicate-name registrations never throw. The route family
  // (including the config route) stays mounted even with the master switch
  // off so the settings card can always read and re-enable the hub; the
  // business routes answer 503 while disabled.
  /**
   * Whether this plugin's fiber is still mounted.
   *
   * Async work started from `apply()` — the stats wiring and the persistence
   * probe — can settle after the fiber unloaded: a config rewrite reloads the
   * plugin, and disable/enable tears it down. Service reads on an inactive
   * context throw instead of returning undefined, so every continuation
   * re-checks this before touching `ctx` (issue #19: a cold-start abort with
   * `cannot get required service "systemPrompt" in inactive context`).
   *
   * The generation counters cannot cover this: they only invalidate a build
   * superseded by a *newer* build, and teardown does not bump them.
   */
  const mounted = (): boolean => {
    // `fiber` has always been public on a Cordis context, but stay tolerant of
    // a host whose Cordis predates it: absent means "we cannot tell", and the
    // pre-#19 behaviour is the safer answer there.
    const fiber = (ctx as { fiber?: { uid: number | null } }).fiber
    return fiber === undefined || fiber.uid !== null
  }

  /** Logger for continuations that may outlive the fiber (#19). */
  const logInfo = (message: string): void => {
    if (mounted()) ctx.logger.info(message)
  }
  const logWarn = (message: string, error?: unknown): void => {
    if (!mounted()) return
    if (error === undefined) ctx.logger.warn(message)
    else ctx.logger.warn(message, error)
  }

  const sync = (): void => {
    // A late stats continuation may still reach here after teardown (#19).
    if (!mounted()) return
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeProvider !== undefined) {
      disposeProvider()
      disposeProvider = undefined
    }
    if (disposeAgentProviders !== undefined) {
      disposeAgentProviders()
      disposeAgentProviders = undefined
    }
    providerInstance = undefined
    const value = current()
    // GitHub auth for market/source API calls: env GITHUB_TOKEN/GH_TOKEN is the
    // fallback (read at module load); an explicit settings value wins and is
    // applied by re-running this sync from updateConfig after the write lands.
    setGithubToken(value.githubToken)
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
      providerControls.clear()
      providerInstance = undefined
      const overrides = async (): Promise<ReadonlySet<string>> => new Set(await store.listInvocationOverrides())
      // 惰性创建：global 与各 agent 层的 factory 共享同一实例（watch 定时器
      // 只起一个），但每个注册的 control 都收进集合 —— override 变化必须
      // 让所有层的缓存一起失效，只刷 global 会让 agent 视角仍旧看到旧状态。
      const ensureProvider = (control: SkillProviderControl): SkillHubProvider => {
        providerControls.add(control)
        if (providerInstance === undefined) {
          providerInstance = new SkillHubProvider(control, dshHome(), overrides)
        }
        return providerInstance
      }
      disposeProvider = ctx.effect(
        () => ctx.skills.registerProvider((control) => ensureProvider(control)),
        'dsh-skill-hub: provider',
      )
      // Must be fibre-bound like the global provider above: a market
      // self-update replays the profile in-process, the old fibre is torn
      // down while agents stay alive, and an agent-layer registration that
      // outlived its fibre would make the new fibre's registerProvider throw
      // "already registered in this scope" — the update then rolls back
      // (issue #24).
      disposeAgentProviders = ctx.effect(() => {
        const dispose = registerAgentSkillPolicy(ctx, ensureProvider)
        return () => {
          dispose()
        }
      }, 'dsh-skill-hub: agent providers')
    }
    ctx.logger.info(`[dsh-skill-hub] surfaces synced: enabled=${value.enabled} announceToAgent=${value.announceToAgent}`)
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    disposeRoutes = ctx.effect(
      () => {
        // A non-web profile has no HTTP surface at all. Skipping here keeps the
        // plugin activated (skills provider + dots still work) instead of
        // blocking the whole boot on a service that can never arrive.
        const webServer = ctx.get('webServer')
        if (webServer === undefined) {
          logInfo('[dsh-skill-hub] webServer absent — HTTP routes skipped (non-web profile)')
          return () => {}
        }
        const disposers = makeRoutes({
          skills: ctx.skills,
          store,
          // The host's own `/api` trust fence (loopback ∪ bind address ∪
          // --trusted-host ∪ browser session). Read per request: Connection
          // may be provided after this plugin starts, and a one-shot read here
          // would latch the literal-loopback fallback for the whole process.
          // A *persistent* absence means the upstream composition changed —
          // say so once instead of silently re-creating issue #17.
          fence: hostTrustFence(
            () => ctx.get('connection'),
            () => ctx.logger.warn('[dsh-skill-hub] Connection service absent: routes fall back to literal-loopback; reverse-proxy deployments will 403 until it mounts'),
          ),
          invalidate: () => {
            for (const control of providerControls) control.invalidate()
          },
          stats,
          config: current,
          saved,
          updateConfig,
        }).map((route) => webServer.register(route))
        return () => {
          for (const dispose of disposers) dispose()
        }
      },
      'dsh-skill-hub: routes',
    )
  }

  // Initial registration from the composition entry. Later changes — the
  // settings page, the config route, the Host document editor — rewrite this
  // Loader entry, which re-enters apply(), so no in-process watcher is needed.
  sync()

  // One-time migration: an install upgraded from the sidecar-configured
  // build seeds the settings namespace from the saved sidecar config when the
  // namespace has no user section yet. Later edits live only in the settings
  // document; the sidecar keeps its (now-stale) copy untouched.
  // Startup: 清理 Issue #3 遗留的 .*.import-* 临时目录（尽早回收，不阻塞）
  void (async () => {
    const home = dshHome()
    const configuredAgentsHome = process.env.DSH_AGENTS_HOME?.trim()
    const agentsHome = configuredAgentsHome !== undefined && configuredAgentsHome !== '' ? configuredAgentsHome : join(homedir(), '.agents')
    for (const root of [join(home, 'skills'), join(agentsHome, 'skills')]) {
      try {
        const c = await cleanupLeftoverImportDirs(root)
        if (c > 0) logInfo(`[dsh-skill-hub] startup cleaned ${c} leftover import temp dir(s) in ${root}`)
      } catch (error) {
        logWarn('[dsh-skill-hub] startup cleanup failed', error)
      }
    }
    // 一次性迁移：旧版本靠把 SKILL.md 改名成 SKILL.md.disabled 来停用，新版
    // 改成写策略、文件不动。必须最先跑，否则老用户升级后停用技能会全部复活。
    try {
      const migrated = await migrateRenamedDisabledSkills(store, home)
      if (migrated.length > 0) logInfo(`[dsh-skill-hub] startup migrated ${migrated.length} renamed disabled skill(s) to policy overrides`)
    } catch (error) {
      logWarn('[dsh-skill-hub] startup disabled-skill migration failed', error)
    }
    // 对账：迁移后处理残留的 .disabled、sidecar 缺记录等历史情况。
    try {
      const reconciled = await reconcileDisabledSkills(store, home)
      if (reconciled.length > 0) {
        logInfo(`[dsh-skill-hub] startup reconciled ${reconciled.length} disabled skill record(s): ${reconciled.map((entry) => entry.name).join(', ')}`)
      }
    } catch (error) {
      logWarn('[dsh-skill-hub] startup disabled-skill reconcile failed', error)
    }
    // 反向对账：记录还在、文件已不在 → 修路径或删记录。不做这一步，那条记录会
    // 把名字永久锁死（启用/新建/删除三条路都失败）。
    try {
      const pruned = await pruneStaleDisabledSkills(store, home)
      if (pruned.repaired.length > 0 || pruned.removed.length > 0) {
        logInfo(`[dsh-skill-hub] startup pruned disabled records: repaired ${pruned.repaired.length} (${pruned.repaired.map((entry) => entry.name).join(', ') || '-'}), removed ${pruned.removed.length} (${pruned.removed.join(', ') || '-'})`)
      }
    } catch (error) {
      logWarn('[dsh-skill-hub] startup disabled-record prune failed', error)
    }
    // 回收站对账：记录还在、目录已不在 → 删记录。不做这一步，「恢复」按钮会
    // 永远失败（rename ENOENT），而「永久删除」因为 rm --force 反而成功 ——
    // 同一条记录的两条撤销路径表现相反。
    try {
      const prunedTrash = await pruneStaleTrash(store)
      if (prunedTrash.length > 0) {
        logInfo(`[dsh-skill-hub] startup pruned ${prunedTrash.length} stale trash record(s): ${prunedTrash.map((entry) => entry.name).join(', ')}`)
      }
    } catch (error) {
      logWarn('[dsh-skill-hub] startup trash-record prune failed', error)
    }
  })()

  void (async () => {
    try {
      const legacy = await store.getConfig()
      // The read is awaited; the plugin may have unloaded meanwhile (#19).
      if (!mounted()) return
      if (Object.keys(legacy).length > 0 && Object.keys(saved()).length === 0) {
        const settings = settingsOf()
        if (settings !== undefined) await settings.update(ENTRY_ID, legacy as Record<string, unknown>)
      }
    } catch (error) {
      logWarn('[dsh-skill-hub] sidecar config migration into the settings namespace failed', error)
    }
  })()

  // Optional trigger statistics: while a session-query service exists, wire a
  // cached invocation-count reader into the stats route. Re-running sync()
  // re-registers the routes with the reader attached (mirrors the optional
  // stats wiring — no sessionQuery service ever mounted means none of this
  // runs).
  //
  // Read-path preference: the host's sessionPersistence seam serves raw stored
  // logs (decompress + parse only — no Session restore/validation, the host
  // cost that OOMed large histories, see issue #7), with the query seam
  // covering live sessions. Without a persistence service the reader falls
  // back to sequential query reads. Scans are strictly lazy: the first one
  // starts on the panel's first /stats poll, never at plugin startup (a
  // headless boot with no browser must not pay for statistics nobody reads).
  //
  // Mount ordering between the two host services is not guaranteed, so the
  // reader is (re-)built generation-guarded: a query-only reader wires
  // immediately, and a later-arriving persistence service upgrades it to the
  // cold path. A superseded build never assigns.
  let statsQuery: SessionQueryLike | undefined
  let statsPersistence: SessionPersistenceLike | undefined
  let statsGeneration = 0
  const wireStats = (): void => {
    const query = statsQuery
    if (query === undefined) return
    const generation = ++statsGeneration
    const cold = statsPersistence
    void (async () => {
      // 恢复 sidecar 里的增量扫描检查点后再建 reader（异步、不阻塞）：
      // 重启后无需重新解压全部历史日志；每次扫描完都落盘（含上次总数），所以
      // 重启后面板秒出旧数、后台重扫。扫描间隔与滚动窗口都从设置命名空间
      // 实时读取——卡片里改完即生效，无需重启。
      const checkpoint = await store.getSkillStatsState().catch(() => undefined)
      if (generation !== statsGeneration || !mounted()) return
      const scanMinutes = (): number => {
        const value = current().statsScanMinutes
        return typeof value === 'number' && value >= 1 ? Math.floor(value) : HUB_CONFIG_DEFAULTS.statsScanMinutes
      }
      const windowDays = (): number => {
        const value = current().statsWindowDays
        return typeof value === 'number' && value >= 0 ? Math.floor(value) : HUB_CONFIG_DEFAULTS.statsWindowDays
      }
      const reader = createSkillStatsReader(query, () => scanMinutes() * 60_000, {
        checkpoint,
        windowDays,
        ...(cold === undefined ? {} : {
          persistence: cold,
          listLiveIds: async () => {
            try {
              const records = await query.listSessions()
              return records.filter((record) => (record as { live?: unknown }).live === true).map((record) => record.header.id)
            } catch {
              return []
            }
          },
          readLiveSession: async (id) => {
            try {
              return { events: (await query.readSession(id)).events }
            } catch {
              return undefined
            }
          },
        }),
        onCheckpoint: (next) => {
          void store.saveSkillStatsState(next).catch((error) => {
            if (mounted()) ctx.logger.warn('[dsh-skill-hub] persisting skill-stats checkpoint failed', error)
          })
        },
      })
      if (generation !== statsGeneration || !mounted()) return
      ctx.logger.info(`[dsh-skill-hub] stats seam: ${cold === undefined ? 'session-query (fallback)' : 'session-persistence (cold)'}`)
      stats = reader
      sync()
    })()
  }
  ctx.inject(['sessionQuery'], (sctx) => {
    statsQuery = sctx.sessionQuery
    wireStats()
    // The persistence service may mount after the query service: upgrade the
    // reader when it arrives (no-op when it never does).
    sctx.inject(['sessionPersistence'] as unknown as ['sessionQuery'], (pctx) => {
      void (async () => {
        const raw = (pctx as unknown as { sessionPersistence?: unknown }).sessionPersistence
        const seam = asPersistenceSeam(raw)
        if (seam === undefined) {
          if (mounted()) ctx.logger.warn('[dsh-skill-hub] sessionPersistence shape mismatch, staying on query fallback')
          return
        }
        try {
          await seam.list() // probe: headers only, must succeed before trusting the cold path
        } catch (error) {
          if (mounted()) ctx.logger.warn('[dsh-skill-hub] persistence seam probe failed, staying on query fallback', error)
          return
        }
        // The probe is awaited, so the plugin may have unloaded meanwhile (#19).
        if (!mounted()) return
        statsPersistence = seam
        wireStats()
      })()
    })
  })
}
