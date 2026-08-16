import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { SkillHubProvider } from './provider.ts'
import { createSkill } from './skillfs.ts'

/** A control stub plus its invalidate spy; the timer is unref'd and harmless. */
function makeProvider(home: string): { provider: SkillHubProvider; invalidate: ReturnType<typeof vi.fn> } {
  const invalidate = vi.fn()
  const control: SkillProviderControl = {
    signal: new AbortController().signal,
    invalidate,
  }
  return { provider: new SkillHubProvider(control, home), invalidate }
}

describe('SkillHubProvider', () => {
  let dir: string
  let home: string
  let agentsHome: string
  const originalAgentsHome = process.env.DSH_AGENTS_HOME

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hub-provider-'))
    home = join(dir, 'home')
    agentsHome = join(dir, 'agents-home')
    process.env.DSH_AGENTS_HOME = agentsHome
    await mkdir(join(home, 'skills'), { recursive: true })
    await mkdir(join(agentsHome, 'skills'), { recursive: true })
  })

  afterEach(async () => {
    if (originalAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = originalAgentsHome
    await rm(dir, { recursive: true, force: true })
  })

  it('lists user-root skills with official ranks, sources, and invocation', async () => {
    await createSkill('user-dsh', 'alpha-skill', 'Alpha', home)
    await createSkill('user-agents', 'beta-skill', 'Beta', home)
    const { provider } = makeProvider(home)
    const candidates = await provider.list({})
    const alpha = candidates.find((candidate) => candidate.name === 'alpha-skill')
    const beta = candidates.find((candidate) => candidate.name === 'beta-skill')
    expect(alpha).toMatchObject({ source: 'user-dsh', rank: 400, provider: 'skill-hub', description: 'Alpha' })
    expect(alpha?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(alpha?.path).toContain('alpha-skill')
    expect(beta).toMatchObject({ source: 'user-agents', rank: 500 })
  })

  it('skips broken skills in list (they surface in diagnostics instead)', async () => {
    await createSkill('user-dsh', 'good-skill', 'Good', home)
    await writeFile(join(home, 'skills', 'broken.md'), '# no frontmatter', 'utf8')
    const candidates = await makeProvider(home).provider.list({})
    expect(candidates.map((candidate) => candidate.name)).toEqual(['good-skill'])
  })

  it('includes project roots when a cwd is given', async () => {
    const project = join(dir, 'project')
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, '.dsh', 'skills', 'proj-skill'), { recursive: true })
    await writeFile(
      join(project, '.dsh', 'skills', 'proj-skill', 'SKILL.md'),
      '---\nname: proj-skill\ndescription: Project\n---\n\nBody',
      'utf8',
    )
    const { provider } = makeProvider(home)
    const withCwd = await provider.list({ cwd: join(project, 'sub', 'dir') })
    const candidate = withCwd.find((entry) => entry.name === 'proj-skill')
    expect(candidate).toMatchObject({ source: 'project-dsh', rank: 100 })
    const withoutCwd = await provider.list({})
    expect(withoutCwd.find((entry) => entry.name === 'proj-skill')).toBeUndefined()
  })

  it('get() resolves a body without the frontmatter block', async () => {
    await createSkill('user-dsh', 'demo-skill', 'Demo', home)
    const { provider } = makeProvider(home)
    const candidate = (await provider.list({})).find((entry) => entry.name === 'demo-skill')
    expect(candidate).toBeDefined()
    const definition = await provider.get(candidate!)
    expect(definition).toBeDefined()
    expect(definition?.content).not.toContain('---')
    expect(definition?.content).toContain('# demo-skill')
    expect(definition?.resourceBase).toEqual({ kind: 'directory', path: join(home, 'skills', 'demo-skill') })
  })

  it('ignores frontmatter sets (sets grouping was removed)', async () => {
    const dirPath = join(home, 'skills', 'grouped-skill')
    await mkdir(dirPath, { recursive: true })
    await writeFile(join(dirPath, 'SKILL.md'), '---\nname: grouped-skill\ndescription: Grouped\nsets: [engineering, tooling]\n---\n\nBody', 'utf8')
    const { provider } = makeProvider(home)
    const candidate = (await provider.list({})).find((entry) => entry.name === 'grouped-skill')
    expect(candidate?.metadata).toBeUndefined()
  })

  it('invalidate() forwards to the registry control', async () => {
    const { provider, invalidate } = makeProvider(home)
    expect(invalidate).not.toHaveBeenCalled()
    provider.invalidate()
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('get() returns undefined for a vanished file', async () => {
    await createSkill('user-dsh', 'ghost-skill', 'Ghost', home)
    const { provider } = makeProvider(home)
    const candidate = (await provider.list({})).find((entry) => entry.name === 'ghost-skill')!
    await rm(join(home, 'skills', 'ghost-skill'), { recursive: true, force: true })
    expect(await provider.get(candidate)).toBeUndefined()
  })
})
