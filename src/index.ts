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
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-settings'
import { HUB_CONFIG_DEFAULTS, HUB_ENTRY_ID, HEX_COLOR_RE, resolveHubConfig, type HubConfig } from './protocol.ts'
import { SkillHubProvider } from './provider.ts'
import { makeRoutes } from './routes.ts'
import { createSkillStatsReader, asPersistenceSeam, type SessionPersistenceLike, type SessionQueryLike, type SkillStatsReader } from './stats.ts'
import { SkillHubStore } from './store.ts'
import { reconcileDisabledSkills } from './reconcile.ts'
import { cleanupLeftoverImportDirs, setGithubToken } from './repo.ts'
import { dshHome } from './store.ts'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'skill-hub'

/** Services required before the skill-hub surfaces can mount. `settings` is deliberately NOT here: the plugin reads its own volatile config refs and only reaches for the settings service when it is present (issue #11). */
export const inject = ['webServer', 'skills', 'systemPrompt']

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

/** Every config field, in the order the settings page renders them (used to walk the volatile refs). */
const CONFIG_FIELDS = [
  'enabled',
  'announceToAgent',
  'dotModelColor',
  'dotUserColor',
  'showUseCount',
  'showUseTime',
  'showGroupSummary',
  'statsWindowDays',
  'statsScanMinutes',
  'githubToken',
] as const

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 152

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const SKILL_HUB_GUIDANCE = [
  '本机已安装 dsh-skill-hub 插件（DSH Web GUI 技能中枢）：设置 →「技能」分区为管理主页；本插件的配置页（启用/公告开关、圆点颜色、GitHub token、统计窗口）在插件管理页——侧边栏「插件」→ 本插件，是本插件自己注册的配置卡片（默认折叠，点标题展开）。能力：完整本地技能目录（项目/自定义/用户/内置全部来源，走官方 ctx.skills 注册表，含第三方 provider）；按来源与自定义分组浏览，分组/来源头部的滑动开关可一键启用/禁用整组（跨组冲突时询问）；市场：内置市场目录（精选仓库一键添加）加自定义仓库源，扫描后勾选安装，每个市场源行显示已装/可更新/上游已删数量，支持「检查全部」与「全部更新」；来源跟踪：从 GitHub 仓库（市场源或直接地址）导入的技能记录上游 repo/commit 快照，可检查更新、选择同步、上游删除时跟进删除（移入回收站可恢复，恢复后保留来源与场景归属）；个人技能（无来源记录）不跟踪；调用次数与最近使用时间统计；查看技能正文；发现诊断；新建技能向导（写入 ~/.dsh/skills 或 ~/.agents/skills）。限制：仅用户级技能（user-dsh/user-agents 根目录）可写，项目/内置/运行时技能只读展示；路由仅回环可访问。用户提到「技能管理 / 技能列表 / 技能开关 / 技能同步 / 技能市场 / 更新技能 / 新建技能」时即指本插件，请据此协作。',
  'The dsh-skill-hub plugin is installed (the DSH Web GUI skill hub): Settings → "Skills" is the management page; the plugin\'s configuration page (enable / announcement toggles, dot colors, GitHub token, stats window) is registered by the plugin itself on its own page in the Plugins manager (sidebar → 插件 → the plugin; collapsed until you expand the title). Capabilities: full local skill catalog (project / custom / user / bundled roots via the official ctx.skills registry, including third-party providers); browsing by source and custom groups, each group header carrying a sliding switch to enable/disable the whole group in one click (cross-group conflicts prompt the user); market: a built-in catalog of curated repos (one-click add) plus custom repo sources, scan-and-install import, per-source installed / updatable / deleted-upstream badges with "check all" and "update all" actions; upstream source tracking: skills imported from GitHub repos (market sources or direct URLs) record the repo/commit snapshot, support update checks, selective sync, and follow-up deletion when the upstream removes a skill (moves it into a restorable trash; restoring keeps the source and scene membership); personal skills (no source record) are never tracked; invocation counts and last-used times; skill body inspection; discovery diagnostics; new-skill wizard (writes to ~/.dsh/skills or ~/.agents/skills). Limits: only user-level skills (user-dsh/user-agents roots) are writable; project/bundled/runtime skills are read-only; routes are loopback-only. When the user mentions "skill management / skill list / skill toggle / skill sync / skill market / update skills / new skill", this plugin is what they mean — collaborate accordingly.'
].join('\n\n')

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
  const current = (): HubConfig => resolveHubConfig({}, readConfig())

  /** The Settings service, when this deployment mounts it. Absent ⇒ no user layer to read or write. */
  const settingsOf = (): SettingsForms | undefined => ctx.get('settings') as SettingsForms | undefined

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
      providerControl = undefined
      disposeProvider = ctx.effect(
        () => ctx.skills.registerProvider((control) => {
          providerControl = control
          return new SkillHubProvider(control)
        }),
        'dsh-skill-hub: provider',
      )
    }
    ctx.logger.info(`[dsh-skill-hub] surfaces synced: enabled=${value.enabled} announceToAgent=${value.announceToAgent}`)
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
          saved,
          updateConfig,
        }).map((route) => ctx.webServer.register(route))
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
    const agentsHome = process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')
    for (const root of [join(home, 'skills'), join(agentsHome, 'skills')]) {
      try {
        const c = await cleanupLeftoverImportDirs(root)
        if (c > 0) ctx.logger.info(`[dsh-skill-hub] startup cleaned ${c} leftover import temp dir(s) in ${root}`)
      } catch (error) {
        ctx.logger.warn('[dsh-skill-hub] startup cleanup failed', error)
      }
    }
    // 对账：磁盘上已有 .disabled、sidecar 却无记录（状态文件被恢复/手改、旧版本
    // 遗留）时补记录，否则这些技能在面板里既不算启用也不算禁用，来源组空壳。
    try {
      const reconciled = await reconcileDisabledSkills(store, home)
      if (reconciled.length > 0) {
        ctx.logger.info(`[dsh-skill-hub] startup reconciled ${reconciled.length} disabled skill record(s): ${reconciled.map((entry) => entry.name).join(', ')}`)
      }
    } catch (error) {
      ctx.logger.warn('[dsh-skill-hub] startup disabled-skill reconcile failed', error)
    }
  })()

  void (async () => {
    try {
      const legacy = await store.getConfig()
      if (Object.keys(legacy).length > 0 && Object.keys(saved()).length === 0) {
        const settings = settingsOf()
        if (settings !== undefined) await settings.update(ENTRY_ID, legacy as Record<string, unknown>)
      }
    } catch (error) {
      ctx.logger.warn('[dsh-skill-hub] sidecar config migration into the settings namespace failed', error)
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
      if (generation !== statsGeneration) return
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
            ctx.logger.warn('[dsh-skill-hub] persisting skill-stats checkpoint failed', error)
          })
        },
      })
      if (generation !== statsGeneration) return
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
          ctx.logger.warn('[dsh-skill-hub] sessionPersistence shape mismatch, staying on query fallback')
          return
        }
        try {
          await seam.list() // probe: headers only, must succeed before trusting the cold path
        } catch (error) {
          ctx.logger.warn('[dsh-skill-hub] persistence seam probe failed, staying on query fallback', error)
          return
        }
        statsPersistence = seam
        wireStats()
      })()
    })
  })
}
