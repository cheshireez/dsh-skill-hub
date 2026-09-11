import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconcileDisabledSkills } from './reconcile.ts'
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
})
