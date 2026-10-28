import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foreignRoots, importForeignSkill, scanForeignSkills } from './foreign.ts'

describe('foreignRoots', () => {
  it('never lists the hub writable root ~/.agents/skills', () => {
    const dirs = foreignRoots('/home/u').map((root) => root.dir)
    expect(dirs).not.toContain('/home/u/.agents/skills')
    expect(dirs.some((dir) => dir.endsWith('.claude/skills'))).toBe(true)
  })
})

describe('scanForeignSkills', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-foreign-scan-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function writeSkill(relativeDir: string, name: string, extra = ''): Promise<void> {
    const dir = join(home, relativeDir)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: A ${name} skill for testing\n---\n\nbody\n${extra}`, 'utf8')
  }

  it('finds directory bundles and flat files across agents', async () => {
    await writeSkill('.claude/skills/review', 'review')
    await writeSkill('.codex/skills/plan', 'plan')
    const flatDir = join(home, '.cursor', 'skills')
    await mkdir(flatDir, { recursive: true })
    await writeFile(join(flatDir, 'notes.md'), '---\nname: notes\ndescription: Flat note skill\n---\nbody\n', 'utf8')

    const skills = await scanForeignSkills(home)
    expect(skills.map((skill) => `${skill.agent}:${skill.name}:${skill.kind}`)).toEqual([
      'cursor:notes:flat',
      'codex:plan:directory',
      'claude-code:review:directory',
    ])
  })

  it('skips entries whose frontmatter cannot be parsed', async () => {
    const dir = join(home, '.claude', 'skills', 'broken')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '# no frontmatter\n', 'utf8')
    expect(await scanForeignSkills(home)).toEqual([])
  })

  it('marks names that already exist in the hub catalog', async () => {
    await writeSkill('.claude/skills/taken', 'taken')
    const skills = await scanForeignSkills(home, new Set(['taken']))
    expect(skills[0]?.existing).toBe(true)
  })

  it('returns nothing when no external root exists', async () => {
    expect(await scanForeignSkills(home)).toEqual([])
  })
})

describe('importForeignSkill', () => {
  let home: string
  let targetRoot: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-foreign-import-'))
    targetRoot = join(home, 'skills')
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('copies a directory bundle with its support files', async () => {
    const dir = join(home, '.claude', 'skills', 'demo')
    await mkdir(join(dir, 'scripts'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill for tests\n---\nbody\n', 'utf8')
    await writeFile(join(dir, 'scripts', 'run.sh'), 'npm test\n', 'utf8')
    const [skill] = await scanForeignSkills(home)
    const path = await importForeignSkill(skill!, targetRoot)
    expect(path).toBe(join(targetRoot, 'demo', 'SKILL.md'))
    await expect(readFile(path, 'utf8')).resolves.toContain('name: demo')
    await expect(readFile(join(targetRoot, 'demo', 'scripts', 'run.sh'), 'utf8')).resolves.toBe('npm test\n')
  })

  it('lands a flat skill as a directory bundle', async () => {
    const dir = join(home, '.codex', 'skills')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'flat.md'), '---\nname: flat\ndescription: Flat skill for tests\n---\nbody\n', 'utf8')
    const [skill] = await scanForeignSkills(home)
    const path = await importForeignSkill(skill!, targetRoot)
    expect(path).toBe(join(targetRoot, 'flat', 'SKILL.md'))
    await expect(readFile(path, 'utf8')).resolves.toContain('name: flat')
  })

  it('rejects a skill carrying hidden Unicode tag characters', async () => {
    const dir = join(home, '.claude', 'skills', 'sneaky')
    await mkdir(dir, { recursive: true })
    const body = '---\nname: sneaky\ndescription: Looks fine\n---\nbody' + String.fromCodePoint(0xe0041) + '\n'
    await writeFile(join(dir, 'SKILL.md'), body, 'utf8')
    const [skill] = await scanForeignSkills(home)
    await expect(importForeignSkill(skill!, targetRoot)).rejects.toThrow(/invisible Unicode tag/)
    await expect(readFile(join(targetRoot, 'sneaky', 'SKILL.md'), 'utf8')).rejects.toThrow()
  })

  it('does not follow symlinks out of the external skill', async () => {
    const dir = join(home, '.claude', 'skills', 'linked')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: linked\ndescription: Linked skill for tests\n---\nbody\n', 'utf8')
    const secret = join(home, 'secret.txt')
    await writeFile(secret, 'private\n', 'utf8')
    await symlink(secret, join(dir, 'leak.txt'))
    const [skill] = await scanForeignSkills(home)
    await importForeignSkill(skill!, targetRoot)
    await expect(readFile(join(targetRoot, 'linked', 'leak.txt'), 'utf8')).rejects.toThrow()
  })
})
