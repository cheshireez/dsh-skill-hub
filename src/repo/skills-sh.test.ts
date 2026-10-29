import { describe, expect, it, vi } from 'vitest'
import { downloadSkillsShSkill, searchSkillsSh, SkillsShError } from './skills-sh.ts'

/** 一个成功响应替身。 */
function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 把任意响应包成 `typeof fetch`。 */
function stub(response: Response | (() => Promise<Response>)): typeof fetch {
  return vi.fn(async () => (typeof response === 'function' ? await response() : response)) as unknown as typeof fetch
}

describe('searchSkillsSh — 正常结果', () => {
  it('maps the upstream shape onto validated entries', async () => {
    const skills = await searchSkillsSh('git', stub(ok({
      skills: [
        { id: 'mattpocock/skills/git-guardrails', source: 'mattpocock/skills', skillId: 'git-guardrails', name: 'git-guardrails', installs: 511295 },
        { source: 'obra/superpowers', skillId: 'using-git-worktrees', name: 'using-git-worktrees' },
      ],
    })))
    expect(skills).toHaveLength(2)
    expect(skills[0]).toEqual({ id: 'mattpocock/skills/git-guardrails', source: 'mattpocock/skills', skillId: 'git-guardrails', name: 'git-guardrails', installs: 511295 })
    // 缺 id 时按 source/skillId 合成；缺 installs 时字段整个省略。
    expect(skills[1]).toEqual({ id: 'obra/superpowers/using-git-worktrees', source: 'obra/superpowers', skillId: 'using-git-worktrees', name: 'using-git-worktrees' })
    expect('installs' in skills[1]!).toBe(false)
  })

  it('drops entries whose source is not a strict owner/repo', async () => {
    const skills = await searchSkillsSh('xx', stub(ok({
      skills: [
        { id: '1', source: '../etc', skillId: 'a', name: 'evil' },
        { id: '2', source: 'owner/repo/extra', skillId: 'a', name: 'three segments' },
        { id: '3', source: 'owner@evil.com/repo', skillId: 'a', name: 'at sign' },
        { id: '4', source: '/repo', skillId: 'a', name: 'empty owner' },
        { id: '5', source: 'owner/repo', skillId: '..', name: 'bad skill id' },
        { id: '6', source: 'owner/repo', skillId: 'ok', name: 'kept' },
      ],
    })))
    expect(skills.map((skill) => skill.name)).toEqual(['kept'])
  })

  it('dedupes by id and caps the result list', async () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ source: 'o/r', skillId: 's' + String(index), name: 'n' + String(index) }))
    const skills = await searchSkillsSh('xx', stub(ok({ skills: [{ ...many[0], id: 'same' }, { ...many[0], id: 'same' }, ...many] })))
    expect(skills.length).toBeLessThanOrEqual(50)
    expect(new Set(skills.map((skill) => skill.id)).size).toBe(skills.length)
  })

  it('ignores a nonsense installs value instead of rejecting the entry', async () => {
    const skills = await searchSkillsSh('xx', stub(ok({
      skills: [{ source: 'o/r', skillId: 's', name: 'n', installs: -3 }, { source: 'o/r', skillId: 't', name: 'm', installs: 1.5 }],
    })))
    expect(skills.map((skill) => skill.installs)).toEqual([undefined, undefined])
  })
})

