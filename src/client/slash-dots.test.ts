/**
 * Slash-menu skill dots: source lookup + candidates wrapping. The wrapper's
 * contract is pure and injectable — fake api (catalog) and fake settings scope
 * (getSnapshot) — so it tests cleanly in the node vitest environment. The dot
 * itself is injected into the rendered DOM, which does not exist here, so these
 * tests assert that candidate rows pass through untouched. The module caches
 * the catalog map; resetModelCache keeps tests independent.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
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
    mutate: async () => {},
  } as unknown as SettingsScope<HubSettingsValue>
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
  it('leaves candidate rows untouched — the dot goes to the DOM, not the icon slot', async () => {
    const source = skillSource(async () => [
      { name: 'code-review', description: 'review code' },
      { name: 'personal-note', description: 'only me' },
    ])
    const api = apiWith([
      { name: 'code-review', modelInvocable: true },
      { name: 'personal-note', modelInvocable: false },
    ])
    const scope = scopeWith({ enabled: true, announceToAgent: true, showUseCount: true, showUseTime: true, showGroupSummary: true, dotModelColor: '#112233', dotUserColor: '#445566' })

    const restore = wrapSkillSource(source, api, scope)
    try {
      const rows = await source.candidates({ sessionId: 's1' as never }, { query: '', position: 'leading', drilled: false, signal: new AbortController().signal })

      expect(rows).toHaveLength(2)
      // MenuView renders `icon` through ReferenceIcon (enum-narrowed), so a
      // custom element would never show — rows must carry no icon at all.
      expect(rows[0].icon).toBeUndefined()
      expect(rows[1].icon).toBeUndefined()
      // Original fields pass through untouched.
      expect(rows[0].name).toBe('code-review')
      expect(rows[0].description).toBe('review code')
    } finally {
      restore()
    }
  })

  it('still returns the rows when the catalog route is down', async () => {
    const source = skillSource(async () => [{ name: 'lonely', description: '' }])
    const api = { catalog: async () => { throw new Error('route down') } } as unknown as SkillHubApi
    const scope = scopeWith({ enabled: true, announceToAgent: true, showUseCount: true, showUseTime: true, showGroupSummary: true })

    const restore = wrapSkillSource(source, api, scope)
    try {
      const rows = await source.candidates({ sessionId: 's1' as never }, { query: '', position: 'leading', drilled: false, signal: new AbortController().signal })
      // A failed catalog only means no dots (unknown names are skipped); the
      // menu itself must keep working.
      expect(rows).toHaveLength(1)
      expect(rows[0].name).toBe('lonely')
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
