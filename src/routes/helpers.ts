/**
 * routes 共享层：请求围栏（回环信任/方法/总开关/JSON 体）、统一错误映射、
 * 可写技能解析、目录/分组数据装配。handler 只写业务，从这里 import。
 * 从 routes.ts 原样搬出，行为不变。
 * 本文件是聚合出口（barrel）：实现按域拆到 ./http.ts（围栏/错误映射/读体）、
 * ./deps.ts（依赖视图/可写解析）、./collection.ts（集合装配）、
 * ./catalog-data.ts（目录装配）；对外导出面保持不变。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { disabledGate, type SkillHubRouteDeps } from './deps.ts'
import { isLoopbackRequest, readJsonBody, writeError, writeRouteError } from './http.ts'

export {
  MAX_JSON_BODY_BYTES,
  STORE_ERROR_STATUS,
  isLoopbackRequest,
  pathExists,
  queryParam,
  readJsonBody,
  readString,
  readStrings,
  writeError,
  writeJson,
  writeRouteError,
} from './http.ts'
export {
  configOf,
  disabledGate,
  homeOf,
  isWritableSource,
  resolveWritableSkill,
  savedOf,
} from './deps.ts'
export type {
  SkillHubRouteDeps,
  SkillLookupLike,
  WritableSkill,
  WritableSkillRefusal,
  WritableSkillResult,
} from './deps.ts'
export { buildCollections, buildGroups } from './collection.ts'
export {
  applyInterface,
  buildCatalog,
  knownSkillNames,
  toDetail,
  workspaceEntries,
} from './catalog-data.ts'
export type { WorkspaceEntry } from './catalog-data.ts'

/** What a route handler receives: fences already passed, URL/body prepared. */
export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  /** Request URL parsed against a localhost base (query reading for GET). */
  url: URL
  /** Parsed JSON body; empty object for requests without one. */
  body: Record<string, unknown>
}

export type RouteHandler = (context: RouteContext) => Promise<void>

/** One declarative route: path + accepted methods + the business handler. */
export interface RouteSpec {
  path: string
  /** Accepted HTTP methods; anything else answers 405. */
  methods: readonly ('GET' | 'POST')[]
  /** POST requests must carry a JSON body (400 when missing/unparseable). */
  jsonBody?: boolean
  /** Skip the master-switch gate (the config route stays up while disabled). */
  skipGate?: boolean
  handler: RouteHandler
}

/**
 * Wrap one handler in the shared request fences. Order matches the
 * original per-handler prologue: loopback trust → HTTP method → master
 * switch → JSON body. The outer catch maps errors onto the JSON error
 * body (preserving RepoFetchError status codes).
 */
export function createRoute(deps: SkillHubRouteDeps, spec: RouteSpec): WebRoute {
  return {
    kind: 'exact',
    path: spec.path,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
      if (!spec.methods.includes(req.method as 'GET' | 'POST')) {
        writeError(res, 405, 'method not allowed: ' + (req.method ?? ''))
        return
      }
      if (spec.skipGate !== true && disabledGate(deps, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      let body: Record<string, unknown> = {}
      if (spec.jsonBody === true && req.method === 'POST') {
        const parsed = await readJsonBody(req)
        if (parsed === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        body = parsed
      }
      try {
        await spec.handler({ req, res, url, body })
      } catch (error) {
        writeRouteError(res, error)
      }
    },
  }
}
