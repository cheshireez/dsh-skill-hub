/**
 * Plugin lifecycle: asynchronous work started from `apply()` must not touch the
 * context after the fiber unloaded. Issue #19 was a cold-start abort —
 * `cannot get required service "systemPrompt" in inactive context` — when the
 * stats wiring settled after a config-driven reload had torn the plugin down.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from './index.ts'

/** Minimal context double: records what the plugin registers, exposes a controllable fiber. */
function fakeHost() {
  const sections: string[] = []
  const routes: string[] = []
  const injected: Array<(context: unknown) => void> = []
  const fiber: { uid: number | null } = { uid: 1 }
  const context = {
    fiber,
    logger: { info: () => {}, warn: () => {} },
    /** No optional services (settings) and no Connection: every optional path degrades. */
    get: () => undefined,
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
    webServer: {
      register: (route: { path: string }) => {
        routes.push(route.path)
        return () => {}
      },
    },
    effect: (body: () => unknown) => {
      const produced = body()
      return () => {
        if (typeof produced === 'function') (produced as () => void)()
      }
    },
    inject: (_names: unknown, run: (child: unknown) => void) => { injected.push(run) },
  }
  return { context, sections, routes, fiber, injected }
}

/** The session-query seam the stats wiring accepts. */
const queryStub = {
  listSessions: async () => [],
  readSession: async () => ({ events: [] }),
}

describe('plugin lifecycle (issue #19)', () => {
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
})
