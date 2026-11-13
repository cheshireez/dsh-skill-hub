import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateRenamedDisabledSkills, pruneStaleDisabledSkills, pruneStaleTrash, reconcileDisabledSkills } from './reconcile.ts'
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

describe('migrateRenamedDisabledSkills', () => {
  let dir: string
  let home: string
  let agentsHome: string
  let previousAgentsHome: string | undefined
  let store: SkillHubStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hub-migrate-'))
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

  it('renames a legacy .disabled file back and moves the state into an override', async () => {
    const skillDir = join(home, 'skills', 'legacy')
    await mkdir(skillDir, { recursive: true })
    const disabledPath = join(skillDir, 'SKILL.md.disabled')
    await writeFile(disabledPath, '---\nname: legacy\ndescription: Legacy paused\n---\n\nBody', 'utf8')
    await store.addDisabled({ name: 'legacy', description: 'Legacy paused', path: disabledPath, root: 'user-dsh', disabledAt: 1 })

    const migrated = await migrateRenamedDisabledSkills(store, home)
    const enabledPath = join(skillDir, 'SKILL.md')
    expect(migrated).toEqual([enabledPath])
    await expect(access(enabledPath)).resolves.toBeUndefined()
    await expect(access(disabledPath)).rejects.toThrow()
    await expect(readFile(enabledPath, 'utf8')).resolves.toContain('name: legacy')
    expect(await store.listInvocationOverrides()).toContain(enabledPath)
    expect((await store.getDisabled('legacy'))?.path).toBe(enabledPath)
    // 幂等：迁移后磁盘上不再有 .disabled，第二次什么都不做。
    expect(await migrateRenamedDisabledSkills(store, home)).toEqual([])
  })

  it('adopts an orphan .disabled file with no sidecar record', async () => {
    const skillDir = join(home, 'skills', 'orphan')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md.disabled'), '---\nname: orphan\ndescription: Orphan paused\n---\n\nBody', 'utf8')

    await migrateRenamedDisabledSkills(store, home)
    const enabledPath = join(skillDir, 'SKILL.md')
    expect((await store.getDisabled('orphan'))?.path).toBe(enabledPath)
    expect(await store.listInvocationOverrides()).toContain(enabledPath)
  })
})

describe('pruneStaleTrash', () => {
  let dir: string
  let home: string
  let store: SkillHubStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hub-trash-'))
    home = join(dir, 'home')
    await mkdir(join(home, 'skills', '.trash'), { recursive: true })
    store = new SkillHubStore(statePath(home))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('removes records whose entry is gone and keeps the ones still on disk', async () => {
    const liveDir = join(home, 'skills', '.trash', 'live-1')
    await mkdir(liveDir, { recursive: true })
    await writeFile(join(liveDir, 'SKILL.md'), '---\nname: live\ndescription: x\n---', 'utf8')
    // 扁平文件形态的回收站条目也算存在。
    const flat = join(home, 'skills', '.trash', 'flat-1.md')
    await writeFile(flat, '---\nname: flat\ndescription: x\n---', 'utf8')

    await store.addTrash({ name: 'live', path: liveDir, movedAt: 3 })
    await store.addTrash({ name: 'flat', path: flat, movedAt: 2 })
    await store.addTrash({ name: 'gone', path: join(home, 'skills', '.trash', 'gone-1'), movedAt: 1 })

    const removed = await pruneStaleTrash(store)
    expect(removed.map((entry) => entry.name)).toEqual(['gone'])
    expect((await store.listTrash()).map((entry) => entry.name).sort()).toEqual(['flat', 'live'])
    // 落盘：重开 store 也不会再出现那条死记录。
    expect((await new SkillHubStore(statePath(home)).listTrash()).map((entry) => entry.name).sort()).toEqual(['flat', 'live'])
  })

  it('leaves records whose path is not inside a .trash directory alone', async () => {
    const foreign = join(home, 'skills', 'not-trash', 'weird-1')
    await store.addTrash({ name: 'weird', path: foreign, movedAt: 1 })

    const removed = await pruneStaleTrash(store)
    // 路径形态不认识就不动 —— 判据错就是删用户的记录。
    expect(removed).toEqual([])
    expect(await store.listTrash()).toHaveLength(1)
  })

  it('keeps a record when the parent exists but the entry is unreadable for reasons other than absence', async () => {
    // 用一个内容不是目录的路径模拟「存在但 stat 失败之外的场景」：这里只断言
    // 存在的文件不会被删（EACCES 之类的保护靠代码里只认 ENOENT/ENOTDIR）。
    const file = join(home, 'skills', '.trash', 'file-1')
    await writeFile(file, 'x', 'utf8')
    await store.addTrash({ name: 'file', path: file, movedAt: 1 })

    expect(await pruneStaleTrash(store)).toEqual([])
    expect(await store.listTrash()).toHaveLength(1)
  })
})
