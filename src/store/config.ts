/**
 * Hub 自有运行时配置（设置卡片写入）。
 *
 * 与 dsh settings 服务无关：这些字段存在 sidecar 里，因为它们是插件私有
 * 开关（统计窗口、GitHub token 等），而不是宿主的全局配置。
 */
import type { HubConfig } from '../protocol.ts'
import type { StoreCore } from './core.ts'

export interface ConfigSlice {
  /** 已保存的运行时配置（缺省的字段表示「未覆盖」，回落到默认值）。 */
  getConfig(): Promise<Partial<HubConfig>>
  setConfig(config: Partial<HubConfig>): Promise<void>
}

export function configSlice(core: StoreCore): ConfigSlice {
  const { state } = core
  return {
    async getConfig(): Promise<Partial<HubConfig>> {
      await core.ensureLoaded()
      return { ...state.config }
    },

    /**
     * Persist a runtime-config patch, merged over the saved values. A field
     * whose patch value is undefined is removed from the saved layer, so the
     * setting re-inherits its default (the web card's "reset" path).
     */
    async setConfig(config: Partial<HubConfig>): Promise<void> {
      await core.ensureLoaded()
      const next: Partial<HubConfig> = { ...state.config }
      for (const [key, value] of Object.entries(config) as Array<[keyof HubConfig, boolean | string | undefined]>) {
        if (value === undefined) delete next[key]
        else (next as unknown as Record<string, unknown>)[key] = value
      }
      state.config = next
      await core.persist()
    },
  }
}
