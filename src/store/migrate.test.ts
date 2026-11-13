/**
 * sidecar 迁移与 hydration 的错误注入测试。
 *
 * 这个文件锁的是**信任边界的容忍度**：sidecar 是用户可手改、可被别的版本写坏
 * 的 JSON，装载时必须做到「坏条目丢弃、好条目保留、整份文件坏了就拒绝写入」。
 * 任何把逐字段校验换成别的实现（例如 schema 库）的改动，都必须先在这里证明
 * 行为等价 —— 容忍度一旦收紧，用户的历史记录会在下次启动时静默消失。
 */
import { describe, expect, it } from 'vitest'
import { hydrateMigratedState, migrateStore, type MigratedStore } from './migrate.ts'
import { STORE_VERSION } from './paths.ts'

function doc(overrides: Partial<MigratedStore> = {}): MigratedStore {
  return { version: STORE_VERSION, disabled: [], ...overrides }
}

describe('hydrateMigratedState — disabled 台账', () => {
  it('drops entries missing name or path and keeps the good ones', () => {
    const state = hydrateMigratedState(doc({
      disabled: [
        { name: 'good', description: 'd', path: '/p/good.md.disabled', root: 'user-dsh', disabledAt: 1 },
        { name: 'no-path' },
        { path: '/p/nameless' },
        null,
        'string',
        42,
        [],
      ],
    }))
    expect([...state.entries.keys()]).toEqual(['good'])
  })
})

describe('hydrateMigratedState — config', () => {
  it('keeps only fields whose primitive type matches and drops empty strings and non-finite numbers', () => {
    const state = hydrateMigratedState(doc({
      config: {
        enabled: true,
        announceToAgent: false,
        dotModelColor: '#abcdef',
        statsWindowDays: 7,
        statsScanMinutes: 3,
        githubToken: 'ghp_x',
        // 坏的
        editMode: 'yes',
        dotUserColor: 123,
        showUseCount: 'true',
        showUseTime: null,
        showGroupSummary: '',
        unknownField: 'dropped',
      },
    }))
    expect(state.config).toEqual({
      enabled: true,
      announceToAgent: false,
      dotModelColor: '#abcdef',
      statsWindowDays: 7,
      statsScanMinutes: 3,
      githubToken: 'ghp_x',
    })
  })

  it('drops empty strings for string fields and non-finite numbers for number fields', () => {
    const state = hydrateMigratedState(doc({
      config: { githubToken: '', dotModelColor: '', statsWindowDays: Number.NaN, statsScanMinutes: Number.POSITIVE_INFINITY },
    }))
    expect(state.config).toEqual({})
  })

  it('treats a non-object config as absent', () => {
    for (const config of [null, 42, 'x', []]) {
      expect(hydrateMigratedState(doc({ config })).config).toEqual({})
    }
  })
})

describe('hydrateMigratedState — tags', () => {
  it('drops tags missing id/name/skillNames and filters non-string members', () => {
    const state = hydrateMigratedState(doc({
      tags: [
        { id: 't1', name: 'role', skillNames: ['a', 1, null, 'b'] },
        { id: 't2', name: 'no-members' },
        { name: 'no-id', skillNames: [] },
        { id: 't3', skillNames: [] },
        { id: 't4', name: 'bad-members', skillNames: 'a' },
        null,
      ],
    }))
    expect([...state.tagsById.values()]).toEqual([{ id: 't1', name: 'role', skillNames: ['a', 'b'] }])
  })

  it('only honours default: true (a truthy impostor must not become the default role)', () => {
    const state = hydrateMigratedState(doc({
      tags: [
        { id: 't1', name: 'a', skillNames: [], default: 'yes' },
        { id: 't2', name: 'b', skillNames: [], default: 1 },
        { id: 't3', name: 'c', skillNames: [], default: true },
      ],
    }))
    expect(state.tagsById.get('t1')?.default).toBeUndefined()
    expect(state.tagsById.get('t2')?.default).toBeUndefined()
    expect(state.tagsById.get('t3')?.default).toBe(true)
  })
})

