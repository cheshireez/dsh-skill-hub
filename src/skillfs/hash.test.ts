import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashSkillAt, hashSkillDirectory } from './hash.ts'

describe('hashSkillDirectory', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hash-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function write(relative: string, content: string): Promise<void> {
    const full = join(dir, relative)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }

  it('is stable across calls for identical content', async () => {
    await write('SKILL.md', '---\nname: demo\n---\nbody\n')
    await write('scripts/run.sh', 'npm test\n')
    const first = await hashSkillDirectory(dir)
    const second = await hashSkillDirectory(dir)
    expect(first).toBeDefined()
    expect(first).toBe(second)
  })

  it('changes when a file body changes', async () => {
    await write('SKILL.md', 'body one\n')
    const before = await hashSkillDirectory(dir)
    await write('SKILL.md', 'body two\n')
    expect(await hashSkillDirectory(dir)).not.toBe(before)
  })

  it('changes when a file is added', async () => {
    await write('SKILL.md', 'body\n')
    const before = await hashSkillDirectory(dir)
    await write('extra.md', 'more\n')
    expect(await hashSkillDirectory(dir)).not.toBe(before)
  })

  it('changes when a path is renamed but content is identical', async () => {
    await write('SKILL.md', 'body\n')
    await write('a.md', 'same\n')
    const before = await hashSkillDirectory(dir)
    await rm(join(dir, 'a.md'))
    await write('b.md', 'same\n')
    expect(await hashSkillDirectory(dir)).not.toBe(before)
  })

  it('returns undefined for an empty directory', async () => {
    expect(await hashSkillDirectory(dir)).toBeUndefined()
  })

  it('returns undefined for a missing directory', async () => {
    expect(await hashSkillDirectory(join(dir, 'nope'))).toBeUndefined()
  })

  it('ignores .git and .trash', async () => {
    await write('SKILL.md', 'body\n')
    const before = await hashSkillDirectory(dir)
    await write('.git/config', 'noise\n')
    await write('.trash/old/SKILL.md', 'junk\n')
    expect(await hashSkillDirectory(dir)).toBe(before)
  })

  it('does not follow symlinks out of the skill directory', async () => {
    await write('SKILL.md', 'body\n')
    const before = await hashSkillDirectory(dir)
    const outside = await mkdtemp(join(tmpdir(), 'dsh-skill-hash-out-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'do not read me\n', 'utf8')
      await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'))
      expect(await hashSkillDirectory(dir)).toBe(before)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('hashSkillAt', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hash-at-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('hashes a directory bundle through its SKILL.md path', async () => {
    const bundle = join(dir, 'demo')
    await mkdir(bundle)
    await writeFile(join(bundle, 'SKILL.md'), 'bundle body\n', 'utf8')
    expect(await hashSkillAt(join(bundle, 'SKILL.md'))).toBe(await hashSkillDirectory(bundle))
  })

  it('hashes a disabled bundle through SKILL.md.disabled', async () => {
    const bundle = join(dir, 'demo')
    await mkdir(bundle)
    await writeFile(join(bundle, 'SKILL.md.disabled'), 'bundle body\n', 'utf8')
    expect(await hashSkillAt(join(bundle, 'SKILL.md.disabled'))).toBe(await hashSkillDirectory(bundle))
  })

  it('hashes a flat skill file directly', async () => {
    const flat = join(dir, 'flat.md')
    await writeFile(flat, 'flat body\n', 'utf8')
    const first = await hashSkillAt(flat)
    expect(first).toBeDefined()
    await writeFile(flat, 'flat body changed\n', 'utf8')
    expect(await hashSkillAt(flat)).not.toBe(first)
  })

  it('treats a flat .md.disabled file as a flat skill', async () => {
    const flat = join(dir, 'flat.md.disabled')
    await writeFile(flat, 'flat body\n', 'utf8')
    expect(await hashSkillAt(flat)).toBeDefined()
  })

  it('returns undefined when the discovery file is missing', async () => {
    expect(await hashSkillAt(join(dir, 'ghost', 'SKILL.md'))).toBeUndefined()
  })
})
