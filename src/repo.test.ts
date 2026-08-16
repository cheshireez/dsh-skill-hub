import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectRepoSkillFiles, diffRemoteSkills, discoverRepoEntries, downloadGitHubFile, downloadRepoSkill, getLatestReleaseTag, listRepoBranches, normalizeRepoInput, originForRoot, repoSlug, skillDirOf } from './repo.ts'
import type { RepoTreeItem } from './repo.ts'
import type { RepoSkillEntry } from './protocol.ts'

function blob(path: string, size = 1): RepoTreeItem {
  return { path, type: 'blob', size }
}

describe('normalizeRepoInput', () => {
  it('parses owner/repo and owner/repo@ref', () => {
    expect(normalizeRepoInput('nexu-io/open-design')).toEqual({ owner: 'nexu-io', repo: 'open-design' })
    expect(normalizeRepoInput('mattpocock/skills@main')).toEqual({ owner: 'mattpocock', repo: 'skills', ref: 'main' })
  })

  it('parses github URLs and strips .git', () => {
    expect(normalizeRepoInput('https://github.com/nexu-io/open-design')).toEqual({ owner: 'nexu-io', repo: 'open-design' })
    expect(normalizeRepoInput('https://github.com/mattpocock/skills.git')).toEqual({ owner: 'mattpocock', repo: 'skills' })
  })

  it('rejects non-github URLs and empty input', () => {
    expect(normalizeRepoInput('')).toBeNull()
    expect(normalizeRepoInput('https://gitlab.com/a/b')).toBeNull()
    expect(normalizeRepoInput('owner')).toBeNull()
  })
})

describe('repoSlug', () => {
  it('builds owner/repo', () => {
    expect(repoSlug(normalizeRepoInput('nexu-io/open-design')!)).toBe('nexu-io/open-design')
  })
})

describe('originForRoot', () => {
  it('keeps repo slug when only one root is present', () => {
    expect(originForRoot('nexu-io/open-design', new Set(['skills']), 'skills')).toBe('nexu-io/open-design')
  })

  it('splits by root when multiple roots are present', () => {
    const roots = new Set(['skills', 'design-templates'] as const)
    expect(originForRoot('nexu-io/open-design', roots, 'skills')).toBe('nexu-io/open-design/skills')
    expect(originForRoot('nexu-io/open-design', roots, 'design-templates')).toBe('nexu-io/open-design/design-templates')
  })
})

describe('collectRepoSkillFiles', () => {
  it('collects only files under the skill directory', () => {
    const tree = [
      blob('skills/code-review/SKILL.md', 10),
      blob('skills/code-review/README.md', 5),
      blob('skills/other/SKILL.md', 20),
      { path: 'skills/code-review', type: 'tree' } as RepoTreeItem,
    ]
    expect(collectRepoSkillFiles(tree, 'skills/code-review').map((file) => file.path)).toEqual(['skills/code-review/README.md', 'skills/code-review/SKILL.md'])
  })
})

describe('discoverRepoEntries', () => {
  it('discovers skills and design-templates and computes origins/sizes', () => {
    const tree = [
      blob('skills/engineering/code-review/SKILL.md', 10),
      blob('skills/engineering/code-review/README.md', 5),
      blob('skills/engineering/tdd/SKILL.md', 7),
      blob('design-templates/dashboard/SKILL.md', 9),
      blob('design-templates/dashboard/assets/logo.png', 100),
      blob('docs/example/SKILL.md', 99),
      blob('plugins/examples/foo/SKILL.md', 99),
    ]
    const entries = discoverRepoEntries(tree, 'nexu-io/open-design', new Set(['tdd']))
    expect(entries.map((entry) => entry.name)).toEqual(['code-review', 'dashboard', 'tdd'])
    expect(entries[0].origin).toBe('nexu-io/open-design/skills')
    expect(entries[0].fileCount).toBe(2)
    expect(entries[0].totalBytes).toBe(15)
    expect(entries[1].origin).toBe('nexu-io/open-design/design-templates')
    expect(entries[1].fileCount).toBe(2)
    expect(entries[1].totalBytes).toBe(109)
    expect(entries[2].existing).toBe(true)
  })

  it('returns empty when no supported SKILL.md exists', () => {
    expect(discoverRepoEntries([blob('README.md'), blob('skills/foo/README.md')], 'a/b')).toEqual([])
  })
})

