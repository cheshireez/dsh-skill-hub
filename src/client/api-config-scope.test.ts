import { describe, expect, it } from 'vitest'
import type { ConfigRequest, ConfigResponse, HubConfig } from '../protocol.ts'
import type { SkillHubApi } from './api.ts'
import { ApiConfigScope } from './api-config-scope.ts'

function deferredReady(scope: ApiConfigScope): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('ApiConfigScope', () => {
  it('persists the panel display toggles (showUseCount etc.)', async () => {
    const saved: Partial<HubConfig> = {}
    const writes: ConfigRequest[] = []
    const api = {
      config: async (): Promise<ConfigResponse> => ({
        ok: true,
        config: {
          enabled: true,
          announceToAgent: true,
          showUseCount: true,
          showUseTime: true,
          showGroupSummary: true,
        },
        saved,
      }),
      saveConfig: async (patch: ConfigRequest): Promise<ConfigResponse> => {
        writes.push(patch)
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete saved[key as keyof HubConfig]
          else saved[key as keyof HubConfig] = value as never
        }
        return {
          ok: true,
          config: {
            enabled: true,
            announceToAgent: true,
            showUseCount: saved.showUseCount !== false,
            showUseTime: saved.showUseTime !== false,
            showGroupSummary: saved.showGroupSummary !== false,
          },
          saved,
        }
      },
    } as unknown as SkillHubApi

    const scope = new ApiConfigScope(api)
    await deferredReady(scope)

    await scope.set('showUseCount', false)
    expect(writes).toContainEqual({ showUseCount: false })
    expect(scope.getSnapshot().value).toMatchObject({ showUseCount: false })
    expect(scope.getSnapshot().user).toMatchObject({ showUseCount: false })

    await scope.unset('showUseCount')
    expect(writes).toContainEqual({ showUseCount: null })
    expect(scope.getSnapshot().user).not.toHaveProperty('showUseCount')
    expect(scope.getSnapshot().value).toMatchObject({ showUseCount: true })
  })

  it('ignores unknown fields', async () => {
    const writes: ConfigRequest[] = []
    const api = {
      config: async (): Promise<ConfigResponse> => ({
        ok: true,
        config: { enabled: true, announceToAgent: true },
        saved: {},
      }),
      saveConfig: async (patch: ConfigRequest): Promise<ConfigResponse> => {
        writes.push(patch)
        return { ok: true, config: { enabled: true, announceToAgent: true }, saved: {} }
      },
    } as unknown as SkillHubApi

    const scope = new ApiConfigScope(api)
    await deferredReady(scope)
    await scope.set('not-a-field', true)
    expect(writes).toHaveLength(0)
  })
})
