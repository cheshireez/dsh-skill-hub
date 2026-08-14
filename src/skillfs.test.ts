import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSkill, disableSkill, enableSkill, parseFrontmatter, rootOfPath, scanDiagnostics } from './skillfs.ts'

describe('parseFrontmatter', () => {
  it('parses a healthy frontmatter', () => {
    const text = '---\nname: demo-skill\ndescription: Does demo things\n---\n\n# Body'
    expect(parseFrontmatter(text)).toEqual({
      value: {
        name: 'demo-skill',
        description: 'Does demo things',
        invocation: { modelInvocable: true, userInvocable: true },
        content: '# Body',
      },
    })
  })

  it('parses whenToUse and invocation overrides', () => {
    const text = [
      '---',
      'name: guarded-skill',
      'description: Guarded',
      'whenToUse: Only for guard checks',
      'disable-model-invocation: true',
      'user-invocable: false',
      '---',
      '',
      'Body text',
    ].join('\n')
    const parsed = parseFrontmatter(text)
    expect(parsed).toEqual({
      value: {
        name: 'guarded-skill',
        description: 'Guarded',
        whenToUse: 'Only for guard checks',
        invocation: { modelInvocable: false, userInvocable: false },
        content: 'Body text',
      },
    })
  })

  it('parses folded YAML descriptions', () => {
    const text = [
      '---',
      'name: folded-skill',
      'description: |',
      '  Line one.',
      '  Line two.',
      '---',
      '',
      'Body',
    ].join('\n')
    const parsed = parseFrontmatter(text)
    expect(parsed).toMatchObject({
      value: { name: 'folded-skill', description: 'Line one.\nLine two.' },
    })
  })

  it('rejects legacy invocation keys', () => {
    expect(parseFrontmatter('---\nname: x-skill\ndescription: x\ndisableModelInvocation: true\n---')).toEqual({
      error: 'frontmatter field "disableModelInvocation" is unsupported; use "disable-model-invocation"',
    })
  })

  it('rejects non-boolean invocation values', () => {
    expect(parseFrontmatter('---\nname: x-skill\ndescription: x\ndisable-model-invocation: maybe\n---')).toEqual({
      error: 'frontmatter field "disable-model-invocation" must be a boolean',
    })
  })

  it('rejects a missing block', () => {
    expect(parseFrontmatter('# no frontmatter')).toEqual({ error: 'missing YAML frontmatter (--- block)' })
  })

  it('rejects a missing name', () => {
    expect(parseFrontmatter('---\ndescription: x\n---')).toEqual({ error: 'frontmatter requires a name field' })
  })

  it('rejects a non-kebab-case name', () => {
    expect(parseFrontmatter('---\nname: Bad Name!\ndescription: x\n---')).toEqual({ error: 'invalid skill name "Bad Name!" (must be kebab-case)' })
  })

  it('rejects a missing description', () => {
    expect(parseFrontmatter('---\nname: ok-name\n---')).toEqual({ error: 'frontmatter requires a description field' })
  })

  it('parses a single-string sets field into a list', () => {
    const parsed = parseFrontmatter('---\nname: ok-name\ndescription: x\nsets: engineering\n---')
    expect(parsed).toMatchObject({ value: { sets: ['engineering'] } })
  })

  it('parses an array sets field, trimming and dropping empties', () => {
    const parsed = parseFrontmatter('---\nname: ok-name\ndescription: x\nsets: [engineering, " 3d ", ""]\n---')
    expect(parsed).toMatchObject({ value: { sets: ['engineering', '3d'] } })
  })

  it('omits sets when the field is absent or empty', () => {
    const expected = { name: 'ok-name', description: 'x', invocation: { modelInvocable: true, userInvocable: true }, content: '' }
    expect(parseFrontmatter('---\nname: ok-name\ndescription: x\n---')).toEqual({ value: expected })
    expect(parseFrontmatter('---\nname: ok-name\ndescription: x\nsets: []\n---')).toEqual({ value: expected })
  })
})

describe('createSkill / disableSkill / enableSkill', () => {
  let dir: string
  let home: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hub-fs-'))
    home = join(dir, 'home')
    await mkdir(join(home, 'skills'), { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('scaffolds a directory-bundle skill with frontmatter', async () => {
    const path = await createSkill('user-dsh', 'demo-skill', 'Does demo things', home)
    const text = await readFile(path, 'utf8')
    expect(text).toContain('name: demo-skill')
    expect(text).toContain('description: Does demo things')
    expect(parseFrontmatter(text)).toMatchObject({ value: { name: 'demo-skill', description: 'Does demo things' } })
  })

  it('refuses non-kebab-case names', async () => {
    await expect(createSkill('user-dsh', 'Not Valid', '', home)).rejects.toThrow(/kebab-case/)
  })

  it('toggles a directory bundle off and back on', async () => {
    const original = await createSkill('user-dsh', 'toggle-skill', 'Toggle me', home)
    const disabled = await disableSkill(original)
    expect(disabled.endsWith('.disabled')).toBe(true)
    await expect(access(original)).rejects.toThrow()
    const restored = await enableSkill(disabled)
    expect(restored).toBe(original)
    await expect(access(original)).resolves.toBeUndefined()
  })

  it('toggles a flat skill file off and back on', async () => {
    const flat = join(home, 'skills', 'flat-skill.md')
    await writeFile(flat, '---\nname: flat-skill\ndescription: Flat\n---\n\nBody', 'utf8')
    const disabled = await disableSkill(flat)
    expect(disabled).toBe(flat + '.disabled')
    const restored = await enableSkill(disabled)
    expect(restored).toBe(flat)
  })

  it('refuses to disable a non-skill file', async () => {
    await expect(disableSkill(join(home, 'skills', 'notes.txt'))).rejects.toThrow(/not a discoverable skill file/)
  })
})

describe('scanDiagnostics', () => {
  let dir: string
  let home: string
  let skills: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hub-diag-'))
    home = join(dir, 'home')
    skills = join(home, 'skills')
    await mkdir(skills, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns an empty list for a healthy root', async () => {
    await createSkill('user-dsh', 'good-skill', 'Good', home)
    expect(await scanDiagnostics('user-dsh', home)).toEqual([])
  })

  it('reports skipped files with reasons', async () => {
    await writeFile(join(skills, 'no-frontmatter.md'), '# nothing', 'utf8')
    await mkdir(join(skills, 'bad-name'))
    await writeFile(join(skills, 'bad-name', 'SKILL.md'), '---\nname: Bad Name\ndescription: x\n---', 'utf8')
    const entries = await scanDiagnostics('user-dsh', home)
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.reason)).toContain('missing YAML frontmatter (--- block)')
    expect(entries.map((entry) => entry.reason)).toContain('invalid skill name "Bad Name" (must be kebab-case)')
  })

  it('skips hub-disabled files', async () => {
    await writeFile(join(skills, 'paused.md.disabled'), '---\nname: paused\ndescription: x\n---', 'utf8')
    expect(await scanDiagnostics('user-dsh', home)).toEqual([])
  })

  it('returns an empty list when the root does not exist', async () => {
    expect(await scanDiagnostics('user-dsh', join(dir, 'missing'))).toEqual([])
  })
})

describe('rootOfPath', () => {
  it('recognizes the writable roots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hub-root-'))
    try {
      expect(rootOfPath(join(dir, 'skills', 'a', 'SKILL.md'), dir)).toBe('user-dsh')
      expect(rootOfPath(join(dir, 'other', 'b.md'), dir)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

