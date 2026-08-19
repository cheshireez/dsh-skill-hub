/**
 * Slash-menu skill dots: source lookup + candidates wrapping. The wrapper's
 * contract is pure and injectable — fake api (catalog) and fake settings scope
 * (getSnapshot), no DOM — so it tests cleanly in the node vitest environment.
 * The module caches the catalog map; resetModelCache keeps tests independent.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerCandidate, InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { HubSettingsValue } from '../protocol.ts'
import type { SkillHubApi } from './api.ts'
import { findSkillSource, resetModelCache, wrapSkillSource } from './slash-dots.tsx'

beforeEach(() => {
  resetModelCache()
})

/** A `/` skill source stub with the core ui-skill shape. */
function skillSource(candidates = async (): Promise<InputTriggerCandidate[]> => []): InputTriggerSource {
  return {
    trigger: '/',
    name: 'skill',
    order: 2,
    candidates,
    onPick: () => undefined,
  }
}

/** Fake registry exposing `live.sources` the way the running service does. */
function registry(...sources: InputTriggerSource[]): InputTriggerServiceContract {
  return { live: { sources }, registerSource: () => () => {}, sessionOf: () => { throw new Error('not used in tests') } } as unknown as InputTriggerServiceContract
}

/** Fake settings scope snapshotting a fixed HubSettingsValue. */
function scopeWith(value: HubSettingsValue): SettingsScope<HubSettingsValue> {
  return {
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' }),
    subscribe: () => () => {},
    set: async () => {},
    unset: async () => {},
  } as SettingsScope<HubSettingsValue>
}

/** Fake hub api whose catalog lists the given skills. */
function apiWith(skills: Array<{ name: string; modelInvocable: boolean }>): SkillHubApi {
  return {
    catalog: async () => ({
      ok: true,
      complete: true,
      skills: skills.map((s) => ({
        name: s.name,
        description: '',
        invocation: { modelInvocable: s.modelInvocable, userInvocable: true },
        provider: 'filesystem',
        source: 'user-dsh',
        writable: true,
      })),
      disabled: [],
      diagnostics: [],
    }),
  } as unknown as SkillHubApi
}

describe('findSkillSource', () => {
  it('finds the core /skill source among other sources', () => {
    const source = skillSource()
    const service = registry(
      { trigger: '/', name: 'command', candidates: async () => [], onPick: () => undefined },
      source,
    )
    expect(findSkillSource(service)).toBe(source)
  })

  it('returns undefined when the skill source is absent', () => {
    const service = registry({ trigger: '/', name: 'command', candidates: async () => [], onPick: () => undefined })
    expect(findSkillSource(service)).toBeUndefined()
  })

  it('never throws on a reshaped registry', () => {
    expect(findSkillSource({} as InputTriggerServiceContract)).toBeUndefined()
    expect(findSkillSource({ live: {} } as unknown as InputTriggerServiceContract)).toBeUndefined()
  })
})

describe('wrapSkillSource', () => {
  it('adds a model-colored dot to model-callable skills and a user-colored dot to user-only ones', async () => {
    const source = skillSource(async () => [
      { name: 'code-review', description: 'review code' },
      { name: 'personal-note', description: 'only me' },
      { name: 'known-default', description: 'fallback unknown' },
    ])
    const api = apiWith([
      { name: 'code-review', modelInvocable: true },
      { name: 'personal-note', modelInvocable: false },
    ])
    const scope = scopeWith({ enabled: true, announceToAgent: true, showUseCount: true, showUseTime: true, showGroupSummary: true, dotModelColor: '#112233', dotUserColor: '#445566' })

    const restore = wrapSkillSource(source, api, scope)
    try {
      const rows = await source.candidates({ sessionId: 's1' as never }, { query: '', position: 'leading', signal: new AbortController().signal })

      expect(rows).toHaveLength(3)
      // Model-callable → model color.
      expect((rows[0].icon as unknown as { props: { style: { background: string } } }).props.style.background).toBe('#112233')
      // User-only → user color.
      expect((rows[1].icon as unknown as { props: { style: { background: string } } }).props.style.background).toBe('#445566')
      // Unknown name → model default (still a dot, safer than no dot).
      expect(rows[2].icon).toBeDefined()
      // Original fields pass through untouched.
      expect(rows[0].name).toBe('code-review')
      expect(rows[0].description).toBe('review code')
    } finally {
      restore()
    }
  })

  it('falls back to the default colors when settings omit them and catalog fails', async () => {
    const source = skillSource(async () => [{ name: 'lonely', description: '' }])
    const api = { catalog: async () => { throw new Error('route down') } } as unknown as SkillHubApi
    const scope = scopeWith({ enabled: true, announceToAgent: true, showUseCount: true, showUseTime: true, showGroupSummary: true })

    const restore = wrapSkillSource(source, api, scope)
    try {
      const rows = await source.candidates({ sessionId: 's1' as never }, { query: '', position: 'leading', signal: new AbortController().signal })
      // Catalog failed → unknown name → model default dot still renders.
      expect(rows[0].icon).toBeDefined()
      expect((rows[0].icon as unknown as { props: { style: { background: string } } }).props.style.background).toBe('#2f81f7')
    } finally {
      restore()
    }
  })

  it('restores the original candidates on dispose', async () => {
    const originalCandidates = async (): Promise<InputTriggerCandidate[]> => [{ name: 'plain', description: '' }]
    const source = skillSource(originalCandidates)
    const api = apiWith([])
    const scope = scopeWith({ enabled: true, announceToAgent: true, showUseCount: true, showUseTime: true, showGroupSummary: true })

    const restore = wrapSkillSource(source, api, scope)
    expect(source.candidates).not.toBe(originalCandidates)
    restore()
    expect(source.candidates).toBe(originalCandidates)
  })
})