describe('hydrateMigratedState — sources', () => {
  it('drops records without a non-empty repo or a skills array', () => {
    const state = hydrateMigratedState(doc({
      sources: [
        { repo: 'owner/ok', root: 'skills', commitSha: '', skills: ['a'] },
        { repo: '', root: 'skills', commitSha: '', skills: [] },
        { repo: 'owner/no-skills', root: 'skills', commitSha: '' },
        { repo: 'owner/bad-skills', root: 'skills', commitSha: '', skills: 'a' },
        null,
      ],
    }))
    expect([...state.sourcesByRepo.keys()]).toEqual(['owner/ok'])
  })

  it('falls back to root "skills" for an invalid root and keeps an empty root (repo-root skill)', () => {
    const state = hydrateMigratedState(doc({
      sources: [
        { repo: 'a/bad-root', root: '../escape', commitSha: '', skills: [] },
        { repo: 'a/nested-root', root: 'skills/nested', commitSha: '', skills: [] },
        { repo: 'a/empty-root', root: '', commitSha: '', skills: [] },
        { repo: 'a/good-root', root: 'my-skills', commitSha: '', skills: [] },
      ],
    }))
    // root 只允许单层可见目录名；空串是「技能在仓库根」的合法哨兵，不能被改写。
    expect(state.sourcesByRepo.get('a/bad-root')?.root).toBe('skills')
    expect(state.sourcesByRepo.get('a/nested-root')?.root).toBe('skills')
    expect(state.sourcesByRepo.get('a/empty-root')?.root).toBe('')
    expect(state.sourcesByRepo.get('a/good-root')?.root).toBe('my-skills')
  })

  it('keeps only numeric manifest sizes and non-empty string hashes', () => {
    const state = hydrateMigratedState(doc({
      sources: [{
        repo: 'a/b',
        root: 'skills',
        commitSha: 'abc',
        skills: ['x'],
        manifest: { 'x/SKILL.md': 120, 'x/bad.md': 'many', 'x/nan.md': Number.NaN },
        localHashes: { x: 'sha1', y: '', z: 42 },
      }],
    }))
    expect(state.sourcesByRepo.get('a/b')?.manifest).toEqual({ 'x/SKILL.md': 120, 'x/nan.md': Number.NaN })
    expect(state.sourcesByRepo.get('a/b')?.localHashes).toEqual({ x: 'sha1' })
  })

  it('omits empty ref and defaults commitSha to an empty string', () => {
    const state = hydrateMigratedState(doc({
      sources: [{ repo: 'a/b', ref: '', root: 'skills', skills: [] }],
    }))
    expect(state.sourcesByRepo.get('a/b')).toEqual({ repo: 'a/b', root: 'skills', commitSha: '', skills: [] })
  })
})

describe('hydrateMigratedState — marketSources', () => {
  it('deduplicates by repo, drops blank repos, and omits empty ref/commitSha', () => {
    const state = hydrateMigratedState(doc({
      marketSources: [
        { repo: 'a/b', ref: 'v1', commitSha: 'sha' },
        { repo: 'a/b', ref: 'v2', commitSha: 'other' },
        { repo: '', ref: 'v1' },
        { repo: 'c/d', ref: '', commitSha: '' },
        null,
        'bare-slug',
      ],
    }))
    expect(state.marketSources).toEqual([
      { repo: 'a/b', ref: 'v1', commitSha: 'sha' },
      { repo: 'c/d' },
    ])
  })
})

describe('hydrateMigratedState — trash', () => {
  it('drops entries missing name or path and defaults a non-number movedAt to 0', () => {
    const state = hydrateMigratedState(doc({
      trash: [
        { name: 'good', path: '/trash/good', movedAt: 5 },
        { name: 'no-path', movedAt: 5 },
        { path: '/trash/nameless', movedAt: 5 },
        { name: 'bad-time', path: '/trash/bad-time', movedAt: 'yesterday' },
        null,
      ],
    }))
    expect([...state.trashByPath.keys()]).toEqual(['/trash/good', '/trash/bad-time'])
    expect(state.trashByPath.get('/trash/bad-time')?.movedAt).toBe(0)
  })

  it('keeps several entries sharing one skill name (keyed by path)', () => {
    const state = hydrateMigratedState(doc({
      trash: [
        { name: 'dup', path: '/trash/a', movedAt: 1 },
        { name: 'dup', path: '/trash/b', movedAt: 2 },
      ],
    }))
    expect(state.trashByPath.size).toBe(2)
  })

  it('keeps origin only when repo is non-empty and root is valid', () => {
    const state = hydrateMigratedState(doc({
      trash: [
        { name: 'a', path: '/t/a', movedAt: 1, origin: { repo: 'owner/repo', root: 'skills', commitSha: 'sha' } },
        { name: 'b', path: '/t/b', movedAt: 1, origin: { repo: '', root: 'skills', commitSha: 'sha' } },
        { name: 'c', path: '/t/c', movedAt: 1, origin: { repo: 'owner/repo', root: '../escape', commitSha: 'sha' } },
        { name: 'd', path: '/t/d', movedAt: 1, origin: { repo: 'owner/repo', root: 'skills' } },
      ],
    }))
    expect(state.trashByPath.get('/t/a')?.origin).toEqual({ repo: 'owner/repo', root: 'skills', commitSha: 'sha' })
    expect(state.trashByPath.get('/t/b')?.origin).toBeUndefined()
    expect(state.trashByPath.get('/t/c')?.origin).toBeUndefined()
    // commitSha 缺失回退空串，而不是整个 origin 丢掉。
    expect(state.trashByPath.get('/t/d')?.origin).toEqual({ repo: 'owner/repo', root: 'skills', commitSha: '' })
  })

  it('filters non-string tagIds', () => {
    const state = hydrateMigratedState(doc({
      trash: [{ name: 'a', path: '/t/a', movedAt: 1, tagIds: ['t1', 2, null, 't2'] }],
    }))
    expect(state.trashByPath.get('/t/a')?.tagIds).toEqual(['t1', 't2'])
  })
})

