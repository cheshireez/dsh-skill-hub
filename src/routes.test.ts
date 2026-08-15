import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRoutes, type SkillHubRouteDeps } from './routes.ts'
import { SkillHubStore, statePath } from './store.ts'
import { SKILL_HUB_API, type CatalogResponse, type ConfigResponse, type ErrorResponse, type HubConfig } from './protocol.ts'

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

  /** 按路径取路由（避免数组解构的位置脆弱性）。 */
  function routeFor(path: string) {
    const route = makeRoutes(deps).find((r) => r.path === path)
    if (route === undefined) throw new Error('route not found: ' + path)
    return route
  }

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

  it('disables a whole group in one write', async () => {
    for (const name of ['batch-a', 'batch-b']) {
      const dir = join(home, 'skills', name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: A batch skill\n---\n\nbody`, 'utf8')
    }
    skills.get = async (name: string) => definition({ name, path: join(home, 'skills', name, 'SKILL.md'), source: 'user-dsh' })
    const [, , , toggleBatch] = makeRoutes(deps)
    const res = new FakeResponse()
    await toggleBatch.handler(fakeReq('POST', SKILL_HUB_API.toggleBatch, { names: ['batch-a', 'batch-b'], enabled: false }), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').ToggleBatchResponse
    expect(body.ok).toBe(true)
    expect(body.failures).toEqual([])
    expect(await store.listDisabled()).toHaveLength(2)
  })

  it('re-enables a group and skips already-enabled names as no-ops', async () => {
    const pathA = join(home, 'skills', 'batch-a', 'SKILL.md')
    const pathB = join(home, 'skills', 'batch-b', 'SKILL.md')
    for (const pth of [pathA, pathB]) {
      await mkdir(dirname(pth), { recursive: true })
      await writeFile(pth, '---\nname: x\ndescription: y\n---\n\nbody', 'utf8')
    }
    const { disableSkill } = await import('./skillfs.ts')
    const disabledA = await disableSkill(pathA)
    await store.addDisabled({ name: 'batch-a', description: 'y', path: disabledA, root: 'user-dsh', disabledAt: 1 })
    skills.get = async (name: string) => definition({ name, source: 'user-dsh' })
    const [, , , toggleBatch] = makeRoutes(deps)
    const res = new FakeResponse()
    await toggleBatch.handler(fakeReq('POST', SKILL_HUB_API.toggleBatch, { names: ['batch-a', 'batch-b'], enabled: true }), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').ToggleBatchResponse
    expect(body.failures).toEqual([])
    expect(await store.listDisabled()).toHaveLength(0)
  })

  it('reports per-name failures for read-only skills while landing the rest', async () => {
    const dir = join(home, 'skills', 'batch-c')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: batch-c\ndescription: ok\n---', 'utf8')
    skills.get = async (name: string) => name === 'batch-c'
      ? definition({ name, path: join(dir, 'SKILL.md'), source: 'user-dsh' })
      : definition({ name, source: 'bundled', provider: 'bundled' })
    const [, , , toggleBatch] = makeRoutes(deps)
    const res = new FakeResponse()
    await toggleBatch.handler(fakeReq('POST', SKILL_HUB_API.toggleBatch, { names: ['batch-c', 'readonly-x'], enabled: false }), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').ToggleBatchResponse
    expect(body.failures).toHaveLength(1)
    expect(body.failures[0].name).toBe('readonly-x')
    expect(await store.listDisabled()).toHaveLength(1)
  })

  it('creates a skill scaffold and rejects bad names', async () => {
    const [, , , , create] = makeRoutes(deps)
    const ok = new FakeResponse()
    await create.handler(fakeReq('POST', SKILL_HUB_API.create, { name: 'new-skill', description: 'Fresh' }), ok as never)
    expect(ok.status).toBe(201)
    const bad = new FakeResponse()
    await create.handler(fakeReq('POST', SKILL_HUB_API.create, { name: 'Not Valid' }), bad as never)
    expect(bad.status).toBe(400)
  })

  it('refuses to create a duplicate name', async () => {
    skills.get = async () => definition({})
    const [, , , , create] = makeRoutes(deps)
    const res = new FakeResponse()
    await create.handler(fakeReq('POST', SKILL_HUB_API.create, { name: 'demo-skill' }), res as never)
    expect(res.status).toBe(409)
  })

  it('serves the hub config with saved overrides', async () => {
    const [, , , , , , config] = makeRoutes({
      ...deps,
      config: () => ({ enabled: false, announceToAgent: true }),
      saved: () => ({ enabled: false }),
    })
    const res = new FakeResponse()
    await config.handler(fakeReq('GET', SKILL_HUB_API.config), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as ConfigResponse
    expect(body.ok).toBe(true)
    expect(body.config).toEqual({ enabled: false, announceToAgent: true })
    expect(body.saved).toEqual({ enabled: false })
  })

  it('patches the hub config through the owner updateConfig', async () => {
    const patches: Array<Partial<HubConfig>> = []
    const updateConfig = async (patch: Partial<HubConfig>): Promise<HubConfig> => {
      patches.push(patch)
      return { enabled: false, announceToAgent: false }
    }
    const [, , , , , , config] = makeRoutes({
      ...deps,
      config: () => ({ enabled: true, announceToAgent: true }),
      saved: () => ({ enabled: false, announceToAgent: false }),
      updateConfig,
    })
    const res = new FakeResponse()
    await config.handler(fakeReq('POST', SKILL_HUB_API.config, { announceToAgent: false }), res as never)
    expect(res.status).toBe(200)
    expect(patches).toEqual([{ announceToAgent: false }])
    const body = res.json() as ConfigResponse
    expect(body.config).toEqual({ enabled: false, announceToAgent: false })
  })

  it('clears a saved override with null on the config route', async () => {
    const patches: Array<Partial<HubConfig>> = []
    const updateConfig = async (patch: Partial<HubConfig>): Promise<HubConfig> => {
      patches.push(patch)
      return { enabled: true, announceToAgent: true }
    }
    const [, , , , , , config] = makeRoutes({
      ...deps,
      config: () => ({ enabled: false, announceToAgent: true }),
      saved: () => ({ enabled: false }),
      updateConfig,
    })
    const res = new FakeResponse()
    await config.handler(fakeReq('POST', SKILL_HUB_API.config, { enabled: null }), res as never)
    expect(res.status).toBe(200)
    // null on the wire means "delete the saved override" -> store receives undefined.
    expect(patches).toEqual([{ enabled: undefined }])
  })

  it('rejects non-boolean config patches', async () => {
    const [, , , , , , config] = makeRoutes(deps)
    const res = new FakeResponse()
    await config.handler(fakeReq('POST', SKILL_HUB_API.config, { enabled: 'yes' }), res as never)
    expect(res.status).toBe(400)
    const body = res.json() as ErrorResponse
    expect(body.error).toContain('enabled must be a boolean or null')
  })

  it('keeps the config route up while the hub is disabled (business routes 503)', async () => {
    const routes = makeRoutes({
      ...deps,
      config: () => ({ enabled: false, announceToAgent: true }),
      saved: () => ({ enabled: false }),
    })
    const [catalog, , , , , , config] = routes
    const business = new FakeResponse()
    await catalog.handler(fakeReq('GET', SKILL_HUB_API.catalog), business as never)
    expect(business.status).toBe(503)
    const cfg = new FakeResponse()
    await config.handler(fakeReq('GET', SKILL_HUB_API.config), cfg as never)
    expect(cfg.status).toBe(200)
  })
  it('serves the market with installed flags', async () => {
    await mkdir(join(home, 'skills', 'pdf'), { recursive: true })
    const [, , , , , , , market] = makeRoutes(deps)
    const res = new FakeResponse()
    await market.handler(fakeReq('GET', SKILL_HUB_API.market), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').MarketResponse
    expect(body.entries.length).toBeGreaterThan(0)
    const pdf = body.entries.find((entry) => entry.name === 'pdf')
    expect(pdf?.installed).toBe(true)
    const docx = body.entries.find((entry) => entry.name === 'docx')
    expect(docx?.installed).toBe(false)
  })

  it('imports a market skill from GitHub raw and validates it', async () => {
    const content = '---\nname: docx\ndescription: Create and edit Word documents\n---\n\nbody'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(content, { status: 200 })))
    try {
      const [, , , , , , , , importSkill] = makeRoutes(deps)
      const res = new FakeResponse()
      await importSkill.handler(fakeReq('POST', SKILL_HUB_API.importSkill, { name: 'docx' }), res as never)
      expect(res.status).toBe(201)
      const body = res.json() as import('./protocol.ts').ImportResponse
      expect(body.name).toBe('docx')
      await expect(access(join(home, 'skills', 'docx', 'SKILL.md'))).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a market import that is already installed', async () => {
    await mkdir(join(home, 'skills', 'docx'), { recursive: true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('---\nname: docx\ndescription: x\n---', { status: 200 })))
    try {
      const [, , , , , , , , importSkill] = makeRoutes(deps)
      const res = new FakeResponse()
      await importSkill.handler(fakeReq('POST', SKILL_HUB_API.importSkill, { name: 'docx' }), res as never)
      expect(res.status).toBe(409)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects unknown market names and mismatched downloads', async () => {
    const [, , , , , , , , importSkill] = makeRoutes(deps)
    const unknown = new FakeResponse()
    await importSkill.handler(fakeReq('POST', SKILL_HUB_API.importSkill, { name: 'nope' }), unknown as never)
    expect(unknown.status).toBe(400)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('---\nname: other\ndescription: x\n---', { status: 200 })))
    try {
      const bad = new FakeResponse()
      await importSkill.handler(fakeReq('POST', SKILL_HUB_API.importSkill, { name: 'docx' }), bad as never)
      expect(bad.status).toBe(422)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('surfaces download failures as 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    try {
      const [, , , , , , , , importSkill] = makeRoutes(deps)
      const res = new FakeResponse()
      await importSkill.handler(fakeReq('POST', SKILL_HUB_API.importSkill, { name: 'docx' }), res as never)
      expect(res.status).toBe(502)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // ------------------------------------------------------- groups
  it('serves groups: user tags + system collections + origins', async () => {
    const tag = await store.saveTag({ name: 'web' })
    await store.setTagMembers(tag.id, ['demo-skill'])
    await store.setOrigin('demo-skill', 'superpowers')
    await store.setOrigin('pdf', 'anthropics/skills')
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.groups).handler(fakeReq('GET', SKILL_HUB_API.groups), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').GroupsResponse
    expect(body.tags).toHaveLength(1)
    expect(body.tags[0]).toMatchObject({ name: 'web', skillNames: ['demo-skill'] })
    expect(body.collections).toEqual([
      { name: 'anthropics/skills', skillNames: ['pdf'] },
      { name: 'superpowers', skillNames: ['demo-skill'] },
    ])
    expect(body.origins).toEqual({ 'demo-skill': 'superpowers', pdf: 'anthropics/skills' })
  })

  // ---------------------------------------------------------- tag
  it('creates and renames a tag', async () => {
    const created = new FakeResponse()
    await routeFor(SKILL_HUB_API.tag).handler(fakeReq('POST', SKILL_HUB_API.tag, { name: 'web' }), created as never)
    expect(created.status).toBe(200)
    const createdBody = created.json() as import('./protocol.ts').TagSaveResponse
    expect(createdBody.tags).toHaveLength(1)
    const id = createdBody.tags[0].id
    const renamed = new FakeResponse()
    await routeFor(SKILL_HUB_API.tag).handler(fakeReq('POST', SKILL_HUB_API.tag, { id, name: 'frontend' }), renamed as never)
    expect(renamed.status).toBe(200)
    const renamedBody = renamed.json() as import('./protocol.ts').TagSaveResponse
    expect(renamedBody.tags[0]).toMatchObject({ id, name: 'frontend' })
    const empty = new FakeResponse()
    await routeFor(SKILL_HUB_API.tag).handler(fakeReq('POST', SKILL_HUB_API.tag, { name: '  ' }), empty as never)
    expect(empty.status).toBe(400)
  })

  it('deletes a tag', async () => {
    const created = new FakeResponse()
    await routeFor(SKILL_HUB_API.tag).handler(fakeReq('POST', SKILL_HUB_API.tag, { name: 'tmp' }), created as never)
    const id = (created.json() as import('./protocol.ts').TagSaveResponse).tags[0].id
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.tagDelete).handler(fakeReq('POST', SKILL_HUB_API.tagDelete, { id }), res as never)
    expect(res.status).toBe(200)
    expect((res.json() as import('./protocol.ts').TagDeleteResponse).tags).toEqual([])
  })

  it('sets tag members and drops names absent from the catalog', async () => {
    skills.snapshot = async () => ({ skills: [summary()], complete: true })
    const created = new FakeResponse()
    await routeFor(SKILL_HUB_API.tag).handler(fakeReq('POST', SKILL_HUB_API.tag, { name: 'web' }), created as never)
    const id = (created.json() as import('./protocol.ts').TagSaveResponse).tags[0].id
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.tagMembers).handler(fakeReq('POST', SKILL_HUB_API.tagMembers, { id, skillNames: ['demo-skill', 'ghost-skill'] }), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').TagMembersResponse
    expect(body.tags[0].skillNames).toEqual(['demo-skill'])
  })

  // --------------------------------------------------------- origin
  it('marks and clears a skill origin, aggregating collections', async () => {
    const set = new FakeResponse()
    await routeFor(SKILL_HUB_API.origin).handler(fakeReq('POST', SKILL_HUB_API.origin, { skillName: 'docx', origin: 'anthropics/skills' }), set as never)
    expect(set.status).toBe(200)
    const setBody = set.json() as import('./protocol.ts').OriginResponse
    expect(setBody.collections).toEqual([{ name: 'anthropics/skills', skillNames: ['docx'] }])
    const clear = new FakeResponse()
    await routeFor(SKILL_HUB_API.origin).handler(fakeReq('POST', SKILL_HUB_API.origin, { skillName: 'docx', origin: null }), clear as never)
    expect(clear.status).toBe(200)
    expect((clear.json() as import('./protocol.ts').OriginResponse).collections).toEqual([])
    const bad = new FakeResponse()
    await routeFor(SKILL_HUB_API.origin).handler(fakeReq('POST', SKILL_HUB_API.origin, { skillName: 'docx', origin: '  ' }), bad as never)
    expect(bad.status).toBe(400)
  })

  it('patches display toggles on the config route', async () => {
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.config).handler(fakeReq('POST', SKILL_HUB_API.config, { showUseCount: false }), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').ConfigResponse
    expect(body.config.showUseCount).toBe(false)
    const bad = new FakeResponse()
    await routeFor(SKILL_HUB_API.config).handler(fakeReq('POST', SKILL_HUB_API.config, { showUseTime: 'x' }), bad as never)
    expect(bad.status).toBe(400)
  })

  // ------------------------------------------------------- scene
  it('creates, renames, and deletes a scene', async () => {
    const created = new FakeResponse()
    await routeFor(SKILL_HUB_API.scene).handler(fakeReq('POST', SKILL_HUB_API.scene, { name: '前端' }), created as never)
    expect(created.status).toBe(200)
    const createdBody = created.json() as import('./protocol.ts').SceneSaveResponse
    expect(createdBody.scenes).toHaveLength(1)
    const id = createdBody.scenes[0].id
    const renamed = new FakeResponse()
    await routeFor(SKILL_HUB_API.scene).handler(fakeReq('POST', SKILL_HUB_API.scene, { id, name: '后端' }), renamed as never)
    expect((renamed.json() as import('./protocol.ts').SceneSaveResponse).scenes[0]).toMatchObject({ id, name: '后端' })
    const empty = new FakeResponse()
    await routeFor(SKILL_HUB_API.scene).handler(fakeReq('POST', SKILL_HUB_API.scene, { name: '  ' }), empty as never)
    expect(empty.status).toBe(400)
    const deleted = new FakeResponse()
    await routeFor(SKILL_HUB_API.sceneDelete).handler(fakeReq('POST', SKILL_HUB_API.sceneDelete, { id }), deleted as never)
    expect((deleted.json() as import('./protocol.ts').SceneDeleteResponse).scenes).toEqual([])
  })

  it('sets scene members and drops names absent from the catalog', async () => {
    skills.snapshot = async () => ({ skills: [summary()], complete: true })
    const created = new FakeResponse()
    await routeFor(SKILL_HUB_API.scene).handler(fakeReq('POST', SKILL_HUB_API.scene, { name: 's' }), created as never)
    const id = (created.json() as import('./protocol.ts').SceneSaveResponse).scenes[0].id
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.sceneMembers).handler(fakeReq('POST', SKILL_HUB_API.sceneMembers, { id, skillNames: ['demo-skill', 'ghost'] }), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').SceneMembersResponse
    expect(body.scenes[0].skillNames).toEqual(['demo-skill'])
  })

  // ---------------------------------------------- import 记录 origin
  it('records the repo origin when importing a market skill', async () => {
    const content = '---\nname: docx\ndescription: Create and edit Word documents\n---\n\nbody'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(content, { status: 200 })))
    try {
      const res = new FakeResponse()
      await routeFor(SKILL_HUB_API.importSkill).handler(fakeReq('POST', SKILL_HUB_API.importSkill, { name: 'docx' }), res as never)
      expect(res.status).toBe(201)
      expect(await store.getOrigin('docx')).toBe('anthropics/skills')
    } finally {
      vi.unstubAllGlobals()
    }
  })

})

