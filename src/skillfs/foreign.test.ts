import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foreignProjectRoots, foreignRoots, importForeignSkill, scanForeignRoots, scanForeignSkills } from './foreign.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { readSkillInterface } from './scan.ts'

describe('foreignRoots', () => {
  it('never lists the hub writable root ~/.agents/skills', () => {
    const dirs = foreignRoots('/home/u').map((root) => root.dir)
    expect(dirs).not.toContain('/home/u/.agents/skills')
    expect(dirs.some((dir) => dir.endsWith('.claude/skills'))).toBe(true)
  })

  it('includes the WorkBuddy user-level root ahead of the generic agents', () => {
    const dirs = foreignRoots('/home/u').map((root) => root.dir)
    expect(dirs).toContain('/home/u/.workbuddy/skills')
    expect(dirs.indexOf('/home/u/.workbuddy/skills')).toBeLessThan(dirs.indexOf('/home/u/.cursor/skills'))
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

  it('discovers symlinked agent roots and merges one real file into a single row', async () => {
    // cc-switch 式集中管理：真实文件只有一份，多个 agent 根软链到它。
    const real = join(home, 'shared', 'review')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'SKILL.md'), '---\nname: review\ndescription: Shared review skill\n---\nbody\n', 'utf8')
    for (const agent of ['.claude', '.codex', '.gemini']) {
      const root = join(home, agent, 'skills')
      await mkdir(root, { recursive: true })
      await symlink(real, join(root, 'review'))
    }

    const skills = await scanForeignSkills(home)
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: 'review', agent: 'claude-code' })
    expect(skills[0]?.alsoIn).toEqual(['codex', 'gemini-cli'])
  })

  it('keeps same-named skills from different real files as separate rows', async () => {
    await writeSkill('.claude/skills/dup', 'dup')
    await writeSkill('.workbuddy/skills/dup', 'dup')
    const skills = await scanForeignSkills(home)
    expect(skills).toHaveLength(2)
    expect(skills.map((skill) => skill.agent).sort()).toEqual(['claude-code', 'workbuddy'])
    expect(skills.every((skill) => skill.alsoIn === undefined)).toBe(true)
  })

  it('picks up skills from the WorkBuddy root', async () => {
    await writeSkill('.workbuddy/skills/wb-skill', 'wb-skill')
    const skills = await scanForeignSkills(home)
    expect(skills.map((skill) => `${skill.agent}:${skill.name}`)).toEqual(['workbuddy:wb-skill'])
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
    const { path } = await importForeignSkill(skill!, targetRoot)
    expect(path).toBe(join(targetRoot, 'demo', 'SKILL.md'))
    await expect(readFile(path, 'utf8')).resolves.toContain('name: demo')
    await expect(readFile(join(targetRoot, 'demo', 'scripts', 'run.sh'), 'utf8')).resolves.toBe('npm test\n')
  })

  it('lands a flat skill as a directory bundle', async () => {
    const dir = join(home, '.codex', 'skills')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'flat.md'), '---\nname: flat\ndescription: Flat skill for tests\n---\nbody\n', 'utf8')
    const [skill] = await scanForeignSkills(home)
    const { path } = await importForeignSkill(skill!, targetRoot)
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

  it('does not follow symlinks out of the external skill, and reports the skip', async () => {
    const dir = join(home, '.claude', 'skills', 'linked')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: linked\ndescription: Linked skill for tests\n---\nbody\n', 'utf8')
    const secret = join(home, 'secret.txt')
    await writeFile(secret, 'private\n', 'utf8')
    await symlink(secret, join(dir, 'leak.txt'))
    const [skill] = await scanForeignSkills(home)
    const outcome = await importForeignSkill(skill!, targetRoot)
    expect(outcome.skippedSymlinks).toBe(1)
    await expect(readFile(join(targetRoot, 'linked', 'leak.txt'), 'utf8')).rejects.toThrow()
  })

  it('strips WorkBuddy absolute paths from the copied market metadata only', async () => {
    const dir = join(home, '.workbuddy', 'skills', 'wb')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: wb\ndescription: WorkBuddy market skill\n---\nbody\n', 'utf8')
    const iconLocalPath = '/Users/someone/.workbuddy/skills/wb/_icon.jpg'
    await writeFile(join(dir, '_skillhub_meta.json'), JSON.stringify({
      name: 'wb', version: '1.0.0', source: 'marketplace',
      iconLocalPath,
      iconDownloadedFrom: 'https://cdn.example.com/icon.jpg',
      installedContentHash: 'sha256:deadbeef',
    }), 'utf8')
    const [skill] = await scanForeignSkills(home)
    const { path } = await importForeignSkill(skill!, targetRoot)
    const meta: Record<string, unknown> = JSON.parse(await readFile(join(dirname(path), '_skillhub_meta.json'), 'utf8'))
    expect(meta).toMatchObject({ name: 'wb', version: '1.0.0', source: 'marketplace' })
    expect(meta.iconLocalPath).toBeUndefined()
    expect(meta.iconDownloadedFrom).toBeUndefined()
    expect(meta.installedContentHash).toBeUndefined()
    // 外部目录是只读的：原文件一个字节都没动。
    const original: Record<string, unknown> = JSON.parse(await readFile(join(dir, '_skillhub_meta.json'), 'utf8'))
    expect(original.iconLocalPath).toBe(iconLocalPath)
  })
})

