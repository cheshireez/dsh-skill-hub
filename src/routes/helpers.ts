/**
 * routes 共享层：请求栅栏（宿主 /api 信任模型 → 方法 → 总开关 → JSON 体）、
 * 统一错误映射、可写技能解析、目录/分组数据装配。handler 只写业务，从这里 import。
 * 本文件是聚合出口（barrel）：实现按域拆到 ./http.ts（栅栏/错误映射/读体）、
 * ./deps.ts（依赖视图/可写解析）、./collection.ts（集合装配）、
 * ./catalog-data.ts（目录装配）；对外导出面保持不变。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute, WebRouteKind } from '@deepseek-ai/dsh-host-webserver'
import { SKILL_HUB_WRITE_HEADER, SKILL_HUB_WRITE_VALUE } from '../protocol.ts'
import { disabledGate, type SkillHubRouteDeps } from './deps.ts'
import { loopbackOnlyFence, MAX_BINARY_BODY_BYTES, MAX_JSON_BODY_BYTES, PayloadTooLargeError, readBinaryBody, readJsonBody, writeError, writeRouteError } from './http.ts'

export {
  MAX_BINARY_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
  PayloadTooLargeError,
  STORE_ERROR_STATUS,
  isLoopbackRequest,
  loopbackOnlyFence,
  pathExists,
  queryParam,
  readBinaryBody,
  readJsonBody,
  readString,
  readStrings,
  writeError,
  writeJson,
  writeRouteError,
} from './http.ts'
export type { RouteFence } from './http.ts'
export {
  configOf,
  disabledGate,
  homeOf,
  isWritableSource,
  resolveWritableSkill,
  savedOf,
  userHomeOf,
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
  /** Raw binary body, only present on `binaryBody` routes. */
  raw?: Buffer
}

export type RouteHandler = (context: RouteContext) => Promise<void>

/** One declarative route: path + accepted methods + the business handler. */
export interface RouteSpec {
  path: string
  /**
   * Match kind: 'exact' (default) matches the pathname verbatim; 'prefix'
   * matches the path and everything beneath it. The webserver consults the
   * exact table first and then resolves prefixes longest-first, so a prefix
   * route is a catch-all that can never shadow a real route.
   */
  kind?: WebRouteKind
  /** Accepted HTTP methods; anything else answers 405. */
  methods: readonly ('GET' | 'POST')[]
  /** POST requests must carry a JSON body (400 when missing/unparseable). */
  jsonBody?: boolean
  /**
   * POST requests are read as raw bytes instead of JSON (ZIP uploads). Mutually
   * exclusive with `jsonBody`; the handler reads `context.raw`.
   */
  binaryBody?: boolean
  /** Skip the master-switch gate (the config route stays up while disabled). */
  skipGate?: boolean
  /**
   * Skip the write-marker check. Only for routes that touch nothing on disk and
   * whose whole purpose is an accurate diagnostic — the unknown-path catch-all
   * must answer 404-with-the-path, because being read as an auth failure (403)
   * is exactly the confusion it was added to remove.
   */
  skipCsrf?: boolean
  /** 进全局写队列串行执行（读改写同一份 sidecar 状态的路由需要）。 */
  serialize?: boolean
  handler: RouteHandler
}

/**
 * 写操作串行队列：标记为 `serialize` 的路由共用一条 Promise 链，避免多标签页
 * 或网络重试的两次写在 sidecar 上「读 → 改 → 写」交错。前一个失败不阻断后一个。
 * 出网较久的 POST（check / scan / import）不标 serialize，否则一个慢请求会把
 * 开关这类即时操作一起堵住。参照 dsh-skills-manager 的 enqueueMutation。
 *
 * 为什么只标 toggle / toggle-batch：sidecar 本身已有 SkillHubStore.writeChain
 * 串行化所有 persist，且 payload 在 queued step 内构建（并发变更不会互相覆盖），
 * 所有 handler 共享同一个 store 单例、读到的内存态总是最新。其余写路由即使并发，
 * 也由这层保证最终一致；把它们塞进队列只会让慢导入堵住即时开关。
 */
let mutationQueue: Promise<unknown> = Promise.resolve()
function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const queued = mutationQueue.then(task, task)
  mutationQueue = queued.catch(() => undefined)
  return queued
}

/**
 * Wrap one handler in the shared request fences. Order matches the
 * original per-handler prologue: trust fence → HTTP method → master
 * switch → JSON body. The outer catch maps errors onto the JSON error
 * body (preserving RepoFetchError status codes).
 *
 * The trust fence is the host's `/api` model (`deps.fence`) whenever the
 * composition mounts Connection, so a reverse-proxied deployment is judged by
 * the same authorities dsh already trusts; without that service the historical
 * literal-loopback check stands in.
 */
export function createRoute(deps: SkillHubRouteDeps, spec: RouteSpec): WebRoute {
  const fence = deps.fence ?? loopbackOnlyFence
  return {
    kind: spec.kind ?? 'exact',
    path: spec.path,
    handler: async (req, res) => {
      const rejection = fence(req)
      if (rejection !== undefined) {
        writeError(res, rejection, rejection === 401 ? 'unauthorized: browser session required' : 'forbidden: untrusted authority')
        return
      }
      if (!spec.methods.includes(req.method as 'GET' | 'POST')) {
        writeError(res, 405, 'method not allowed: ' + (req.method ?? ''))
        return
      }
      // 写接口要求本插件页面才会带的标记头：跨站来源可以伪造 Host/Origin 之外的
      // 很多东西，但伪造不出一个能通过 CORS 的自定义头。放在方法检查之后，
      // 这样 OPTIONS/PUT 仍然先得到语义正确的 405 而不是「缺头」。
      if (spec.skipCsrf !== true && req.method === 'POST' && req.headers[SKILL_HUB_WRITE_HEADER] !== SKILL_HUB_WRITE_VALUE) {
        writeError(res, 403, 'forbidden: missing ' + SKILL_HUB_WRITE_HEADER + ' header (write requests must come from the hub panel)')
        return
      }
      if (spec.skipGate !== true && disabledGate(deps, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      let body: Record<string, unknown> = {}
      let raw: Buffer | undefined
      if (spec.jsonBody === true && req.method === 'POST') {
        try {
          const parsed = await readJsonBody(req)
          if (parsed === undefined) { writeError(res, 400, 'invalid JSON body'); return }
          body = parsed
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            writeError(res, 413, 'request body too large: this route accepts at most ' + Math.floor(MAX_JSON_BODY_BYTES / 1024) + ' KiB of JSON')
            return
          }
          throw error
        }
      }
      if (spec.binaryBody === true && req.method === 'POST') {
        try {
          raw = await readBinaryBody(req)
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            writeError(res, 413, 'request body too large: this route accepts at most ' + Math.floor(MAX_BINARY_BODY_BYTES / (1024 * 1024)) + ' MiB')
            return
          }
          throw error
        }
        if (raw.length === 0) { writeError(res, 400, 'empty request body: send the .zip bytes with content-type: application/zip'); return }
      }
      const run = (): Promise<void> => spec.handler({ req, res, url, body, raw })
      try {
        if (spec.serialize === true) await enqueueMutation(run)
        else await run()
      } catch (error) {
        writeRouteError(res, error)
      }
    },
  }
}
