/**
 * Plugin lifecycle: asynchronous work started from `apply()` must not touch the
 * context after the fiber unloaded. Issue #19 was a cold-start abort —
 * `cannot get required service "systemPrompt" in inactive context` — when the
 * stats wiring settled after a config-driven reload had torn the plugin down.
 *
 * Issue #24 is the mirror image on the way out: an agent-layer skill-provider
 * registration that is not released with the fiber survives the in-process
 * profile replay a market self-update performs, and the new fiber then throws
 * "already registered in this scope".
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from './index.ts'

/** Agent double: a second live provider on the same layer throws, like dsh-skill's NamedEntries. */
function fakeAgent(id: string) {
  const agent = {
    id,
    live: 0,
    ctx: {
      get: (name: string) =>
        name === 'skills'
          ? {
              registerProvider: () => {
                if (agent.live > 0) {
                  throw new Error('a skill provider named "skill-hub" is already registered in this scope')
                }
                agent.live += 1
                return () => {
                  agent.live -= 1
                }
              },
            }
          : undefined,
    },
  }
  return agent
}

/** Minimal context double: records what the plugin registers, exposes a controllable fiber. */
function fakeHost(options: { agents?: ReturnType<typeof fakeAgent>[] } = {}) {
  const sections: string[] = []
  const routes: string[] = []
  const warns: string[] = []
  const injected: Array<(context: unknown) => void> = []
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const fiber: { uid: number | null } = { uid: 1 }
  /** Disposers of every `ctx.effect` body, released by `unload()` in reverse order. */
  const effects: Array<() => void> = []
  /** The HTTP surface is read through `ctx.get('webServer')` now, not injected. */
  const webServer = {
    register: (route: { path: string }) => {
      routes.push(route.path)
      return () => {}
    },
  }
  const context = {
    fiber,
    logger: { info: () => {}, warn: (message: string) => { warns.push(message) } },
    /** Only `webServer` and `agents` resolve; settings and Connection stay absent so every optional path degrades. */
    get: (name: string) =>
      name === 'webServer' ? webServer : name === 'agents' ? { list: () => options.agents ?? [] } : undefined,
    on: (event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
    skills: {
      registerProvider: () => () => {},
      snapshot: async () => ({ skills: [], complete: true }),
      get: async () => undefined,
    },
    systemPrompt: {
      section: (spec: { name: string }) => {
        sections.push(spec.name)
        return () => {}
      },
    },
    webServer,
    effect: (body: () => unknown) => {
      const produced = body()
      const dispose = () => {
        const index = effects.indexOf(dispose)
        if (index === -1) return
        effects.splice(index, 1)
        if (typeof produced === 'function') (produced as () => void)()
      }
      effects.push(dispose)
      return dispose
    },
    inject: (_names: unknown, run: (child: unknown) => void) => { injected.push(run) },
  }
  /** Tear the fiber down: mark it inactive and release its effects newest-first, like Cordis. */
  const unload = () => {
    fiber.uid = null
    // Ask each disposer in turn — it removes itself from `effects`.
    while (effects.length > 0) effects[effects.length - 1]!()
  }
  return { context, sections, routes, fiber, injected, unload, warns }
}

/** The session-query seam the stats wiring accepts. */
const queryStub = {
  listSessions: async () => [],
  readSession: async () => ({ events: [] }),
}

describe('plugin lifecycle (issues #19, #24)', () => {
  let home: string
  const originalHome = process.env.DSH_HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-skill-hub-lifecycle-'))
    process.env.DSH_HOME = home
  })

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    await rm(home, { recursive: true, force: true })
  })

  it('mounts the announced section and route family once for an active fiber', () => {
    const host = fakeHost()
    apply(host.context as never, undefined)
    expect(host.sections).toEqual(['plugin:dsh-skill-hub'])
    expect(host.routes).toContain('/api/skill-hub/catalog')
  })

  it('drops a late stats continuation instead of syncing on an inactive context', async () => {
    const host = fakeHost()
    apply(host.context as never, undefined)
    const beforeUnload = host.sections.length

    // The session-query service arrives: wireStats() starts an async build that
    // first awaits the persisted scan checkpoint. The nested persistence probe
    // is left unmounted (the child `inject` never calls back).
    expect(host.injected).toHaveLength(1)
    host.injected[0]!({ sessionQuery: queryStub, inject: () => {} })

    // A config rewrite (or disable) unloads the fiber while that await is in
    // flight — the exact window issue #19 aborted on.
    host.fiber.uid = null
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Without the guard the continuation called sync(), which re-registered the
    // announcement on the dead context (and threw on a real host).
    expect(host.sections).toHaveLength(beforeUnload)
  })

  it('releases agent-layer provider registrations with the fiber so a profile replay can re-register (issue #24)', () => {
    const agent = fakeAgent('agent-1')
    const host = fakeHost({ agents: [agent] })
    apply(host.context as never, undefined)
    // One registration into the global layer (uncounted) and one per live agent.
    expect(agent.live).toBe(1)

    // Market self-update: the host replays the profile in-process. The old
    // fiber is disposed while the agent keeps running.
    host.unload()
    expect(agent.live).toBe(0)

    // The replaying fiber registers again. Leaking the old agent-layer entry
    // made this throw the scoped duplicate-name error, which failed the entry,
    // aborted reloadProfile and rolled the update back.
    host.fiber.uid = 2
    expect(() => apply(host.context as never, undefined)).not.toThrow()
    expect(agent.live).toBe(1)
  })

  it('loads over a registration leaked by the previous version instead of failing the entry (issue #24)', () => {
    const agent = fakeAgent('agent-1')
    // A 0.3.36 fibre registered into this layer and died without releasing it.
    const skills = agent.ctx.get('skills') as { registerProvider: (factory?: unknown) => (() => void) | undefined }
    skills.registerProvider(() => {})
    expect(agent.live).toBe(1)

    const host = fakeHost({ agents: [agent] })
    // Throwing here fails the Loader entry, which aborts reloadProfile and
    // rolls the self-update back — leaving users unable to install the fix.
    expect(() => apply(host.context as never, undefined)).not.toThrow()
    // The leaked registration is not ours to release; the layer keeps serving
    // overrides through it until the process restarts.
    expect(agent.live).toBe(1)
    expect(host.warns.some((line) => line.includes('already holds a skill-hub provider'))).toBe(true)

    // A fresh process has no leaked registration, so the layer registers anew.
    const restarted = fakeAgent('agent-1')
    apply(fakeHost({ agents: [restarted] }).context as never, undefined)
    expect(restarted.live).toBe(1)
  })
})
