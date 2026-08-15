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

  // ------------------------------------------------------- 来源记录
  it('upserts source skills, merges manifests, and persists them', async () => {
    await store.addSourceSkill('anthropics/skills', 'skills', 'sha-1', undefined, 'docx')
    await store.addSourceSkill('anthropics/skills', 'skills', 'sha-1', undefined, 'pdf')
    await store.mergeSourceManifest('anthropics/skills', { 'skills/docx/SKILL.md': 120 })
    const sources = await store.listSources()
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ repo: 'anthropics/skills', root: 'skills', commitSha: 'sha-1', skills: ['docx', 'pdf'] })
    expect(sources[0].manifest).toEqual({ 'skills/docx/SKILL.md': 120 })
    // 持久化后完整读回
    const reloaded = new SkillHubStore(file)
    const again = await reloaded.listSources()
    expect(again).toHaveLength(1)
    expect(again[0].skills).toEqual(['docx', 'pdf'])
    expect(again[0].manifest).toEqual({ 'skills/docx/SKILL.md': 120 })
  })

  it('derives origins from sources and drops empty sources', async () => {
    await store.addSourceSkill('repo/a', 'skills', '', undefined, 'one')
    await store.addSourceSkill('repo/a', 'skills', '', undefined, 'two')
    expect(await store.listOrigins()).toEqual({ one: 'repo/a', two: 'repo/a' })
    await store.setSourceSkills('repo/a', ['two'])
    expect(await store.listOrigins()).toEqual({ two: 'repo/a' })
    await store.setSourceSkills('repo/a', [])
    expect(await store.listSources()).toEqual([])
    expect(await store.listOrigins()).toEqual({})
  })

  it('updates the commit snapshot', async () => {
    await store.addSourceSkill('repo/a', 'skills', 'old', undefined, 'one')
    await store.setSourceCommit('repo/a', 'new')
    expect((await store.getSource('repo/a'))?.commitSha).toBe('new')
  })

  // ------------------------------------------------------ 市场源
  it('adds, deduplicates, removes, and persists market sources', async () => {
    await store.addMarketSource('anthropics/skills')
    await store.addMarketSource('anthropics/skills')
    await store.addMarketSource('other/repo')
    expect(await store.listMarketSources()).toEqual(['anthropics/skills', 'other/repo'])
    await store.removeMarketSource('anthropics/skills')
    expect(await store.listMarketSources()).toEqual(['other/repo'])
    const reloaded = new SkillHubStore(file)
    expect(await reloaded.listMarketSources()).toEqual(['other/repo'])
  })

  // ------------------------------------------------------- 回收站
  it('records, lists, and clears trash entries', async () => {
    await store.addTrash({ name: 'gone-skill', path: '/tmp/.trash/gone-skill-123', movedAt: 42 })
    await store.addTrash({ name: 'older', path: '/tmp/.trash/older-1', movedAt: 10 })
    const trash = await store.listTrash()
    expect(trash.map((entry) => entry.name)).toEqual(['gone-skill', 'older']) // newest first
    await store.removeTrash('gone-skill')
    const reloaded = new SkillHubStore(file)
    expect(await reloaded.listTrash()).toHaveLength(1)
    expect(await reloaded.getTrash('older')).toMatchObject({ name: 'older' })
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

  // ---------------------------------------------------- schema 迁移
  it('migrates a legacy v1 file: origins become sources, scenes are dropped', async () => {
    await writeFile(file, JSON.stringify({
      version: 1,
      disabled: [{ name: 'a', path: '/tmp/a.md.disabled', root: 'user-dsh', disabledAt: 1 }],
      origins: { docx: 'anthropics/skills', pdf: 'anthropics/skills' },
      scenes: [{ id: 's1', name: '场景', skillNames: ['docx'] }],
    }), 'utf8')
    expect(await store.listDisabled()).toHaveLength(1)
    const sources = await store.listSources()
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ repo: 'anthropics/skills', commitSha: '', skills: ['docx', 'pdf'] })
    expect(await store.listOrigins()).toEqual({ docx: 'anthropics/skills', pdf: 'anthropics/skills' })
    // scenes 被丢弃：迁移后首次写入持久化时不再保留
    await store.addMarketSource('new/repo')
    const raw = JSON.parse(await readFile(file, 'utf8')) as { scenes?: unknown[]; marketSources?: unknown[] }
    expect(raw.scenes).toBeUndefined()
    expect(raw.marketSources).toEqual(['new/repo'])
  })

  it('rejects a newer schema by starting empty', async () => {
    await writeFile(file, JSON.stringify({ version: 99, disabled: [{ name: 'a', path: '/tmp/a.md.disabled', root: 'user-dsh', disabledAt: 1 }] }), 'utf8')
    const fresh = new SkillHubStore(file)
    expect(await fresh.listDisabled()).toEqual([])
  })

})
