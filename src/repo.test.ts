import { describe, expect, it } from 'vitest'
import { collectRepoSkillFiles, discoverRepoEntries, normalizeRepoInput, originForRoot, repoSlug } from './repo.ts'
import type { RepoTreeItem } from './repo.ts'

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
