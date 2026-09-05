import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

/** Stub global fetch by URL pattern; callers register respond(urlSubstring, Response). */
function stubFetch(routes: Array<[pattern: string, response: Response | (() => Response)]>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    for (const [pattern, response] of routes) {
      if (url.includes(pattern)) return typeof response === 'function' ? response() : response
    }
    return new Response('unexpected url: ' + url, { status: 599 })
  }))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
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
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.catalog).handler(fakeReq('GET', SKILL_HUB_API.catalog, undefined, '10.0.0.5'), res as never)
    expect(res.status).toBe(403)
  })

  it('serves the catalog with writable flags and diagnostics', async () => {
    skills.snapshot = async () => ({
      skills: [summary({ source: 'user-dsh' }), summary({ name: 'bundled-x', source: 'bundled', provider: 'bundled' })],
      complete: true,
    })
    // A broken file in the writable root shows up as a diagnostic.
    await writeFile(join(home, 'skills', 'broken.md'), '# no frontmatter', 'utf8')
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.catalog).handler(fakeReq('GET', SKILL_HUB_API.catalog), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as CatalogResponse
    expect(body.ok).toBe(true)
    expect(body.skills).toHaveLength(2)
    expect(body.skills[0].writable).toBe(true)
    expect(body.skills[1].writable).toBe(false)
    expect(body.diagnostics).toHaveLength(1)
    expect(body.diagnostics[0].reason).toBe('missing YAML frontmatter (--- block)')
    // 面板标题旁的插件版本徽标数据源：随 catalog 附带当前安装版本。
    expect(body.pluginVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('forwards the cwd query to the registry snapshot', async () => {
    let captured: string | undefined
    skills.snapshot = async (options?: { cwd?: string }) => {
      captured = options?.cwd
      return { skills: [], complete: true }
    }
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.catalog).handler(fakeReq('GET', SKILL_HUB_API.catalog + '?cwd=%2Ftmp%2Fproject'), res as never)
    expect(res.status).toBe(200)
    expect(captured).toBe('/tmp/project')
  })

  it('merges every known workspace into the default catalog with workspace fields', async () => {
    // workspace.json 声明两个工作区；每个工作区的 snapshot 返回其项目技能 + 用户级技能。
    await mkdir(join(home, 'storages'), { recursive: true })
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
      tables: {
        workspaces: {
          a: { title: 'Alpha', path: '/ws/a' },
          b: { title: 'Beta', path: '/ws/b' },
        },
      },
    }), 'utf8')
    skills.snapshot = async (options?: { cwd?: string }) => {
      const user = summary({ name: 'shared-user' })
      if (options?.cwd === '/ws/a') {
        return { skills: [user, summary({ name: 'ws-a-skill', source: 'project-dsh', provider: 'skill-hub' })], complete: true }
      }
      if (options?.cwd === '/ws/b') {
        return { skills: [user, summary({ name: 'ws-b-skill', source: 'project-agents', provider: 'skill-hub' })], complete: false }
      }
      return { skills: [user], complete: true }
    }
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.catalog).handler(fakeReq('GET', SKILL_HUB_API.catalog), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as CatalogResponse
    expect(body.complete).toBe(false) // 任一工作区不完整则整体不完整
    const byName = new Map(body.skills.map((skill) => [skill.name, skill]))
    expect(byName.has('ws-a-skill')).toBe(true)
    expect(byName.get('ws-a-skill')).toMatchObject({ workspace: '/ws/a', workspaceTitle: 'Alpha', writable: false })
    expect(byName.get('ws-b-skill')).toMatchObject({ workspace: '/ws/b', workspaceTitle: 'Beta' })
    // 同名用户级技能只出现一次，且不带 workspace 字段。
    expect(byName.get('shared-user')).toMatchObject({ writable: true })
    expect(byName.get('shared-user')?.workspace).toBeUndefined()
  })

  it('flags duplicate names only across distinct source/provider identities', async () => {
    // 两个工作区快照返回同一个用户级技能：同一来源+提供者，不算重名。
    await mkdir(join(home, 'storages'), { recursive: true })
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
      tables: { workspaces: { a: { title: 'Alpha', path: '/ws/a' }, b: { title: 'Beta', path: '/ws/b' } } },
    }), 'utf8')
    skills.snapshot = async () => ({
      skills: [
        summary({ name: 'shared-user', source: 'user-dsh', provider: 'skill-hub' }),
        summary({ name: 'two-homes', source: 'custom', provider: 'openviking' }),
        summary({ name: 'two-homes', source: 'user-dsh', provider: 'skill-hub' }),
      ],
      complete: true,
    })
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.catalog).handler(fakeReq('GET', SKILL_HUB_API.catalog), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as CatalogResponse
    // shared-user 在两个快照出现但身份一致 → 不标；two-homes 来源不同 → 标。
    expect(body.duplicateNames ?? []).toEqual(['two-homes'])
  })

  it('falls back across workspaces when fetching a project skill detail without cwd', async () => {
    await mkdir(join(home, 'storages'), { recursive: true })
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
      tables: { workspaces: { a: { title: 'Alpha', path: '/ws/a' } } },
    }), 'utf8')
    const calls: Array<string | undefined> = []
    skills.get = async (name: string, options?: { cwd?: string }) => {
      calls.push(options?.cwd)
      return name === 'ws-a-skill' && options?.cwd === '/ws/a' ? definition({ name, source: 'project-dsh' }) : undefined
    }
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.skill).handler(fakeReq('GET', SKILL_HUB_API.skill + '?name=ws-a-skill'), res as never)
    expect(res.status).toBe(200)
    expect(calls).toEqual(['/ws/a']) // 工作区命中即停，不再回退用户根
    const miss = new FakeResponse()
    await routeFor(SKILL_HUB_API.skill).handler(fakeReq('GET', SKILL_HUB_API.skill + '?name=nope'), miss as never)
    expect(miss.status).toBe(404)
    expect(calls).toEqual(['/ws/a', '/ws/a', undefined]) // 未命中时回退用户根
  })

  it('serves skill detail and 404s unknown names', async () => {
    skills.get = async (name: string) => name === 'demo-skill' ? definition({ path: '/x/demo-skill/SKILL.md' }) : undefined
    const ok = new FakeResponse()
    await routeFor(SKILL_HUB_API.skill).handler(fakeReq('GET', SKILL_HUB_API.skill + '?name=demo-skill'), ok as never)
    expect(ok.status).toBe(200)
    const missing = new FakeResponse()
    await routeFor(SKILL_HUB_API.skill).handler(fakeReq('GET', SKILL_HUB_API.skill + '?name=nope'), missing as never)
    expect(missing.status).toBe(404)
  })

  it('toggles a writable skill off and back on', async () => {
    const path = join(home, 'skills', 'demo-skill', 'SKILL.md')
    await mkdir(join(home, 'skills', 'demo-skill'), { recursive: true })
    await writeFile(path, '---\nname: demo-skill\ndescription: demo\n---\n\nbody', 'utf8')
    skills.get = async () => definition({ path })
    const off = new FakeResponse()
    await routeFor(SKILL_HUB_API.toggle).handler(fakeReq('POST', SKILL_HUB_API.toggle, { name: 'demo-skill', enabled: false }), off as never)
    expect(off.status).toBe(200)
    expect(await store.listDisabled()).toHaveLength(1)
    await expect(access(path)).rejects.toThrow()
    const on = new FakeResponse()
    await routeFor(SKILL_HUB_API.toggle).handler(fakeReq('POST', SKILL_HUB_API.toggle, { name: 'demo-skill', enabled: true }), on as never)
    expect(on.status).toBe(200)
    expect(await store.listDisabled()).toHaveLength(0)
    await expect(access(path)).resolves.toBeUndefined()
  })

  it('refuses to toggle read-only sources', async () => {
    skills.get = async () => definition({ source: 'bundled', provider: 'bundled' })
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.toggle).handler(fakeReq('POST', SKILL_HUB_API.toggle, { name: 'demo-skill', enabled: false }), res as never)
    expect(res.status).toBe(409)
    const body = res.json() as ErrorResponse
    expect(body.error).toContain('managed outside the hub')
  })

  it('disables a whole group in one write', async () => {
    for (const name of ['batch-a', 'batch-b']) {
      const dir = join(home, 'skills', name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: A batch skill\n---\n\nbody', 'utf8')
    }
    skills.get = async (name: string) => definition({ name, path: join(home, 'skills', name, 'SKILL.md'), source: 'user-dsh' })
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.toggleBatch).handler(fakeReq('POST', SKILL_HUB_API.toggleBatch, { names: ['batch-a', 'batch-b'], enabled: false }), res as never)
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
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.toggleBatch).handler(fakeReq('POST', SKILL_HUB_API.toggleBatch, { names: ['batch-a', 'batch-b'], enabled: true }), res as never)
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
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.toggleBatch).handler(fakeReq('POST', SKILL_HUB_API.toggleBatch, { names: ['batch-c', 'readonly-x'], enabled: false }), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').ToggleBatchResponse
    expect(body.failures).toHaveLength(1)
    expect(body.failures[0].name).toBe('readonly-x')
    expect(await store.listDisabled()).toHaveLength(1)
  })

  // -------------------------------------------------------- skill delete
  it('deletes one writable skill into the restorable trash and cleans metadata', async () => {
    const dir = join(home, 'skills', 'delete-me')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: delete-me\ndescription: x\n---\n\nbody', 'utf8')
    const tag = await store.saveTag({ name: 'web' })
    await store.setTagMembers(tag.id, ['delete-me'])
    await store.addSourceSkill('repo/a', 'skills', 'sha', undefined, 'delete-me')
    skills.get = async () => definition({ name: 'delete-me', path: join(dir, 'SKILL.md'), source: 'user-dsh' })
    const invalidate = vi.fn()
    deps.invalidate = invalidate

    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.skillDelete).handler(fakeReq('POST', SKILL_HUB_API.skillDelete, { name: 'delete-me' }), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').SkillDeleteResponse
    expect(body.path.startsWith(join(home, 'skills', '.trash', 'delete-me-'))).toBe(true)
    await expect(access(dir)).rejects.toThrow()
    expect((await store.listTags())[0].skillNames).toEqual([])
    expect(await store.listSources()).toEqual([])
    expect(await store.listOrigins()).toEqual({})
    expect(invalidate).toHaveBeenCalledTimes(1)

    const restore = new FakeResponse()
    await routeFor(SKILL_HUB_API.sourceRestore).handler(fakeReq('POST', SKILL_HUB_API.sourceRestore, { name: 'delete-me' }), restore as never)
    expect(restore.status).toBe(200)
    await expect(access(join(dir, 'SKILL.md'))).resolves.toBeUndefined()
    // 恢复后来源归属与场景成员一并恢复（不再变成「个人技能」）。
    expect((await store.getSource('repo/a'))?.skills).toEqual(['delete-me'])
    expect((await store.listTags()).find((tag) => tag.name === 'web')?.skillNames).toEqual(['delete-me'])
  })

  it('deletes and restores a flat skill file', async () => {
    const flat = join(home, 'skills', 'flat-delete.md')
    await writeFile(flat, '---\nname: flat-delete\ndescription: x\n---\n\nbody', 'utf8')
    skills.get = async () => definition({ name: 'flat-delete', path: flat, source: 'user-dsh' })

    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.skillDelete).handler(fakeReq('POST', SKILL_HUB_API.skillDelete, { name: 'flat-delete' }), res as never)
    expect(res.status).toBe(200)
    await expect(access(flat)).rejects.toThrow()
    const trash = await store.listTrash()
    expect(trash[0].sourcePath).toBe(flat)

    const restore = new FakeResponse()
    await routeFor(SKILL_HUB_API.sourceRestore).handler(fakeReq('POST', SKILL_HUB_API.sourceRestore, { name: 'flat-delete' }), restore as never)
    expect(restore.status).toBe(200)
    await expect(access(flat)).resolves.toBeUndefined()
  })

  it('rejects deleting read-only, missing, and out-of-root skills', async () => {
    skills.get = async () => definition({ source: 'bundled', provider: 'bundled', path: '/bundled/x/SKILL.md' })
    const readOnly = new FakeResponse()
    await routeFor(SKILL_HUB_API.skillDelete).handler(fakeReq('POST', SKILL_HUB_API.skillDelete, { name: 'x' }), readOnly as never)
    expect(readOnly.status).toBe(409)

    skills.get = async () => definition({ source: 'user-dsh', path: '/outside/skills/x/SKILL.md' })
    const outside = new FakeResponse()
    await routeFor(SKILL_HUB_API.skillDelete).handler(fakeReq('POST', SKILL_HUB_API.skillDelete, { name: 'x' }), outside as never)
    expect(outside.status).toBe(409)

    skills.get = async () => undefined
    const missing = new FakeResponse()
    await routeFor(SKILL_HUB_API.skillDelete).handler(fakeReq('POST', SKILL_HUB_API.skillDelete, { name: 'x' }), missing as never)
    expect(missing.status).toBe(404)

    const empty = new FakeResponse()
    await routeFor(SKILL_HUB_API.skillDelete).handler(fakeReq('POST', SKILL_HUB_API.skillDelete, {}), empty as never)
    expect(empty.status).toBe(400)
  })

  it('creates a skill scaffold and rejects bad names', async () => {
    const ok = new FakeResponse()
    await routeFor(SKILL_HUB_API.create).handler(fakeReq('POST', SKILL_HUB_API.create, { name: 'new-skill', description: 'Fresh' }), ok as never)
    expect(ok.status).toBe(201)
    const bad = new FakeResponse()
    await routeFor(SKILL_HUB_API.create).handler(fakeReq('POST', SKILL_HUB_API.create, { name: 'Not Valid' }), bad as never)
    expect(bad.status).toBe(400)
  })

  it('refuses to create a duplicate name', async () => {
    skills.get = async () => definition({})
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.create).handler(fakeReq('POST', SKILL_HUB_API.create, { name: 'demo-skill' }), res as never)
    expect(res.status).toBe(409)
  })

  it('refuses to create a skill whose name is currently disabled', async () => {
    await store.addDisabled({
      name: 'demo-skill',
      description: 'old disabled skill',
      path: join(home, 'skills', 'demo-skill', 'SKILL.md.disabled'),
      root: 'user-dsh',
      disabledAt: Date.now(),
    })
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.create).handler(fakeReq('POST', SKILL_HUB_API.create, { name: 'demo-skill' }), res as never)
    expect(res.status).toBe(409)
  })

  it('serves the hub config with saved overrides', async () => {
    const routes = makeRoutes({
      ...deps,
      config: () => ({ enabled: false, announceToAgent: true }),
      saved: () => ({ enabled: false }),
    })
    const res = new FakeResponse()
    await routes.find((r) => r.path === SKILL_HUB_API.config)?.handler(fakeReq('GET', SKILL_HUB_API.config), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as ConfigResponse
    expect(body.ok).toBe(true)
    expect(body.pluginVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(body.config).toEqual({ enabled: false, announceToAgent: true, showUseCount: true, showUseTime: true, showGroupSummary: true, statsWindowDays: 14, statsScanMinutes: 5 })
    expect(body.saved).toEqual({ enabled: false })
  })

  it('patches the hub config through the owner updateConfig', async () => {
    const patches: Array<Partial<HubConfig>> = []
    const updateConfig = async (patch: Partial<HubConfig>): Promise<HubConfig> => {
      patches.push(patch)
      return { enabled: false, announceToAgent: false, showUseCount: true, showUseTime: true, showGroupSummary: true }
    }
    const routes = makeRoutes({
      ...deps,
      config: () => ({ enabled: true, announceToAgent: true }),
      saved: () => ({ enabled: false, announceToAgent: false }),
      updateConfig,
    })
    const res = new FakeResponse()
    await routes.find((r) => r.path === SKILL_HUB_API.config)?.handler(fakeReq('POST', SKILL_HUB_API.config, { announceToAgent: false }), res as never)
    expect(res.status).toBe(200)
    expect(patches).toEqual([{ announceToAgent: false }])
    const body = res.json() as ConfigResponse
    expect(body.config).toEqual({ enabled: false, announceToAgent: false, showUseCount: true, showUseTime: true, showGroupSummary: true })
  })

  it('clears a saved override with null on the config route', async () => {
    const patches: Array<Partial<HubConfig>> = []
    const updateConfig = async (patch: Partial<HubConfig>): Promise<HubConfig> => {
      patches.push(patch)
      return { enabled: true, announceToAgent: true, showUseCount: true, showUseTime: true, showGroupSummary: true }
    }
    const routes = makeRoutes({
      ...deps,
      config: () => ({ enabled: false, announceToAgent: true }),
      saved: () => ({ enabled: false }),
      updateConfig,
    })
    const res = new FakeResponse()
    await routes.find((r) => r.path === SKILL_HUB_API.config)?.handler(fakeReq('POST', SKILL_HUB_API.config, { enabled: null }), res as never)
    expect(res.status).toBe(200)
    expect(patches).toEqual([{ enabled: undefined }])
  })

  it('rejects non-boolean config patches', async () => {
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.config).handler(fakeReq('POST', SKILL_HUB_API.config, { enabled: 'yes' }), res as never)
    expect(res.status).toBe(400)
    const body = res.json() as ErrorResponse
    expect(body.error).toContain('enabled must be a boolean or null')
  })

  it('sets and clears the github token through the config route', async () => {
    const patches: Array<Partial<HubConfig>> = []
    const updateConfig = async (patch: Partial<HubConfig>): Promise<HubConfig> => {
      patches.push(patch)
      return { enabled: true, announceToAgent: true, showUseCount: true, showUseTime: true, showGroupSummary: true, statsWindowDays: 14, statsScanMinutes: 5 }
    }
    const routes = makeRoutes({ ...deps, updateConfig })
    const set = new FakeResponse()
    await routes.find((r) => r.path === SKILL_HUB_API.config)?.handler(fakeReq('POST', SKILL_HUB_API.config, { githubToken: 'ghp_1234567890abcdef' }), set as never)
    expect(set.status).toBe(200)
    expect(patches).toEqual([{ githubToken: 'ghp_1234567890abcdef' }])
    const clear = new FakeResponse()
    await routes.find((r) => r.path === SKILL_HUB_API.config)?.handler(fakeReq('POST', SKILL_HUB_API.config, { githubToken: null }), clear as never)
    expect(clear.status).toBe(200)
    expect(patches[1]).toEqual({ githubToken: undefined })
    const bad = new FakeResponse()
    await routes.find((r) => r.path === SKILL_HUB_API.config)?.handler(fakeReq('POST', SKILL_HUB_API.config, { githubToken: 'not a token!' }), bad as never)
    expect(bad.status).toBe(400)
  })

  it('keeps the config route up while the hub is disabled (business routes 503)', async () => {
    const routes = makeRoutes({
      ...deps,
      config: () => ({ enabled: false, announceToAgent: true }),
      saved: () => ({ enabled: false }),
    })
    const business = new FakeResponse()
    await routes.find((r) => r.path === SKILL_HUB_API.catalog)?.handler(fakeReq('GET', SKILL_HUB_API.catalog), business as never)
    expect(business.status).toBe(503)
    const cfg = new FakeResponse()
    await routes.find((r) => r.path === SKILL_HUB_API.config)?.handler(fakeReq('GET', SKILL_HUB_API.config), cfg as never)
    expect(cfg.status).toBe(200)
  })

  // ------------------------------------------------------- market sources
  it('lists, adds, and removes market sources', async () => {
    const list = new FakeResponse()
    await routeFor(SKILL_HUB_API.market).handler(fakeReq('GET', SKILL_HUB_API.market), list as never)
    expect((list.json() as import('./protocol.ts').MarketSourcesResponse).repos).toEqual([])
    const add = new FakeResponse()
    await routeFor(SKILL_HUB_API.marketSource).handler(fakeReq('POST', SKILL_HUB_API.marketSource, { repo: 'https://github.com/anthropics/skills' }), add as never)
    expect(add.status).toBe(200)
    expect((add.json() as import('./protocol.ts').MarketSourceResponse).repos).toEqual([{ repo: 'anthropics/skills' }])
    const dup = new FakeResponse()
    await routeFor(SKILL_HUB_API.marketSource).handler(fakeReq('POST', SKILL_HUB_API.marketSource, { repo: 'anthropics/skills' }), dup as never)
    expect((dup.json() as import('./protocol.ts').MarketSourceResponse).repos).toEqual([{ repo: 'anthropics/skills' }])
    const pinned = new FakeResponse()
    await routeFor(SKILL_HUB_API.marketSource).handler(fakeReq('POST', SKILL_HUB_API.marketSource, { repo: 'other/repo@v2.0.0' }), pinned as never)
    expect(pinned.status).toBe(200)
    expect((pinned.json() as import('./protocol.ts').MarketSourceResponse).repos).toEqual([
      { repo: 'anthropics/skills' },
      { repo: 'other/repo', ref: 'v2.0.0' },
    ])
    const bad = new FakeResponse()
    await routeFor(SKILL_HUB_API.marketSource).handler(fakeReq('POST', SKILL_HUB_API.marketSource, { repo: 'not a repo' }), bad as never)
    expect(bad.status).toBe(400)
    const del = new FakeResponse()
    await routeFor(SKILL_HUB_API.marketSourceDelete).handler(fakeReq('POST', SKILL_HUB_API.marketSourceDelete, { repo: 'anthropics/skills' }), del as never)
    expect((del.json() as import('./protocol.ts').MarketSourceResponse).repos).toEqual([{ repo: 'other/repo', ref: 'v2.0.0' }])
  })

  // ------------------------------------------------------- repo import (B方案 job+轮询)
  it('imports repo skills and records the upstream source', async () => {
    const skillMd = '---\nname: code-review\ndescription: Reviews code\n---\n\nbody'
    stubFetch([
      // 更具体的 URL 在前（stubFetch 按顺序匹配）。
      ['repos/example/repo/git/trees/main', jsonResponse({ tree: [
        { path: 'skills/code-review/SKILL.md', type: 'blob', size: 60 },
        { path: 'skills/code-review/helper.py', type: 'blob', size: 20 },
      ] })],
      ['repos/example/repo/commits', jsonResponse({ sha: 'abc123', commit: { tree: { sha: 'tree1' } } })],
      ['repos/example/repo', jsonResponse({ default_branch: 'main' })],
      ['raw.githubusercontent.com/example/repo/main/skills/code-review/SKILL.md', new Response(skillMd, { status: 200 })],
      ['raw.githubusercontent.com/example/repo/main/skills/code-review/helper.py', new Response('x = 1', { status: 200 })],
    ])
    try {
      const res = new FakeResponse()
      await routeFor(SKILL_HUB_API.repoImport).handler(fakeReq('POST', SKILL_HUB_API.repoImport, { repo: 'example/repo', paths: ['skills/code-review/SKILL.md'] }), res as never)
      expect(res.status).toBe(200)
      const created = res.json() as import('./protocol.ts').RepoImportResponse
      expect(created.jobId).toMatch(/^imp_/)
      expect(created.total).toBe(1)
      // 轮询直到完成（后台任务选项2：关面板也继续跑，轮询查进度）
      let prog: import('./protocol.ts').RepoImportProgressResponse | undefined
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50))
        const progRes = new FakeResponse()
        await routeFor(SKILL_HUB_API.repoImportProgress).handler(fakeReq('GET', `${SKILL_HUB_API.repoImportProgress}?jobId=${created.jobId}`), progRes as never)
        expect(progRes.status).toBe(200)
        prog = progRes.json() as import('./protocol.ts').RepoImportProgressResponse
        if (prog.status !== 'running') break
      }
      expect(prog).toBeDefined()
      expect(prog!.status).toBe('done')
      expect(prog!.imported).toHaveLength(1)
      expect(prog!.imported[0]).toMatchObject({ name: 'code-review', origin: 'example/repo' })
      await expect(access(join(home, 'skills', 'code-review', 'SKILL.md'))).resolves.toBeUndefined()
      const sources = await store.listSources()
      expect(sources).toHaveLength(1)
      expect(sources[0]).toMatchObject({ repo: 'example/repo', root: 'skills', commitSha: 'abc123', skills: ['code-review'] })
      expect(sources[0].manifest).toEqual({
        'skills/code-review/SKILL.md': 60,
        'skills/code-review/helper.py': 20,
      })
      // 导入的技能自动归入默认场景「通用」，场景 tab 里可见。
      expect((await store.getDefaultTag())?.skillNames).toEqual(['code-review'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // -------------------------------------------------------------- groups
  it('serves groups: user tags + system collections + origins', async () => {
    const tag = await store.saveTag({ name: 'web' })
    await store.setTagMembers(tag.id, ['demo-skill'])
    await store.addSourceSkill('superpowers', 'skills', '', undefined, 'demo-skill')
    await store.addSourceSkill('anthropics/skills', 'skills', '', undefined, 'pdf')
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.groups).handler(fakeReq('GET', SKILL_HUB_API.groups), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').GroupsResponse
    expect(body.tags.filter((t) => t.default !== true)).toHaveLength(1)
    expect(body.tags.find((t) => t.default !== true)).toMatchObject({ name: 'web', skillNames: ['demo-skill'] })
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
    // 响应里含默认场景「通用」，新建的排在它后面。
    const createdTag = createdBody.tags.find((t) => t.default !== true)
    expect(createdTag).toMatchObject({ name: 'web' })
    const id = createdTag!.id
    const renamed = new FakeResponse()
    await routeFor(SKILL_HUB_API.tag).handler(fakeReq('POST', SKILL_HUB_API.tag, { id, name: 'frontend' }), renamed as never)
    expect(renamed.status).toBe(200)
    const renamedBody = renamed.json() as import('./protocol.ts').TagSaveResponse
    expect(renamedBody.tags.find((t) => t.id === id)).toMatchObject({ id, name: 'frontend' })
    const empty = new FakeResponse()
    await routeFor(SKILL_HUB_API.tag).handler(fakeReq('POST', SKILL_HUB_API.tag, { name: '  ' }), empty as never)
    expect(empty.status).toBe(400)
  })

  it('reports a 404 when renaming a tag that does not exist', async () => {
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.tag).handler(fakeReq('POST', SKILL_HUB_API.tag, { id: 'no-such-id', name: 'x' }), res as never)
    expect(res.status).toBe(404)
  })

  it('deletes a tag', async () => {
    const created = new FakeResponse()
    await routeFor(SKILL_HUB_API.tag).handler(fakeReq('POST', SKILL_HUB_API.tag, { name: 'tmp' }), created as never)
    const createdBody = created.json() as import('./protocol.ts').TagSaveResponse
    const id = createdBody.tags.find((t) => t.default !== true)!.id
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.tagDelete).handler(fakeReq('POST', SKILL_HUB_API.tagDelete, { id }), res as never)
    expect(res.status).toBe(200)
    // 默认场景「通用」不可删，删普通 tag 后只剩它。
    const after = (res.json() as import('./protocol.ts').TagDeleteResponse).tags
    expect(after.filter((t) => t.default !== true)).toEqual([])
    expect(after.some((t) => t.default === true)).toBe(true)
  })

  it('sets tag members and drops names absent from the catalog', async () => {
    skills.snapshot = async () => ({ skills: [summary()], complete: true })
    const created = new FakeResponse()
    await routeFor(SKILL_HUB_API.tag).handler(fakeReq('POST', SKILL_HUB_API.tag, { name: 'web' }), created as never)
    const createdBody = created.json() as import('./protocol.ts').TagSaveResponse
    const id = createdBody.tags.find((t) => t.default !== true)!.id
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.tagMembers).handler(fakeReq('POST', SKILL_HUB_API.tagMembers, { id, skillNames: ['demo-skill', 'ghost-skill'] }), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').TagMembersResponse
    expect(body.tags.find((t) => t.id === id)?.skillNames).toEqual(['demo-skill'])
  })

  // ------------------------------------------------------------- sources
  it('serves sources with derived origins, collections, and trash', async () => {
    await store.addSourceSkill('repo/a', 'skills', 'sha', undefined, 'one')
    await store.addSourceSkill('repo/a', 'skills', 'sha', undefined, 'two')
    await store.addTrash({ name: 'gone', path: join(home, 'skills', '.trash', 'gone-1'), movedAt: 5 })
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.sources).handler(fakeReq('GET', SKILL_HUB_API.sources), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').SourcesResponse
    expect(body.sources).toHaveLength(1)
    expect(body.sources[0].skills).toEqual(['one', 'two'])
    expect(body.origins).toEqual({ one: 'repo/a', two: 'repo/a' })
    expect(body.collections).toEqual([{ name: 'repo/a', skillNames: ['one', 'two'] }])
    expect(body.trash).toHaveLength(1)
  })

  it('checks a source: unchanged commit reports no update; changed commit diffs the tree', async () => {
    await store.addSourceSkill('repo/check-a', 'skills', 'same-sha', undefined, 'alpha')
    stubFetch([
      ['repos/repo/check-a/commits', jsonResponse({ sha: 'same-sha', commit: { tree: { sha: 't' } } })],
    ])
    try {
      const res = new FakeResponse()
      await routeFor(SKILL_HUB_API.sourceCheck).handler(fakeReq('POST', SKILL_HUB_API.sourceCheck, {}), res as never)
      expect(res.status).toBe(200)
      const body = res.json() as import('./protocol.ts').SourceCheckResponse
      expect(body.results).toHaveLength(1)
      expect(body.results[0]).toMatchObject({ repo: 'repo/check-a', changed: false, updated: [], deleted: [] })
    } finally {
      vi.unstubAllGlobals()
    }

    // A changed commit pulls the tree: alpha updated (manifest baseline), beta deleted.
    await store.addSourceSkill('repo/check-b', 'skills', 'old-sha', undefined, 'alpha')
    await store.addSourceSkill('repo/check-b', 'skills', 'old-sha', undefined, 'beta')
    await store.mergeSourceManifest('repo/check-b', { 'skills/alpha/SKILL.md': 10 })
    stubFetch([
      ['repos/repo/check-b/commits', jsonResponse({ sha: 'new-sha', commit: { tree: { sha: 'treeX' } } })],
      ['repos/repo/check-b/git/trees/treeX', jsonResponse({ tree: [
        { path: 'skills/alpha/SKILL.md', type: 'blob', size: 99 },
        { path: 'skills/alpha/tools.py', type: 'blob', size: 5 },
      ] })],
    ])
    try {
      const res = new FakeResponse()
      await routeFor(SKILL_HUB_API.sourceCheck).handler(fakeReq('POST', SKILL_HUB_API.sourceCheck, { repo: 'repo/check-b' }), res as never)
      expect(res.status).toBe(200)
      const body = res.json() as import('./protocol.ts').SourceCheckResponse
      expect(body.results[0]).toMatchObject({ repo: 'repo/check-b', changed: true, commitSha: 'new-sha', updated: ['alpha'], deleted: ['beta'] })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports a per-source check error without failing the batch', async () => {
    await store.addSourceSkill('repo/error-x', 'skills', 'old', undefined, 'one')
    stubFetch([
      ['repos/repo/error-x/commits', new Response('nope', { status: 404 })],
    ])
    try {
      const res = new FakeResponse()
      await routeFor(SKILL_HUB_API.sourceCheck).handler(fakeReq('POST', SKILL_HUB_API.sourceCheck, {}), res as never)
      expect(res.status).toBe(200)
      const body = res.json() as import('./protocol.ts').SourceCheckResponse
      expect(body.results[0].error).toContain('404')
      expect(body.results[0].changed).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('syncs a source to the latest commit, updating manifest and preserving disabled state', async () => {
    await store.addSourceSkill('repo/sync-a', 'skills', 'old-sha', undefined, 'docx')
    await store.addSourceSkill('repo/sync-a', 'skills', 'old-sha', undefined, 'pdf')
    await store.mergeSourceManifest('repo/sync-a', { 'skills/docx/SKILL.md': 10, 'skills/pdf/SKILL.md': 10 })
    const dir = join(home, 'skills', 'docx')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md.disabled'), '---\nname: docx\ndescription: old\n---', 'utf8')
    await store.addDisabled({ name: 'docx', description: 'old', path: join(dir, 'SKILL.md.disabled'), root: 'user-dsh', disabledAt: 1 })

    stubFetch([
      ['repos/repo/sync-a/commits', jsonResponse({ sha: 'new-sha', commit: { tree: { sha: 'treeY' } } })],
      ['repos/repo/sync-a/git/trees/treeY', jsonResponse({ tree: [
        { path: 'skills/docx/SKILL.md', type: 'blob', size: 80 },
        { path: 'skills/pdf/SKILL.md', type: 'blob', size: 70 },
      ] })],
      ['raw.githubusercontent.com/repo/sync-a/new-sha/skills/docx/SKILL.md', new Response('---\nname: docx\ndescription: fresh\n---\n\nnew body', { status: 200 })],
      ['raw.githubusercontent.com/repo/sync-a/new-sha/skills/pdf/SKILL.md', new Response('---\nname: pdf\ndescription: fresh pdf\n---\n\nbody', { status: 200 })],
    ])
    try {
      const res = new FakeResponse()
      await routeFor(SKILL_HUB_API.sourceSync).handler(fakeReq('POST', SKILL_HUB_API.sourceSync, { repo: 'repo/sync-a' }), res as never)
      expect(res.status).toBe(200)
      const body = res.json() as import('./protocol.ts').SourceSyncResponse
      expect(body.synced).toEqual(['docx', 'pdf'])
      expect(body.failed).toEqual([])
      expect(body.commitSha).toBe('new-sha')
      // docx was disabled: fresh content stays out of discovery
      await expect(access(join(home, 'skills', 'docx', 'SKILL.md'))).rejects.toThrow()
      await expect(access(join(home, 'skills', 'docx', 'SKILL.md.disabled'))).resolves.toBeUndefined()
      await expect(access(join(home, 'skills', 'pdf', 'SKILL.md'))).resolves.toBeUndefined()
      const source = await store.getSource('repo/sync-a')
      expect(source?.commitSha).toBe('new-sha')
      expect(source?.manifest).toEqual({ 'skills/docx/SKILL.md': 80, 'skills/pdf/SKILL.md': 70 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('follows upstream deletion into the trash and restores it', async () => {
    const dir = join(home, 'skills', 'gone-skill')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: gone-skill\ndescription: x\n---', 'utf8')
    await store.addSourceSkill('repo/delete-a', 'skills', 'sha', undefined, 'gone-skill')
    await store.addSourceSkill('repo/delete-a', 'skills', 'sha', undefined, 'keeper')

    const del = new FakeResponse()
    await routeFor(SKILL_HUB_API.sourceDelete).handler(fakeReq('POST', SKILL_HUB_API.sourceDelete, { repo: 'repo/delete-a', skills: ['gone-skill'] }), del as never)
    expect(del.status).toBe(200)
    const delBody = del.json() as import('./protocol.ts').SourceDeleteResponse
    expect(delBody.trashed).toEqual(['gone-skill'])
    expect(delBody.failed).toEqual([])
    await expect(access(dir)).rejects.toThrow()
    expect((await store.listTrash()).map((entry) => entry.name)).toEqual(['gone-skill'])
    const source = await store.getSource('repo/delete-a')
    expect(source?.skills).toEqual(['keeper'])

    const restore = new FakeResponse()
    await routeFor(SKILL_HUB_API.sourceRestore).handler(fakeReq('POST', SKILL_HUB_API.sourceRestore, { name: 'gone-skill' }), restore as never)
    expect(restore.status).toBe(200)
    await expect(access(join(home, 'skills', 'gone-skill', 'SKILL.md'))).resolves.toBeUndefined()
    expect(await store.listTrash()).toEqual([])
    // 恢复后技能重新挂回来源记录（下一次检查会如实提示上游仍无此技能）。
    expect((await store.getSource('repo/delete-a'))?.skills).toEqual(['gone-skill', 'keeper'])

    // restoring again collides with the existing directory
    const again = new FakeResponse()
    await routeFor(SKILL_HUB_API.sourceRestore).handler(fakeReq('POST', SKILL_HUB_API.sourceRestore, { name: 'gone-skill' }), again as never)
    expect(again.status).toBe(404)
  })

  it('clears the trash permanently and keeps failed entries', async () => {
    const trash = join(home, 'skills', '.trash')
    await mkdir(trash, { recursive: true })
    const goneDir = join(trash, 'gone-skill-1')
    await mkdir(goneDir, { recursive: true })
    await writeFile(join(goneDir, 'SKILL.md'), '---\nname: gone-skill\ndescription: x\n---', 'utf8')
    await store.addTrash({ name: 'gone-skill', path: goneDir, movedAt: 1, sourcePath: join(home, 'skills', 'gone-skill') })
    await store.addTrash({ name: 'outside', path: '/tmp/.trash-outside/outside-1', movedAt: 2, sourcePath: '/tmp/skills/outside' })
    const invalidate = vi.fn()
    deps.invalidate = invalidate

    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.sourceTrashClear).handler(fakeReq('POST', SKILL_HUB_API.sourceTrashClear), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').SourceTrashClearResponse
    expect(body.deleted).toEqual(['gone-skill'])
    expect(body.failed).toHaveLength(1)
    await expect(access(goneDir)).rejects.toThrow()
    expect((await store.listTrash()).map((entry) => entry.name)).toEqual(['outside'])
    expect(invalidate).toHaveBeenCalledTimes(1)
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

  it('rejects path traversal and untracked names in source delete', async () => {
    // A tracked skill plus an untracked name and a `..`-bearing name.
    await mkdir(join(home, 'skills', 'tracked-skill'), { recursive: true })
    await writeFile(join(home, 'skills', 'tracked-skill', 'SKILL.md'), '---\nname: tracked-skill\ndescription: x\n---', 'utf8')
    // The traversal target lives OUTSIDE the writable root; it must survive.
    const victim = join(dir, 'victim-dir')
    await mkdir(victim, { recursive: true })
    await writeFile(join(victim, 'keep.txt'), 'keep', 'utf8')
    await store.addSourceSkill('repo/guard', 'skills', 'abc', undefined, 'tracked-skill')

    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.sourceDelete).handler(fakeReq('POST', SKILL_HUB_API.sourceDelete, {
      repo: 'repo/guard',
      skills: ['../victim-dir', 'not-tracked', 'tracked-skill'],
    }), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').SourceDeleteResponse
    expect(body.trashed).toEqual(['tracked-skill'])
    expect(body.failed.map((f) => f.name)).toEqual(['../victim-dir', 'not-tracked'])
    // The out-of-root directory was never renamed.
    await expect(access(join(victim, 'keep.txt'))).resolves.toBeUndefined()
  })

  it('keeps the old commit snapshot when a sync partially fails', async () => {
    await mkdir(join(home, 'skills', 'a-skill'), { recursive: true })
    await writeFile(join(home, 'skills', 'a-skill', 'SKILL.md'), '---\nname: a-skill\ndescription: x\n---', 'utf8')
    await store.addSourceSkill('repo/partial', 'skills', 'oldcommit', undefined, 'a-skill')
    await store.addSourceSkill('repo/partial', 'skills', 'oldcommit', undefined, 'b-skill')
    // Upstream only still has a-skill; b-skill is missing → that item fails.
    stubFetch([
      ['repos/repo/partial/commits', jsonResponse({ sha: 'newcommit', commit: { tree: { sha: 't2' } } })],
      ['repos/repo/partial/git/trees/t2', jsonResponse({ tree: [
        { path: 'skills/a-skill/SKILL.md', type: 'blob', size: 40 },
      ] })],
      ['raw.githubusercontent.com/repo/partial/newcommit/skills/a-skill/SKILL.md', new Response('---\nname: a-skill\ndescription: x\n---', { status: 200 })],
    ])
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.sourceSync).handler(fakeReq('POST', SKILL_HUB_API.sourceSync, { repo: 'repo/partial' }), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').SourceSyncResponse
    expect(body.synced).toEqual(['a-skill'])
    expect(body.failed.map((f) => f.name)).toEqual(['b-skill'])
    // The snapshot must NOT advance: the next check still diffs the tree and
    // re-reports b-skill instead of silently hiding the stale copy.
    expect((await store.getSource('repo/partial'))?.commitSha).toBe('oldcommit')
  })

  it('refuses to overwrite a broken same-name directory on create', async () => {
    await mkdir(join(home, 'skills', 'broken-dir'), { recursive: true })
    await writeFile(join(home, 'skills', 'broken-dir', 'SKILL.md'), '# not a valid skill', 'utf8')
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.create).handler(fakeReq('POST', SKILL_HUB_API.create, { name: 'broken-dir' }), res as never)
    expect(res.status).toBe(409)
    // The original broken file must still be there, untouched.
    expect(await readFile(join(home, 'skills', 'broken-dir', 'SKILL.md'), 'utf8')).toBe('# not a valid skill')
  })

  it('backfills an unverified source snapshot on first check', async () => {
    await store.addSourceSkill('repo/verify-me', 'skills', '', undefined, 's1')
    stubFetch([
      ['repos/repo/verify-me/commits', jsonResponse({ sha: 'v1', commit: { tree: { sha: 'tv' } } })],
    ])
    const res = new FakeResponse()
    await routeFor(SKILL_HUB_API.sourceCheck).handler(fakeReq('POST', SKILL_HUB_API.sourceCheck, { repo: 'repo/verify-me' }), res as never)
    expect(res.status).toBe(200)
    const body = res.json() as import('./protocol.ts').SourceCheckResponse
    expect(body.results[0]).toMatchObject({ repo: 'repo/verify-me', changed: false, unverified: true, commitSha: 'v1' })
    // Snapshot backfilled, so the next check has a real baseline.
    expect((await store.getSource('repo/verify-me'))?.commitSha).toBe('v1')
  })

})