describe('foreignProjectRoots / scanForeignRoots', () => {
  let project: string

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'dsh-foreign-project-'))
  })

  afterEach(async () => {
    await rm(project, { recursive: true, force: true })
  })

  it('generates project-level agent dirs and never lists the hub\'s own roots', () => {
    const roots = foreignProjectRoots(['/p1', '/p2'])
    const claude = roots.filter((root) => root.agent === 'claude-code')
    expect(claude.map((root) => root.dir)).toEqual([join('/p1', '.claude', 'skills'), join('/p2', '.claude', 'skills')])
    expect(claude[0]).toMatchObject({ scope: 'project', projectRoot: '/p1' })
    // `.dsh` / `.agents` 是 dsh 自己的项目根，不是「别家的技能」。
    expect(roots.some((root) => root.dir.endsWith(join('.dsh', 'skills')))).toBe(false)
    expect(roots.some((root) => root.dir.endsWith(join('.agents', 'skills')))).toBe(false)
  })

  it('includes the WorkBuddy project-level root', () => {
    const roots = foreignProjectRoots(['/p1'])
    expect(roots.some((root) => root.agent === 'workbuddy' && root.dir === join('/p1', '.workbuddy', 'skills'))).toBe(true)
  })

  it('reports scope + projectRoot and asks isExisting once per skill', async () => {
    const dir = join(project, '.claude', 'skills', 'review')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: review\ndescription: Project-level skill\n---\nbody\n', 'utf8')

    const asked: string[] = []
    const skills = await scanForeignRoots(foreignProjectRoots([project]), (skill) => {
      asked.push(skill.name + '@' + skill.scope)
      return skill.name === 'review'
    })
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: 'review', scope: 'project', projectRoot: project, existing: true })
    expect(asked).toEqual(['review@project'])
  })

  it('imports a project-level skill into the project .dsh/skills', async () => {
    const dir = join(project, '.cursor', 'skills', 'proj-skill')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: proj-skill\ndescription: Lives in the repo\n---\nbody\n', 'utf8')

    const [skill] = await scanForeignRoots(foreignProjectRoots([project]), () => false)
    const projectRoot = join(project, '.dsh', 'skills')
    await importForeignSkill(skill!, projectRoot)
    expect(await readFile(join(projectRoot, 'proj-skill', 'SKILL.md'), 'utf8')).toContain('name: proj-skill')
  })
})

describe('cross-agent metadata', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-interface-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads Codex agents/openai.yaml', async () => {
    await mkdir(join(dir, 'agents'), { recursive: true })
    await writeFile(join(dir, 'agents', 'openai.yaml'), 'interface:\n  display_name: Code Review\n  short_description: Review helper\n', 'utf8')
    await expect(readSkillInterface(dir)).resolves.toMatchObject({ displayName: 'Code Review', shortDescription: 'Review helper' })
  })

  it('reads WorkBuddy workbuddy.json', async () => {
    await writeFile(join(dir, 'workbuddy.json'), JSON.stringify({ display_name: 'AIHOT', description_zh: '每日 AI 简报', description_en: 'Daily AI brief' }), 'utf8')
    await expect(readSkillInterface(dir)).resolves.toMatchObject({ displayName: 'AIHOT', shortDescription: '每日 AI 简报' })
  })

  it('falls back to WorkBuddy fields in SKILL.md frontmatter', async () => {
    await writeFile(join(dir, 'SKILL.md'), '---\nname: demo\ndescription: Demo\ndisplay_name: 演示技能\ndescription_zh: 中文简介\n---\nbody\n', 'utf8')
    await expect(readSkillInterface(dir)).resolves.toMatchObject({ displayName: '演示技能', shortDescription: '中文简介' })
  })

  it('keeps Claude Code argument-hint in the parsed frontmatter', () => {
    const parsed = parseFrontmatter('---\nname: demo\ndescription: Demo\nargument-hint: "[file] [flags]"\n---\nbody\n')
    expect('error' in parsed ? parsed.error : parsed.value.argumentHint).toBe('[file] [flags]')
  })
})
