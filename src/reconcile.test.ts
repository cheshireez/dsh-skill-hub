import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pruneStaleDisabledSkills, reconcileDisabledSkills } from './reconcile.ts'
import { SkillHubStore, statePath } from './store.ts'

describe('reconcileDisabledSkills', () => {
  let dir: string
  let home: string
  let agentsHome: string
  let previousAgentsHome: string | undefined
  let store: SkillHubStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hub-reconcile-'))
    home = join(dir, 'home')
    agentsHome = join(dir, 'agents')
    await mkdir(join(home, 'skills'), { recursive: true })
    await mkdir(join(agentsHome, 'skills'), { recursive: true })
    previousAgentsHome = process.env.DSH_AGENTS_HOME
    process.env.DSH_AGENTS_HOME = agentsHome
    store = new SkillHubStore(statePath(home))
  })

  afterEach(async () => {
    if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgentsHome
    await rm(dir, { recursive: true, force: true })
  })

  it('rebuilds a missing record for a disabled directory bundle', async () => {
    await mkdir(join(home, 'skills', 'paused-skill'))
    await writeFile(
      join(home, 'skills', 'paused-skill', 'SKILL.md.disabled'),
      '---\nname: paused-skill\ndescription: Paused bundle\n---\n\nBody',
      'utf8',
    )
    const added = await reconcileDisabledSkills(store, home)
    expect(added).toHaveLength(1)
    expect(await store.getDisabled('paused-skill')).toMatchObject({
      name: 'paused-skill',
      description: 'Paused bundle',
      path: join(home, 'skills', 'paused-skill', 'SKILL.md.disabled'),
      root: 'user-dsh',
    })
  })

  it('rebuilds records for flat files in both user roots', async () => {
    await writeFile(join(home, 'skills', 'flat-skill.md.disabled'), '---\nname: flat-skill\ndescription: Flat one\n---', 'utf8')
    await writeFile(join(agentsHome, 'skills', 'agent-skill.md.disabled'), '---\nname: agent-skill\ndescription: Agent one\n---', 'utf8')
    const added = await reconcileDisabledSkills(store, home)
    expect(added.map((entry) => entry.name).sort()).toEqual(['agent-skill', 'flat-skill'])
    expect((await store.getDisabled('agent-skill'))?.root).toBe('user-agents')
    expect((await store.getDisabled('flat-skill'))?.root).toBe('user-dsh')
  })

  it('keeps existing records untouched and skips invalid disabled files', async () => {
    const recordPath = join(home, 'skills', 'known-skill', 'SKILL.md.disabled')
    await mkdir(join(home, 'skills', 'known-skill'))
    await writeFile(recordPath, '---\nname: known-skill\ndescription: Fresh text\n---', 'utf8')
    await store.addDisabled({ name: 'known-skill', description: 'Original', path: recordPath, root: 'user-dsh', disabledAt: 1 })
    await writeFile(join(home, 'skills', 'broken.md.disabled'), '# no frontmatter', 'utf8')

    expect(await reconcileDisabledSkills(store, home)).toEqual([])
    expect((await store.getDisabled('known-skill'))?.description).toBe('Original')
    expect(await store.getDisabled('broken')).toBeUndefined()
  })

  it('is idempotent across runs', async () => {
    await writeFile(join(home, 'skills', 'flat-skill.md.disabled'), '---\nname: flat-skill\ndescription: Flat one\n---', 'utf8')
    expect(await reconcileDisabledSkills(store, home)).toHaveLength(1)
    expect(await reconcileDisabledSkills(store, home)).toEqual([])
    expect(await store.listDisabled()).toHaveLength(1)
  })

  it('reconciles a root-level SKILL.md.disabled (a flat skill literally named SKILL)', async () => {
    // scanRoot 会把根级 SKILL.md 文件当一个扁平技能，它的禁用对应物就不能被漏掉。
    await writeFile(join(home, 'skills', 'SKILL.md.disabled'), '---\nname: root-flat\ndescription: Root flat\n---', 'utf8')
    const added = await reconcileDisabledSkills(store, home)
    expect(added.map((entry) => entry.name)).toEqual(['root-flat'])
    expect((await store.getDisabled('root-flat'))?.path).toBe(join(home, 'skills', 'SKILL.md.disabled'))
  })
})

