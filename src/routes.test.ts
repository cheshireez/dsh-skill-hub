import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeRoutes, type SkillHubRouteDeps } from './routes.ts'
import { SkillHubStore, statePath } from './store.ts'
import { SKILL_HUB_API, type CatalogResponse, type ErrorResponse } from './protocol.ts'

/** Minimal response double recording status/headers/body. */
class FakeResponse {
  status = 0
  headers: Record<string, string> = {}
  body = ''
  writeHead(status: number, headers?: Record<string, string>): void {
    this.status = status
    if (headers !== undefined) this.headers = headers
  }
  end(chunk?: string): void {
    this.body = chunk ?? ''
  }
  json(): unknown {
    try { return JSON.parse(this.body) } catch { return undefined }
  }
}

/** Minimal request double (loopback by default; body available for POST). */
function fakeReq(method: string, url = '/', body?: unknown, remoteAddress = '127.0.0.1'): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

/** One registry summary with sane defaults. */
function summary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: 'demo-skill',
    description: 'demo',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-dsh',
    provider: 'filesystem',
    ...overrides,
  }
}

/** One loaded definition with sane defaults. */
function definition(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    ...summary(overrides),
    content: 'body',
    ...overrides,
  }
}

describe('skill-hub routes', () => {
  let dir: string
  let home: string
  let store: SkillHubStore
  let skills: SkillHubRouteDeps['skills']
  let deps: SkillHubRouteDeps

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hub-routes-'))
    home = join(dir, 'home')
    await mkdir(join(home, 'skills'), { recursive: true })
    store = new SkillHubStore(statePath(home))
    skills = {
      snapshot: async () => ({ skills: [], complete: true }),
      get: async () => undefined,
    }
    deps = { skills, store, home }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects non-loopback requests', async () => {
    const [catalog] = makeRoutes(deps)
    const res = new FakeResponse()
    await catalog.handler(fakeReq('GET', SKILL_HUB_API.catalog, undefined, '10.0.0.5'), res as never)
    expect(res.status).toBe(403)
  })

  it('serves the catalog with writable flags and diagnostics', async () => {
    skills.snapshot = async () => ({
      skills: [summary({ source: 'user-dsh' }), summary({ name: 'bundled-x', source: 'bundled', provider: 'bundled' })],
      complete: true,
    })
    // A broken file in the writable root shows up as a diagnostic.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(home, 'skills', 'broken.md'), '# no frontmatter', 'utf8')
    const [catalog] = makeRoutes(deps)
    const res = new FakeResponse()
    await catalog.handler(fakeReq('GET', SKILL_HUB_API.catalog), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as CatalogResponse
    expect(body.ok).toBe(true)
    expect(body.skills).toHaveLength(2)
    expect(body.skills[0].writable).toBe(true)
    expect(body.skills[1].writable).toBe(false)
    expect(body.diagnostics).toHaveLength(1)
    expect(body.diagnostics[0].reason).toBe('missing YAML frontmatter (--- block)')
  })

  it('enriches the catalog with sets from skill metadata', async () => {
    skills.snapshot = async () => ({ skills: [summary({ name: 'grouped-skill' })], complete: true })
    skills.get = async () => definition({ metadata: { sets: ['engineering'] } })
    const [catalog] = makeRoutes(deps)
    const res = new FakeResponse()
    await catalog.handler(fakeReq('GET', SKILL_HUB_API.catalog), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as CatalogResponse
    expect(body.skills[0].sets).toEqual(['engineering'])
  })

  it('forwards the cwd query to the registry snapshot', async () => {
    let captured: string | undefined
    skills.snapshot = async (options?: { cwd?: string }) => {
      captured = options?.cwd
      return { skills: [], complete: true }
    }
    const [catalog] = makeRoutes(deps)
    const res = new FakeResponse()
    await catalog.handler(fakeReq('GET', SKILL_HUB_API.catalog + '?cwd=%2Ftmp%2Fproject'), res as never)
    expect(res.status).toBe(200)
    expect(captured).toBe('/tmp/project')
  })

  it('serves skill detail and 404s unknown names', async () => {
    skills.get = async (name: string) => name === 'demo-skill' ? definition({ path: '/x/demo-skill/SKILL.md' }) : undefined
    const [, detail] = makeRoutes(deps)
    const ok = new FakeResponse()
    await detail.handler(fakeReq('GET', SKILL_HUB_API.skill + '?name=demo-skill'), ok as never)
    expect(ok.status).toBe(200)
    const missing = new FakeResponse()
    await detail.handler(fakeReq('GET', SKILL_HUB_API.skill + '?name=nope'), missing as never)
    expect(missing.status).toBe(404)
  })

  it('toggles a writable skill off and back on', async () => {
    const path = join(home, 'skills', 'demo-skill', 'SKILL.md')
    await mkdir(join(home, 'skills', 'demo-skill'), { recursive: true })
    const { writeFile, access } = await import('node:fs/promises')
    await writeFile(path, '---\nname: demo-skill\ndescription: demo\n---\n\nbody', 'utf8')
    skills.get = async () => definition({ path })
    const [, , toggle] = makeRoutes(deps)
    const off = new FakeResponse()
    await toggle.handler(fakeReq('POST', SKILL_HUB_API.toggle, { name: 'demo-skill', enabled: false }), off as never)
    expect(off.status).toBe(200)
    expect(await store.listDisabled()).toHaveLength(1)
    await expect(access(path)).rejects.toThrow()
    const on = new FakeResponse()
    await toggle.handler(fakeReq('POST', SKILL_HUB_API.toggle, { name: 'demo-skill', enabled: true }), on as never)
    expect(on.status).toBe(200)
    expect(await store.listDisabled()).toHaveLength(0)
    await expect(access(path)).resolves.toBeUndefined()
  })

  it('refuses to toggle read-only sources', async () => {
    skills.get = async () => definition({ source: 'bundled', provider: 'bundled' })
    const [, , toggle] = makeRoutes(deps)
    const res = new FakeResponse()
    await toggle.handler(fakeReq('POST', SKILL_HUB_API.toggle, { name: 'demo-skill', enabled: false }), res as never)
    expect(res.status).toBe(409)
    const body = res.json() as ErrorResponse
    expect(body.error).toContain('managed outside the hub')
  })

  it('creates a skill scaffold and rejects bad names', async () => {
    const [, , , create] = makeRoutes(deps)
    const ok = new FakeResponse()
    await create.handler(fakeReq('POST', SKILL_HUB_API.create, { name: 'new-skill', description: 'Fresh' }), ok as never)
    expect(ok.status).toBe(201)
    const bad = new FakeResponse()
    await create.handler(fakeReq('POST', SKILL_HUB_API.create, { name: 'Not Valid' }), bad as never)
    expect(bad.status).toBe(400)
  })

  it('refuses to create a duplicate name', async () => {
    skills.get = async () => definition({})
    const [, , , create] = makeRoutes(deps)
    const res = new FakeResponse()
    await create.handler(fakeReq('POST', SKILL_HUB_API.create, { name: 'demo-skill' }), res as never)
    expect(res.status).toBe(409)
  })
})