describe('skillDirOf', () => {
  it('recovers the nested upstream directory from the manifest', () => {
    const source = { root: 'skills' as const, manifest: { 'skills/engineering/ask-matt/SKILL.md': 100, 'skills/engineering/ask-matt/OTHER.md': 5 } }
    expect(skillDirOf(source, 'ask-matt')).toBe('skills/engineering/ask-matt')
  })

  it('finds the skill in the upstream tree when the manifest lacks an entry', () => {
    const source = { root: 'skills' as const }
    const paths = ['skills/engineering/grill-with-docs/SKILL.md', 'skills/engineering/grill-with-docs/agents/openai.yaml']
    expect(skillDirOf(source, 'grill-with-docs', paths)).toBe('skills/engineering/grill-with-docs')
  })

  it('prefers the top-level-root match over a same-name skill elsewhere', () => {
    const source = { root: 'skills' as const }
    const paths = ['docs/engineering/a/SKILL.md', 'skills/misc/a/SKILL.md']
    expect(skillDirOf(source, 'a', paths)).toBe('skills/misc/a')
  })

  it('follows an upstream move away from the manifest path', () => {
    const source = { root: 'skills' as const, manifest: { 'skills/old/ask-matt/SKILL.md': 100 } }
    const paths = ['skills/new/ask-matt/SKILL.md']
    expect(skillDirOf(source, 'ask-matt', paths)).toBe('skills/new/ask-matt')
  })

  it('falls back to root/name without a manifest entry or tree', () => {
    const source = { root: 'skills' as const }
    expect(skillDirOf(source, 'plain')).toBe('skills/plain')
  })
})

describe('diffRemoteSkills', () => {
  it('matches nested skills via the manifest and reports real deletions only', () => {
    const source = {
      root: 'skills' as const,
      skills: ['ask-matt', 'gone'],
      manifest: {
        'skills/engineering/ask-matt/SKILL.md': 100,
        'skills/engineering/ask-matt/PHASE.md': 10,
        'skills/gone/SKILL.md': 50,
      },
    }
    const tree = [
      blob('skills/engineering/ask-matt/SKILL.md', 100),
      blob('skills/engineering/ask-matt/PHASE.md', 10),
    ]
    expect(diffRemoteSkills(tree, source)).toEqual({ updated: [], deleted: ['gone'] })
  })

  it('does not report skills missing from the manifest as deleted when the tree has them', () => {
    const source = { root: 'skills' as const, skills: ['grill-with-docs'] }
    const tree = [blob('skills/engineering/grill-with-docs/SKILL.md', 100)]
    expect(diffRemoteSkills(tree, source)).toEqual({ updated: ['grill-with-docs'], deleted: [] })
  })

  it('reports size changes as updated', () => {
    const source = { root: 'skills' as const, skills: ['a'], manifest: { 'skills/engineering/a/SKILL.md': 100 } }
    expect(diffRemoteSkills([blob('skills/engineering/a/SKILL.md', 120)], source)).toEqual({ updated: ['a'], deleted: [] })
  })
})

describe('downloadRepoSkill', () => {
  it('creates the target root when missing and imports a skill directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-repo-download-'))
    try {
      const targetRoot = join(parent, 'missing', 'skills')
      const entry: RepoSkillEntry = {
        name: 'demo',
        dir: 'skills/demo',
        path: 'skills/demo/SKILL.md',
        root: 'skills',
        origin: 'example/repo',
        fileCount: 1,
        totalBytes: 1,
        existing: false,
      }
      const files = [{ path: 'skills/demo/SKILL.md', size: 1 }]
      const fetchImpl = async () => new Response('---\nname: demo\ndescription: A demo skill\n---\n\nbody', { status: 200 })
      const result = await downloadRepoSkill('example/repo', 'main', entry, files, targetRoot, fetchImpl as typeof fetch)
      expect(result.skillPath).toBe(join(targetRoot, 'demo', 'SKILL.md'))
      await expect(readFile(result.skillPath, 'utf8')).resolves.toContain('name: demo')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe('downloadGitHubFile', () => {
  it('falls back to the api contents endpoint when raw is unreachable', async () => {
    const calls: string[] = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(url)
      if (url.startsWith('https://raw.githubusercontent.com/')) throw new Error('raw blocked')
      if (url.includes('/contents/')) return new Response('---\nname: demo\ndescription: x\n---\n\nbody', { status: 200 })
      return new Response('nope', { status: 599 })
    }
    const buffer = await downloadGitHubFile('example/repo', 'main', 'skills/demo/SKILL.md', fetchImpl as typeof fetch)
    expect(buffer.toString('utf8')).toContain('name: demo')
    expect(calls.length).toBe(2)
    expect(calls[1]).toContain('api.github.com/repos/example/repo/contents/skills/demo/SKILL.md')
  })

  it('reports the original error when both hosts fail', async () => {
    const fetchImpl = async () => { throw new Error('network down') }
    await expect(downloadGitHubFile('a/b', 'main', 'x/SKILL.md', fetchImpl as typeof fetch)).rejects.toThrow(/network down/)
  })
})

describe('getLatestReleaseTag', () => {
  it('returns the tag of the latest release', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ tag_name: 'v1.2.3' }), { status: 200 })
    expect(await getLatestReleaseTag('a/b', fetchImpl as typeof fetch)).toBe('v1.2.3')
  })

  it('returns undefined when the repo has no releases', async () => {
    const fetchImpl = async () => new Response('not found', { status: 404 })
    expect(await getLatestReleaseTag('a/b', fetchImpl as typeof fetch)).toBeUndefined()
  })
})

describe('listRepoBranches', () => {
  it('lists branch names from the branches endpoint', async () => {
    const fetchImpl = async () => new Response(JSON.stringify([{ name: 'main' }, { name: 'dev' }]), { status: 200 })
    expect(await listRepoBranches('a/b', fetchImpl as typeof fetch)).toEqual(['main', 'dev'])
  })
})
