/**
 * useMetaFlow — 自身更新检查 + 调用统计 + 配置：只依赖 api，
 * 不碰其他域。补捞 effect 自包含（uses.size + loadUses）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HubConfig } from '../../../protocol.ts'
import type { SkillHubApi } from '../../api.ts'
import { errorMessage } from '../../helpers.ts'
import { USES_CATCH_UP_MAX, type UpdateState } from './shared.ts'

export function useMetaFlow(api: SkillHubApi) {
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  const [uses, setUses] = useState<ReadonlyMap<string, { count: number; lastUsed?: number }>>(new Map())
  const [hubConfig, setHubConfig] = useState<HubConfig | null>(null)

  const loadUses = useCallback(async (): Promise<void> => {
    try {
      const result = await api.stats()
      if (result.available) setUses(new Map(result.stats.map((stat) => [stat.name, { count: stat.count, ...(stat.lastUsed !== undefined ? { lastUsed: stat.lastUsed } : {}) }])))
    } catch {
      // Invocation counts are best-effort; a stats failure must not disturb the catalog.
    }
  }, [api])

  const loadConfig = useCallback(async (): Promise<void> => {
    try {
      setHubConfig((await api.config()).config)
    } catch {
      // Dot colors are cosmetic; a config failure falls back to the defaults.
    }
  }, [api])

  const checkUpdate = useCallback(async (): Promise<void> => {
    setUpdateState({ status: 'checking' })
    try {
      setUpdateState({ status: 'ready', data: await api.updateCheck() })
    } catch (error) {
      setUpdateState({ status: 'error', message: errorMessage(error) })
    }
  }, [api])

  // 统计是 SWR：首刷可能命中服务端冷启动（回空数组、后台扫描中）。
  // 补捞轮询：空数时每 5 秒捞一次，有数即停（最多约 6 分钟，见 USES_CATCH_UP_MAX），之后交给 60 秒轮询。
  // 冷扫描要解压全部会话日志（数十 MB 级），固定一次补捞可能赶不上。
  const usesCatchUp = useRef(0)
  useEffect(() => {
    if (uses.size > 0 || usesCatchUp.current >= USES_CATCH_UP_MAX) return
    const timer = window.setInterval(() => {
      usesCatchUp.current += 1
      void loadUses()
      if (usesCatchUp.current >= USES_CATCH_UP_MAX) window.clearInterval(timer)
    }, 5_000)
    return () => { window.clearInterval(timer) }
  }, [uses.size, loadUses])

  return { updateState, checkUpdate, uses, loadUses, hubConfig, loadConfig }
}
