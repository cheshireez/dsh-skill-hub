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
import { createRoute, type SkillHubRouteDeps, type SkillLookupLike } from './routes/helpers.ts'
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
 * @returns the exact-path routes.
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
  return specs.map((spec) => createRoute(deps, spec))
}