describe('searchSkillsSh — 入参与上游失败', () => {
  it('rejects a query that is too short or too long without calling upstream', async () => {
    const fetchImpl = stub(ok({ skills: [] }))
    await expect(searchSkillsSh('a', fetchImpl)).rejects.toThrow(/at least 2/)
    await expect(searchSkillsSh('x'.repeat(101), fetchImpl)).rejects.toThrow(/at most 100/)
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('maps an unreachable upstream and a non-2xx answer to 502', async () => {
    await expect(searchSkillsSh('git', stub(() => Promise.reject(new Error('ECONNRESET'))))).rejects.toMatchObject({ status: 502 })
    await expect(searchSkillsSh('git', stub(new Response('nope', { status: 429 })))).rejects.toMatchObject({ status: 502 })
  })

  it('rejects invalid JSON and an unexpected payload shape', async () => {
    await expect(searchSkillsSh('git', stub(new Response('not json', { status: 200 })))).rejects.toBeInstanceOf(SkillsShError)
    await expect(searchSkillsSh('git', stub(ok({ results: [] })))).rejects.toThrow(/unexpected payload/)
  })

  it('rejects an oversized response instead of buffering it', async () => {
    const huge = 'x'.repeat((1 << 20) + 16)
    await expect(searchSkillsSh('git', stub(new Response(huge, { status: 200 })))).rejects.toThrow(/too large/)
  })
})

describe('downloadSkillsShSkill', () => {
  it('unpacks a package into path + bytes pairs', async () => {
    const pkg = await downloadSkillsShSkill('obra/superpowers', 'brainstorming', stub(ok({
      files: [
        { path: 'SKILL.md', contents: '---\nname: brainstorming\ndescription: d\n---\nbody' },
        { path: 'notes.md', contents: 'n' },
      ],
    })))
    expect(pkg.origin).toBe('obra/superpowers/brainstorming')
    expect(pkg.files.map((file) => file.path)).toEqual(['SKILL.md', 'notes.md'])
    expect(pkg.files[0]?.data.toString('utf8')).toContain('name: brainstorming')
  })

  it('rejects a bad source or skillId without calling upstream', async () => {
    const fetchImpl = stub(ok({ files: [] }))
    await expect(downloadSkillsShSkill('../etc', 'x', fetchImpl)).rejects.toMatchObject({ status: 400 })
    await expect(downloadSkillsShSkill('owner/repo/extra', 'x', fetchImpl)).rejects.toMatchObject({ status: 400 })
    await expect(downloadSkillsShSkill('owner/repo', '..', fetchImpl)).rejects.toMatchObject({ status: 400 })
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })

  it('rejects an unsafe package path and a package without SKILL.md', async () => {
    await expect(downloadSkillsShSkill('o/r', 's', stub(ok({ files: [{ path: '../evil.md', contents: 'x' }] }))))
      .rejects.toThrow(/unsafe path/)
    await expect(downloadSkillsShSkill('o/r', 's', stub(ok({ files: [{ path: 'readme.md', contents: 'x' }] }))))
      .rejects.toThrow(/no SKILL.md/)
    await expect(downloadSkillsShSkill('o/r', 's', stub(ok({ files: [] }))))
      .rejects.toThrow(/file count/)
  })

  it('accepts non-ASCII and spaced file names, still rejecting unsafe shapes', async () => {
    // 黑名单判据：中文、空格的路径是合法内容，只有绝对路径/盘符/`..`/NUL 才拒绝。
    // 之前用 ASCII 白名单，导致带中文文件名的技能整包 502。
    const pkg = await downloadSkillsShSkill('o/r', 's', stub(ok({
      files: [
        { path: 'SKILL.md', contents: 'x' },
        { path: '参考/说明.md', contents: '中文内容' },
        { path: 'my notes.md', contents: 'x' },
      ],
    })))
    expect(pkg.files.map((file) => file.path)).toEqual(['SKILL.md', '参考/说明.md', 'my notes.md'])
    await expect(downloadSkillsShSkill('o/r', 's', stub(ok({ files: [{ path: 'C:/x.md', contents: 'x' }] }))))
      .rejects.toThrow(/unsafe path/)
  })

  it('keeps a missing skill as 404 so the UI can move on, and folds the rest into 502', async () => {
    await expect(downloadSkillsShSkill('o/r', 's', stub(new Response('gone', { status: 404 })))).rejects.toMatchObject({ status: 404 })
    await expect(downloadSkillsShSkill('o/r', 's', stub(new Response('boom', { status: 500 })))).rejects.toMatchObject({ status: 502 })
  })
})