describe('hydrateMigratedState — skillStats', () => {
  it('drops the whole checkpoint when a required scalar is missing', () => {
    for (const skillStats of [
      null,
      {},
      { windowDays: 7, frozenBefore: 1, frozenSessions: {} },
      { windowDays: 7, frozenBefore: 1, lastFullReconcile: 2 },
      { windowDays: 'x', frozenBefore: 1, frozenSessions: {}, lastFullReconcile: 2 },
      { windowDays: 7, frozenBefore: 1, frozenSessions: null, lastFullReconcile: 2 },
    ]) {
      expect(hydrateMigratedState(doc({ skillStats })).skillStats).toBeUndefined()
    }
  })

  it('keeps a session whose createdAt is fine but drops its corrupt count entries', () => {
    const state = hydrateMigratedState(doc({
      skillStats: {
        windowDays: 14,
        frozenBefore: 100,
        lastFullReconcile: 200,
        frozenSessions: {
          good: { createdAt: 1, counts: { tdd: { count: 2, lastUsed: 5 } } },
          'bad-counts': { createdAt: 1, counts: { tdd: { count: 'many', lastUsed: 5 } } },
          'no-createdAt': { counts: {} },
          notObject: 'x',
        },
      },
    }))
    // 粒度是「桶内条目」：session 本身结构合法就保留，只清掉算不成数字的计数。
    expect(state.skillStats?.frozenSessions).toEqual({
      good: { createdAt: 1, counts: { tdd: { count: 2, lastUsed: 5 } } },
      'bad-counts': { createdAt: 1, counts: {} },
    })
  })

  it('drops corrupt lastTotals entries and keeps valid ones', () => {
    const state = hydrateMigratedState(doc({
      skillStats: {
        windowDays: 14,
        frozenBefore: 1,
        lastFullReconcile: 2,
        frozenSessions: {},
        lastTotals: [
          { name: 'a', count: 3, lastUsed: 9 },
          { name: 'b', count: 1 },
          { count: 5 },
          { name: 'c', count: 'many' },
          null,
        ],
      },
    }))
    expect(state.skillStats?.lastTotals).toEqual([{ name: 'a', count: 3, lastUsed: 9 }, { name: 'b', count: 1 }])
  })

  it('drops corrupt coldRevisions entries instead of trusting bad counts', () => {
    const state = hydrateMigratedState(doc({
      skillStats: {
        windowDays: 14,
        frozenBefore: 1,
        lastFullReconcile: 2,
        frozenSessions: {},
        coldRevisions: {
          good: { rev: 'r1', createdAt: 9, counts: { tdd: { count: 1, lastUsed: 2 } } },
          'bad-rev': { rev: 42, createdAt: 9, counts: {} },
          'bad-counts': { rev: 'r1', createdAt: 9, counts: { tdd: { count: 'many', lastUsed: 1 } } },
        },
      },
    }))
    expect(state.skillStats?.coldRevisions).toEqual({
      good: { rev: 'r1', createdAt: 9, counts: { tdd: { count: 1, lastUsed: 2 } } },
      'bad-counts': { rev: 'r1', createdAt: 9, counts: {} },
    })
  })
})

