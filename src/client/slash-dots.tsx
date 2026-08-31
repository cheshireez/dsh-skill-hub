/**
 * Slash-menu skill dots: puts the invocation-status dot (model-callable blue /
 * user-only green) in front of every skill candidate in the chat `/` menu.
 *
 * Mechanism (mirrors how dsh-at-file fills the menu icon slot): the candidate
 * menu's rows already render an optional `icon` slot (`MenuView` renders
 * `item.icon` in a 16×16 leading span when it's defined), but the core `/skill`
 * source (`dsh-client-ui-skill`) returns candidates without `icon`. This module
 * wraps that source's `candidates` and stamps each row with a colored dot,
 * reusing the same settings (dotModelColor / dotUserColor) and the same
 * `modelInvocable` classification the panel legend uses — so the chat menu and
 * the Settings → 技能 panel stay in sync, and editing the color updates both.
 *
 * The skill source is registered by the core plugin under the `name` "skill"
 * on the `/` trigger; re-registering the same name would throw, so this wraps
 * the already-registered source object instead (found through the runtime
 * source registry, which the frozen contract exposes only as `registerSource`
 * / `sessionOf` — the lookup below is defensive: it never throws).
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the Context merge for ctx.inputTriggers.
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the connection/reset event.
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { InputTriggerCandidate, InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createElement } from 'react'
import type { HubSettingsValue } from '../protocol.ts'
import type { SkillHubApi } from './api.ts'
import { DEFAULT_DOT_MODEL_COLOR, DEFAULT_DOT_USER_COLOR } from './panel/format.ts'

/** The core plugin's skill source identity on the '/' trigger. */
const SKILL_SOURCE = { trigger: '/', name: 'skill' } as const

/** How long one catalog-derived modelInvocable map stays hot before refresh. */
const MODEL_TTL_MS = 60_000

/** Runtime view of the source registry (the contract keeps `live` private). */
type SourceRegistry = {
  live?: { sources?: InputTriggerSource[] }
}

/**
 * Find the core `/skill` source through the runtime registry, or undefined.
 * The lookup never throws: a missing/reshaped registry just means no dots. Exported
 * for unit tests; the apply path only calls it indirectly through setupSkillSlashDots.
 * @param service - the ctx.inputTriggers service face.
 * @returns the registered skill source, or undefined.
 */
export function findSkillSource(service: InputTriggerServiceContract): InputTriggerSource | undefined {
  const live = (service as unknown as SourceRegistry).live
  if (live?.sources === undefined) return undefined
  return live.sources.find((source) => source.trigger === SKILL_SOURCE.trigger && source.name === SKILL_SOURCE.name)
}

/** One catalog-derived name → modelInvocable snapshot with a load timestamp. */
let modelCache: { at: number; map: Map<string, boolean> } | { at: number; failed: true } | undefined

/**
 * Clear the modelInvocable cache. Called on connection/reset so a fresh
 * catalog wins after reconnect; exported for deterministic unit tests.
 */
export function resetModelCache(): void {
  modelCache = undefined
}

/**
 * Resolve name → modelInvocable from the hub's catalog, cached for
 * MODEL_TTL_MS. A failed load caches the failure briefly so a downed route
 * doesn't hammer the host on every keystroke; the returned map is empty then
 * (callers fall back to the model dot for unknown names).
 * @param api - the hub browser API.
 * @returns name → whether the model may call the skill.
 */
async function modelInvocableMap(api: SkillHubApi): Promise<Map<string, boolean>> {
  const now = Date.now()
  const cached = modelCache
  if (cached !== undefined && now - cached.at < MODEL_TTL_MS) {
    return 'failed' in cached ? new Map() : cached.map
  }
  try {
    const catalog = await api.catalog()
    const map = new Map<string, boolean>(catalog.skills.map((skill) => [skill.name, skill.invocation.modelInvocable]))
    modelCache = { at: now, map }
    return map
  } catch (error) {
    console.error('[dsh-skill-hub] slash dot color lookup failed:', error)
    modelCache = { at: now, failed: true }
    return new Map()
  }
}

