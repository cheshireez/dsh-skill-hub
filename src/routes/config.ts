/**
 * 配置域路由：config（总开关开着也可用，设置卡自救入口）/ update 自身更新
 * 检查 / diagnosticFix。从 routes.ts 原样搬出，handler 逻辑不变。
 */

import {
  SKILL_HUB_API,
  GITHUB_TOKEN_RE,
  HEX_COLOR_RE,
  type ConfigResponse,
  type DiagnosticFixRequest,
  type DiagnosticFixResponse,
  type HubConfig,
} from '../protocol.ts'
import { fixDiagnosticFile } from '../skillfs.ts'
import { checkLatestRelease, CURRENT_VERSION } from '../update.ts'
import {
  configOf,
  homeOf,
  savedOf,
  writeError,
  writeJson,
  writeRouteError,
  type RouteSpec,
  type SkillHubRouteDeps,
} from './helpers.ts'

/** 配置域全部路由 spec（由 routes.ts 经 createRoute 包上统一围栏）。 */
export function configRoutes(deps: SkillHubRouteDeps): RouteSpec[] {
  return [
    // --------------------------------------------------------------- config
    // The config route stays mounted even with the master switch off, so the
    // settings card can always read and re-enable the hub.
    {
      path: SKILL_HUB_API.config,
      methods: ['GET', 'POST'],
      jsonBody: true,
      skipGate: true,
      handler: async ({ req, res, body }) => {
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, pluginVersion: CURRENT_VERSION, config: configOf(deps), saved: savedOf(deps) } satisfies ConfigResponse)
          return
        }
        const raw = body
        const patch: Partial<HubConfig> = {}
        if (raw.enabled !== undefined) {
          if (raw.enabled === null) patch.enabled = undefined
          else if (typeof raw.enabled !== 'boolean') { writeError(res, 400, 'enabled must be a boolean or null'); return }
          else patch.enabled = raw.enabled
        }
        if (raw.announceToAgent !== undefined) {
          if (raw.announceToAgent === null) patch.announceToAgent = undefined
          else if (typeof raw.announceToAgent !== 'boolean') { writeError(res, 400, 'announceToAgent must be a boolean or null'); return }
          else patch.announceToAgent = raw.announceToAgent
        }
        for (const key of ['showUseCount', 'showUseTime', 'showGroupSummary'] as const) {
          const value = raw[key]
          if (value === undefined) continue
          if (value === null) { patch[key] = undefined; continue }
          if (typeof value !== 'boolean') { writeError(res, 400, key + ' must be a boolean or null'); return }
          patch[key] = value
        }
        for (const key of ['dotModelColor', 'dotUserColor'] as const) {
          const value = raw[key]
          if (value === undefined) continue
          if (value === null) { patch[key] = undefined; continue }
          if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) { writeError(res, 400, key + ' must be a #rrggbb color or null'); return }
          patch[key] = value
        }
        if (raw.githubToken !== undefined) {
          const value = raw.githubToken
          if (value === null) { patch.githubToken = undefined; /* cleared → anonymous/env */ }
          else if (typeof value !== 'string' || value.trim() === '') { patch.githubToken = undefined }
          else if (!GITHUB_TOKEN_RE.test(value.trim())) { writeError(res, 400, 'githubToken looks invalid (expected a personal access token)'); return }
          else patch.githubToken = value.trim()
        }
        let config: HubConfig
        if (deps.updateConfig === undefined) {
          const merged: HubConfig = { ...configOf(deps) }
          for (const [key, value] of Object.entries(patch) as Array<[keyof HubConfig, boolean | string | undefined]>) {
            if (value === undefined) delete merged[key]
            else (merged as unknown as Record<string, unknown>)[key] = value
          }
          config = merged
        } else {
          config = await deps.updateConfig(patch)
        }
        writeJson(res, 200, { ok: true, pluginVersion: CURRENT_VERSION, config, saved: savedOf(deps) } satisfies ConfigResponse)
      },
    },
    // -------------------------------------------------------------- update
    // 自身更新检查：查询 GitHub latest release。
    {
      path: SKILL_HUB_API.update,
      methods: ['GET'],
      handler: async ({ res }) => {
        writeJson(res, 200, await checkLatestRelease())
      },
    },
    // -------------------------------------------------------- diagnostic fix
    {
      path: SKILL_HUB_API.diagnosticFix,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as DiagnosticFixRequest
        const rawPath = typeof request.path === 'string' ? request.path.trim() : ''
        if (rawPath === '') { writeError(res, 400, 'path is required'); return }
        try {
          await fixDiagnosticFile(rawPath, homeOf(deps))
          deps.invalidate?.()
          writeJson(res, 200, { ok: true, path: rawPath } satisfies DiagnosticFixResponse)
        } catch (error) {
          writeRouteError(res, error)
        }
      },
    },
  ]
}