describe('hydrateMigratedState — marketStats', () => {
  it('drops the snapshot when fetchedAt or stats is missing, and drops corrupt buckets', () => {
    expect(hydrateMigratedState(doc({ marketStats: { stats: {} } })).marketStats).toBeUndefined()
    expect(hydrateMigratedState(doc({ marketStats: { fetchedAt: 1 } })).marketStats).toBeUndefined()
    expect(hydrateMigratedState(doc({ marketStats: null })).marketStats).toBeUndefined()
    const state = hydrateMigratedState(doc({
      marketStats: { fetchedAt: 9, stats: { 'a/b': { stars: 1, downloads: 2 }, 'c/d': { stars: 'many', downloads: 0 } } },
    }))
    expect(state.marketStats).toEqual({ fetchedAt: 9, stats: { 'a/b': { stars: 1, downloads: 2 } } })
  })
})

describe('hydrateMigratedState — 数组字段', () => {
  it('treats non-array buckets as empty and strips blank strings from order lists', () => {
    const state = hydrateMigratedState(doc({
      collectionOrder: ['col:b', '', 3, 'col:a'],
      sourceGroupOrder: 'project',
      invocationOverrides: ['/p/a/SKILL.md', '', null, '/p/b/SKILL.md'],
      tags: {},
      sources: 'x',
      marketSources: 42,
      trash: null,
    }))
    expect(state.collectionOrder).toEqual(['col:b', 'col:a'])
    expect(state.sourceGroupOrder).toEqual([])
    expect(state.invocationOverrides).toEqual(['/p/a/SKILL.md', '/p/b/SKILL.md'])
    expect(state.tagsById.size).toBe(0)
    expect(state.sourcesByRepo.size).toBe(0)
    expect(state.marketSources).toEqual([])
    expect(state.trashByPath.size).toBe(0)
  })
})

describe('migrateStore', () => {
  it('refuses a newer schema so the loader can back the file up instead of overwriting it', () => {
    expect(migrateStore({ version: STORE_VERSION + 1, disabled: [] })).toBeNull()
    expect(migrateStore({ version: STORE_VERSION, disabled: [] })).not.toBeNull()
  })

  it('rejects non-object documents', () => {
    for (const parsed of [null, undefined, 42, 'x', [], true]) {
      expect(migrateStore(parsed)).toBeNull()
    }
  })

  it('treats a missing version as 0 and still accepts the document', () => {
    const migrated = migrateStore({ disabled: [] })
    expect(migrated?.version).toBe(STORE_VERSION)
    expect(migrated?.disabled).toEqual([])
  })

  it('migrates v1 origins into source records (repo = origin, empty commit snapshot)', () => {
    const migrated = migrateStore({
      version: 1,
      disabled: [],
      // 顺序按 origins 的键顺序（b 在前），且空值/非字符串被跳过。
      origins: {
        b: 'owner/two',
        a: 'owner/one',
        blank: '',
        bad: 42,
      },
    })
    expect(migrated?.sources).toEqual([
      { repo: 'owner/two', root: 'skills', commitSha: '', skills: ['b'] },
      { repo: 'owner/one', root: 'skills', commitSha: '', skills: ['a'] },
    ])
  })

  it('migrates v2 bare market-source slugs into records and leaves records alone', () => {
    const migrated = migrateStore({
      version: 2,
      disabled: [],
      marketSources: ['owner/legacy', { repo: 'owner/record', ref: 'v1' }],
    })
    expect(migrated?.marketSources).toEqual([{ repo: 'owner/legacy' }, { repo: 'owner/record', ref: 'v1' }])
  })

  it('prefers sources over origins once the file has both', () => {
    const migrated = migrateStore({
      version: 1,
      disabled: [],
      origins: { a: 'from/origins' },
      sources: [{ repo: 'from/sources', root: 'skills', commitSha: '', skills: ['a'] }],
    })
    expect(migrated?.sources).toEqual([{ repo: 'from/sources', root: 'skills', commitSha: '', skills: ['a'] }])
  })

  it('drops non-array buckets instead of passing garbage through', () => {
    const migrated = migrateStore({
      version: STORE_VERSION,
      disabled: 'nope',
      tags: {},
      trash: 3,
      collectionOrder: 'x',
      sourceGroupOrder: {},
      invocationOverrides: null,
    })
    expect(migrated).toMatchObject({ disabled: [] })
    expect(migrated?.tags).toBeUndefined()
    expect(migrated?.trash).toBeUndefined()
    expect(migrated?.collectionOrder).toBeUndefined()
    expect(migrated?.sourceGroupOrder).toBeUndefined()
    expect(migrated?.invocationOverrides).toBeUndefined()
  })
})