/**
 * One menu-row dot element. Inline span so it needs no CSS module; the
 * candidate menu centers it inside its 16×16 leading icon slot.
 * @param color - the dot's background color.
 * @returns a React node (memory-only, never crosses the Host boundary).
 */
function dotIcon(color: string): InputTriggerCandidate['icon'] {
  return createElement('span', {
    'aria-hidden': true,
    style: {
      display: 'inline-block',
      width: 6,
      height: 6,
      borderRadius: 3,
      background: color,
      flex: 'none',
    },
  }) as unknown as InputTriggerCandidate['icon']
}

/**
 * Wrap the core skill source so every menu row carries the invocation dot.
 * Exported for unit tests; production wiring goes through setupSkillSlashDots.
 * @param source - the registered `/skill` source.
 * @param api - hub browser API for the modelInvocable lookup.
 * @param scope - hub settings scope for the dot colors.
 * @returns a disposer restoring the original candidates.
 */
export function wrapSkillSource(source: InputTriggerSource, api: SkillHubApi, scope: SettingsScope<HubSettingsValue>): () => void {
  const original = source.candidates
  source.candidates = async (session, req) => {
    const items = await original(session, req)
    if (req.signal.aborted) return items
    // Dual-compat: 0.1.2-alpha.2 的 MenuView 将 icon 收窄为 'file'|'folder'|'session'
    // 并通过 ReferenceIcon 渲染，旧版的自定义 ReactElement 点已无法展示。
    // 以 `drilled` 是否存在探测新版（alpha.2 必有，rc 无），新版直接透传不注入
    // icon，旧版保持彩色点，避免新版传入非法 icon 导致渲染异常。
    const isNewHost = req !== null && typeof req === 'object' && 'drilled' in (req as unknown as Record<string, unknown>)
    if (isNewHost) return items
    const modelByName = await modelInvocableMap(api)
    if (req.signal.aborted) return items
    const snapshot = scope.getSnapshot()
    const modelColor = snapshot.value?.dotModelColor ?? DEFAULT_DOT_MODEL_COLOR
    const userColor = snapshot.value?.dotUserColor ?? DEFAULT_DOT_USER_COLOR
    return items.map((item) => ({
      ...item,
      icon: dotIcon((modelByName.get(item.name) ?? true) ? modelColor : userColor),
    }))
  }
  return () => {
    source.candidates = original
  }
}

/**
 * Mount the slash-menu dots on the registered `/skill` source. Idempotent and
 * defensive: if the core source isn't registered yet (or the registry shape
 * changes), it retries briefly and then gives up silently — the chat keeps
 * working, it simply shows no dots. The returned disposer restores the
 * original candidates and clears the model cache.
 * @param ctx - the client root context (inputTriggers + events).
 * @param api - hub browser API.
 * @param scope - hub settings scope for dot colors.
 * @returns a cleanup function for `ctx.effect`.
 */
export function setupSkillSlashDots(
  ctx: ClientContext,
  api: SkillHubApi,
  scope: SettingsScope<HubSettingsValue>,
): () => void {
  const inputTriggers = ctx.get('inputTriggers')
  if (inputTriggers === undefined) return () => {}

  let disposed = false
  let restore: (() => void) | undefined
  let attempts = 0

  // The core ui-skill source registers early in the bundle, but not strictly
  // before this apply runs — poll briefly so order never matters.
  const attempt = (): void => {
    if (disposed) return
    const source = findSkillSource(inputTriggers)
    if (source === undefined) {
      if (attempts < 10) {
        attempts += 1
        setTimeout(attempt, 100)
      }
      return
    }
    restore = wrapSkillSource(source, api, scope)
  }
  attempt()

  const clearCache = (): void => {
    resetModelCache()
  }
  // ctx.on returns the listener disposer; cordis has no ctx.off.
  const offReset = ctx.on('connection/reset', clearCache)

  return () => {
    disposed = true
    offReset()
    restore?.()
    restore = undefined
  }
}
