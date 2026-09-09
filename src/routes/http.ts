/**
 * routes 共享层 · HTTP 围栏：回环信任检查、JSON 响应与错误映射、请求体读取、
 * 查询/字段读取与文件存在性检查。从 helpers.ts 原样搬出，行为不变。
 */

import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { errorText } from '../error-text.ts'
import { RepoFetchError } from '../repo.ts'
import { StoreError } from '../store.ts'

/** Cap on JSON request bodies (toggle/create payloads are tiny). */
export const MAX_JSON_BODY_BYTES = 64 * 1024

/** Loopback literal check plus browser same-origin markers. */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** One JSON error response. */
export function writeError(res: ServerResponse, status: number, error: unknown): void {
  const body = { error: errorText(error) }
  writeJson(res, status, body)
}

/** HTTP status per store business-rule kind (user error, not server fault). */
export const STORE_ERROR_STATUS = { validation: 400, 'not-found': 404, conflict: 409 } as const

/** Map known error types onto HTTP statuses: repo fetch + store business rules. */
export function writeRouteError(res: ServerResponse, error: unknown): void {
  if (error instanceof RepoFetchError) {
    writeError(res, error.status, error)
    return
  }
  if (error instanceof StoreError) {
    writeError(res, STORE_ERROR_STATUS[error.kind], error)
    return
  }
  writeError(res, 500, error)
}

/** Read a JSON request body (undefined when too large or unparseable). */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** URL query helper (first value, decoded). */
export function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/**
 * 读取请求体里的字符串字段（缺失或类型不符返回 ''）。替代各 handler 里
 * `body as unknown as XRequest` 的断言 + 手写 typeof 收窄。
 */
export function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 读取请求体里的字符串数组：非数组返回 []，丢弃非字符串项；默认同时丢弃
 * 空串（keepEmpty=true 时保留空串，由调用方决定语义）。
 */
export function readStrings(body: Record<string, unknown>, key: string, options?: { keepEmpty?: boolean }): string[] {
  const value = body[key]
  if (!Array.isArray(value)) return []
  const keepEmpty = options?.keepEmpty === true
  return value.filter((item): item is string => typeof item === 'string' && (keepEmpty || item !== ''))
}

/** Async existence check (import/sync use it on the user root). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
