/**
 * The /api/skill-hub route family: full catalog (enabled skills from the
 * official registry + hub-disabled skills + discovery diagnostics), skill
 * detail, enable/disable toggle, new-skill scaffold, user groups (tags +
 * origin collections), and upstream source tracking (check/sync/follow
 * upstream deletion into a restorable trash). Every route carries a
 * loopback-only trust fence — these endpoints rename files under the user's
 * skill roots, so LAN-exposed dsh web deployments must not serve them.
 *
 * 按域拆分后的聚合入口：各域 handler 在 ./routes/<domain>.ts，共享围栏在
 * ./routes/helpers.ts，节流/任务状态在 ./routes/route-state.ts。
 * 老 `from './routes.ts'`（makeRoutes + SkillHubRouteDeps）保持可用。
 */

import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { SKILL_HUB_API_ROOT } from './protocol.ts'
import { createRoute, writeError, type SkillHubRouteDeps, type SkillLookupLike } from './routes/helpers.ts'
import { catalogRoutes } from './routes/catalog.ts'
import { configRoutes } from './routes/config.ts'
import { marketRoutes } from './routes/market.ts'
import { repoImportRoutes } from './routes/repo-import.ts'
import { groupRoutes } from './routes/groups.ts'
import { sourceRoutes } from './routes/sources.ts'

export type { SkillHubRouteDeps, SkillLookupLike } from './routes/helpers.ts'

/**
 * Build every /api/skill-hub route.
 * @param deps - skill registry view + sidecar store.
 * @returns the exact-path routes plus the family's 404 catch-all.
 */
export function makeRoutes(deps: SkillHubRouteDeps): WebRoute[] {
  // 各域返回裸 spec，统一在这里包上请求围栏（回环信任 → 方法 → 总开关
  // → JSON 体 → 统一错误映射），新路由不会漏掉围栏。
  const specs = [
    ...catalogRoutes(deps),
    ...configRoutes(deps),
    ...marketRoutes(deps),
    ...repoImportRoutes(deps),
    ...groupRoutes(deps),
    ...sourceRoutes(deps),
  ]
  return [
    ...specs.map((spec) => createRoute(deps, spec)),
    // 兜底：本族的未知路径。插件只注册精确路径，未命中的请求会落到宿主的
    // SPA fallback，那里对 /api/* 统一回 401，排查时极易被误判成鉴权/令牌
    // 问题，而真实原因是路径写错。这个 prefix 路由把整族纳入命名路由表，
    // 于是未知路径在宿主侧变成「已命中」→ 由我们回一个写明路径的 404。
    // 匹配顺序保证安全：宿主先查精确表、再按最长前缀命中，本路由不可能
    // 抢走任何已注册的精确路由。
    createRoute(deps, {
      kind: 'prefix',
      path: SKILL_HUB_API_ROOT,
      methods: ['GET', 'POST'],
      skipGate: true,
      handler: async ({ res, url }) => {
        writeError(res, 404, 'unknown skill-hub route: ' + url.pathname + ' (see SKILL_HUB_API in src/protocol/api.ts)')
      },
    }),
  ]
}