describe('pruneStaleDisabledSkills', () => {
  let dir: string
  let home: string
  let agentsHome: string
  let previousAgentsHome: string | undefined
  let store: SkillHubStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hub-prune-'))
    home = join(dir, 'home')
    agentsHome = join(dir, 'agents')
    await mkdir(join(home, 'skills'), { recursive: true })
    await mkdir(join(agentsHome, 'skills'), { recursive: true })
    previousAgentsHome = process.env.DSH_AGENTS_HOME
    process.env.DSH_AGENTS_HOME = agentsHome
    store = new SkillHubStore(statePath(home))
  })

  afterEach(async () => {
    if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgentsHome
    await rm(dir, { recursive: true, force: true })
  })

  it('drops a record whose file is gone and frees the name', async () => {
    await store.addDisabled({ name: 'ghost', description: 'x', path: join(home, 'skills', 'ghost', 'SKILL.md.disabled'), root: 'user-dsh', disabledAt: 1 })
    const result = await pruneStaleDisabledSkills(store, home)
    expect(result).toEqual({ repaired: [], removed: ['ghost'] })
    expect(await store.listDisabled()).toEqual([])
  })

  it('repoints a record to the surviving flat placeholder instead of dropping it', async () => {
    // 记录指目录形态，磁盘上只剩扁平形态（导入让位过一次的典型残留）。
    await writeFile(join(home, 'skills', 'code-review.md.disabled'), '---\nname: code-review\ndescription: stub\n---', 'utf8')
    await store.addDisabled({ name: 'code-review', description: 'stub', path: join(home, 'skills', 'code-review', 'SKILL.md.disabled'), root: 'user-dsh', disabledAt: 1 })
    const result = await pruneStaleDisabledSkills(store, home)
    expect(result.removed).toEqual([])
    expect(result.repaired.map((entry) => entry.path)).toEqual([join(home, 'skills', 'code-review.md.disabled')])
    expect((await store.getDisabled('code-review'))?.path).toBe(join(home, 'skills', 'code-review.md.disabled'))
  })

  it('repoints to the bundle placeholder when that is the surviving form', async () => {
    await mkdir(join(home, 'skills', 'paused'))
    await writeFile(join(home, 'skills', 'paused', 'SKILL.md.disabled'), '---\nname: paused\ndescription: b\n---', 'utf8')
    await store.addDisabled({ name: 'paused', description: 'b', path: join(home, 'skills', 'paused.md.disabled'), root: 'user-dsh', disabledAt: 1 })
    const result = await pruneStaleDisabledSkills(store, home)
    expect(result.repaired.map((entry) => entry.path)).toEqual([join(home, 'skills', 'paused', 'SKILL.md.disabled')])
  })

  it('leaves records whose file still exists alone, and is idempotent', async () => {
    await writeFile(join(home, 'skills', 'alive.md.disabled'), '---\nname: alive\ndescription: x\n---', 'utf8')
    await store.addDisabled({ name: 'alive', description: 'x', path: join(home, 'skills', 'alive.md.disabled'), root: 'user-dsh', disabledAt: 1 })
    expect(await pruneStaleDisabledSkills(store, home)).toEqual({ repaired: [], removed: [] })
    expect(await pruneStaleDisabledSkills(store, home)).toEqual({ repaired: [], removed: [] })
    expect(await store.listDisabled()).toHaveLength(1)
  })

  it('prunes records from the other writable root too', async () => {
    await store.addDisabled({ name: 'agent-ghost', description: 'x', path: join(agentsHome, 'skills', 'agent-ghost', 'SKILL.md.disabled'), root: 'user-agents', disabledAt: 1 })
    await writeFile(join(agentsHome, 'skills', 'agent-ghost.md.disabled'), '---\nname: agent-ghost\ndescription: x\n---', 'utf8')
    const result = await pruneStaleDisabledSkills(store, home)
    expect(result.repaired.map((entry) => entry.path)).toEqual([join(agentsHome, 'skills', 'agent-ghost.md.disabled')])
  })
})
