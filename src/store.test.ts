import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillHubStore, statePath } from './store.ts'

describe('SkillHubStore', () => {
  let dir: string
  let file: string
  let store: SkillHubStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hub-store-'))
    file = statePath(dir)
    store = new SkillHubStore(file)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('starts empty when no state file exists', async () => {
    expect(await store.listDisabled()).toEqual([])
  })

  it('persists disabled entries and reloads them', async () => {
    await store.addDisabled({ name: 'demo-skill', description: 'demo', path: '/tmp/demo/SKILL.md.disabled', root: 'user-dsh', disabledAt: 1234 })
    const reloaded = new SkillHubStore(file)
    const entries = await reloaded.listDisabled()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: 'demo-skill', path: '/tmp/demo/SKILL.md.disabled', root: 'user-dsh', disabledAt: 1234 })
  })

  it('removes entries on removeDisabled', async () => {
    await store.addDisabled({ name: 'a', description: '', path: '/tmp/a.md.disabled', root: 'user-dsh', disabledAt: 1 })
    await store.removeDisabled('a')
    expect(await store.listDisabled()).toEqual([])
    expect(await new SkillHubStore(file).listDisabled()).toEqual([])
  })

  it('survives a corrupt state file', async () => {
    await writeFile(file, 'not json at all', 'utf8')
    expect(await store.listDisabled()).toEqual([])
    await store.addDisabled({ name: 'x', description: '', path: '/tmp/x.md.disabled', root: 'user-agents', disabledAt: 2 })
    const raw = JSON.parse(await readFile(file, 'utf8')) as { disabled: unknown[] }
    expect(raw.disabled).toHaveLength(1)
  })
})

