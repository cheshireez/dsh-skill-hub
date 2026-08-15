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

  // ------------------------------------------------------- tag 分组
  it('persists tag groups and reloads them', async () => {
    const tag = await store.saveTag({ name: 'web' })
    expect(tag.id).toBeTruthy()
    expect(tag.skillNames).toEqual([])
    await store.setTagMembers(tag.id, ['a', 'b', 'b', ''])
    const reloaded = new SkillHubStore(file)
    const tags = await reloaded.listTags()
    expect(tags).toHaveLength(1)
    expect(tags[0]).toMatchObject({ id: tag.id, name: 'web' })
    // 成员去重 + 去空
    expect(tags[0].skillNames).toEqual(['a', 'b'])
  })

  it('renames a tag keeping its members', async () => {
    const tag = await store.saveTag({ name: 'old' })
    await store.setTagMembers(tag.id, ['x'])
    const renamed = await store.saveTag({ id: tag.id, name: 'new' })
    expect(renamed.name).toBe('new')
    expect(renamed.skillNames).toEqual(['x'])
  })

  it('deletes a tag and rejects empty names', async () => {
    const tag = await store.saveTag({ name: 'tmp' })
    await store.deleteTag(tag.id)
    expect(await store.listTags()).toEqual([])
    await expect(store.saveTag({ name: '  ' })).rejects.toThrow()
  })

  // ------------------------------------------------------ origin 归属
  it('records, reloads, and clears origins', async () => {
    await store.setOrigin('docx', 'anthropics/skills')
    await store.setOrigin('pdf', 'anthropics/skills')
    expect(await store.getOrigin('docx')).toBe('anthropics/skills')
    expect(await store.listOrigins()).toEqual({ docx: 'anthropics/skills', pdf: 'anthropics/skills' })
    await store.setOrigin('docx', null)
    expect(await store.getOrigin('docx')).toBeUndefined()
    const reloaded = new SkillHubStore(file)
    expect(await reloaded.listOrigins()).toEqual({ pdf: 'anthropics/skills' })
  })

  // ------------------------------------------------------- 显示配置
  it('persists display toggles in config', async () => {
    await store.setConfig({ showUseCount: false, showGroupSummary: false })
    const reloaded = new SkillHubStore(file)
    const cfg = await reloaded.getConfig()
    expect(cfg.showUseCount).toBe(false)
    expect(cfg.showGroupSummary).toBe(false)
    expect(cfg.showUseTime).toBeUndefined()
  })

  // ------------------------------------------------------- 场景
  it('persists scenes and reloads them', async () => {
    const scene = await store.saveScene({ name: '前端工作流' })
    expect(scene.id).toBeTruthy()
    expect(scene.skillNames).toEqual([])
    await store.setSceneMembers(scene.id, ['a', 'b', 'b', ''])
    const reloaded = new SkillHubStore(file)
    const scenes = await reloaded.listScenes()
    expect(scenes).toHaveLength(1)
    expect(scenes[0]).toMatchObject({ id: scene.id, name: '前端工作流' })
    expect(scenes[0].skillNames).toEqual(['a', 'b'])
  })

  it('renames and deletes scenes', async () => {
    const scene = await store.saveScene({ name: 'old' })
    const renamed = await store.saveScene({ id: scene.id, name: 'new' })
    expect(renamed.name).toBe('new')
    await store.deleteScene(scene.id)
    expect(await store.listScenes()).toEqual([])
    await expect(store.saveScene({ name: '  ' })).rejects.toThrow()
  })

  // ---------------------------------------------------- schema 迁移
  it('migrates a legacy file (no version) and rejects a newer schema', async () => {
    // 旧格式：无 version 字段，只有 disabled —— 规整后照常可读，新字段缺省为空。
    await writeFile(file, JSON.stringify({ disabled: [{ name: 'a', path: '/tmp/a.md.disabled', root: 'user-dsh', disabledAt: 1 }] }), 'utf8')
    expect(await store.listDisabled()).toHaveLength(1)
    expect(await store.listTags()).toEqual([])
    expect(await store.listOrigins()).toEqual({})
    // 更新 schema：未知版本 → 空启动，不丢数据地拒绝写入。
    await writeFile(file, JSON.stringify({ version: 99, disabled: [{ name: 'a', path: '/tmp/a.md.disabled', root: 'user-dsh', disabledAt: 1 }] }), 'utf8')
    const fresh = new SkillHubStore(file)
    expect(await fresh.listDisabled()).toEqual([])
  })

})

