import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_COMPRESSION, apiHeaders, collectRepoSkillFiles, diffRemoteSkills, discoverRepoEntries, downloadGitHubFile, downloadRepoSkill, getLatestReleaseTag, getRepoStats, listRepoBranches, normalizeRepoInput, originForRoot, relativeToSkillDir, repoSkillEntry, repoSlug, skillDirOf, skillFileAt, skillManifest } from './repo.ts'
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
    const roots = new Set(['skills', 'design-templates'])
    expect(originForRoot('nexu-io/open-design', roots, 'skills')).toBe('nexu-io/open-design/skills')
    expect(originForRoot('nexu-io/open-design', roots, 'design-templates')).toBe('nexu-io/open-design/design-templates')
  })

  it('works with arbitrary roots', () => {
    const roots = new Set(['templates', 'workflows'])
    expect(originForRoot('a/b', roots, 'templates')).toBe('a/b/templates')
    expect(originForRoot('a/b', new Set(['my-root']), 'my-root')).toBe('a/b')
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

  it('collects the whole repo for the repo-root skill, minus repo tooling', () => {
    const tree = [
      blob('SKILL.md', 900),
      blob('AGENTS.md', 10),
      blob('LICENSE', 20),
      blob('README.md', 30),
      blob('agents/openai.yaml', 5),
      blob('scripts/validate.py', 6),
      blob('.github/workflows/validate.yml', 999),
      blob('.claude-plugin/plugin.json', 999),
      blob('.gitignore', 999),
    ]
    const files = collectRepoSkillFiles(tree, '')
    expect(files.map((file) => file.path)).toEqual(['AGENTS.md', 'agents/openai.yaml', 'LICENSE', 'README.md', 'scripts/validate.py', 'SKILL.md'])
    expect(files.reduce((sum, file) => sum + file.size, 0)).toBe(971)
    // The manifest must describe exactly the collected set, or every later
    // update diff would report "changed".
    expect(skillManifest(tree, '')).toEqual(Object.fromEntries(files.map((file) => [file.path, file.size])))
  })
})

describe('discoverRepoEntries', () => {
  it('discovers skills and design-templates and computes origins/sizes (generic roots)', () => {
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
    // generic: any top-level dir is a root, so docs/plugins are also discovered (4 roots -> split origins)
    expect(entries.map((entry) => entry.name)).toEqual(['code-review', 'dashboard', 'example', 'foo', 'tdd'])
    expect(entries.find((e) => e.name === 'code-review')?.origin).toBe('nexu-io/open-design/skills')
    expect(entries.find((e) => e.name === 'code-review')?.fileCount).toBe(2)
    expect(entries.find((e) => e.name === 'code-review')?.totalBytes).toBe(15)
    expect(entries.find((e) => e.name === 'dashboard')?.origin).toBe('nexu-io/open-design/design-templates')
    expect(entries.find((e) => e.name === 'dashboard')?.fileCount).toBe(2)
    expect(entries.find((e) => e.name === 'dashboard')?.totalBytes).toBe(109)
    expect(entries.find((e) => e.name === 'example')?.origin).toBe('nexu-io/open-design/docs')
    expect(entries.find((e) => e.name === 'foo')?.origin).toBe('nexu-io/open-design/plugins')
    expect(entries.find((e) => e.name === 'tdd')?.existing).toBe(true)
  })

  it('discovers arbitrary roots like templates and workflows', () => {
    const tree = [
      blob('templates/my-template/SKILL.md', 10),
      blob('workflows/deploy/SKILL.md', 7),
      blob('my-skills/foo/SKILL.md', 5),
    ]
    const entries = discoverRepoEntries(tree, 'a/b')
    expect(entries.map((e) => e.root).sort()).toEqual(['my-skills', 'templates', 'workflows'])
    expect(entries.map((e) => e.name).sort()).toEqual(['deploy', 'foo', 'my-template'])
  })

  it('ignores hidden roots and bare root/SKILL.md', () => {
    const tree = [
      blob('.hidden/secret/SKILL.md', 1),
      blob('skills/SKILL.md', 1),
      blob('.github/workflows/ci/SKILL.md', 1),
    ]
    expect(discoverRepoEntries(tree, 'a/b')).toEqual([])
  })

  it('discovers a SKILL.md at the repo root as one skill named after the repo', () => {
    // The whole-repo layout (a plugin manifest may declare "skills": ["./"]).
    const tree = [
      blob('SKILL.md', 900),
      blob('AGENTS.md', 10),
      blob('LICENSE', 20),
      blob('README.md', 30),
      blob('agents/openai.yaml', 5),
      blob('scripts/validate.py', 6),
      blob('.github/workflows/validate.yml', 999),
      blob('.claude-plugin/plugin.json', 999),
      blob('.gitignore', 999),
    ]
    const entries = discoverRepoEntries(tree, 'blader/humanizer')
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry.name).toBe('humanizer')
    expect(entry.root).toBe('')
    expect(entry.dir).toBe('')
    expect(entry.path).toBe('SKILL.md')
    // Repo tooling (top-level dot entries) is not part of the skill.
    expect(entry.fileCount).toBe(6)
    expect(entry.totalBytes).toBe(971)
    expect(entry.origin).toBe('blader/humanizer')
  })

  it('splits the repo-root origin from nested roots without a trailing slash', () => {
    const tree = [blob('SKILL.md', 1), blob('skills/foo/SKILL.md', 1)]
    const entries = discoverRepoEntries(tree, 'a/b')
    expect(entries.map((e) => [e.name, e.root, e.origin])).toEqual([
      ['b', '', 'a/b'],
      ['foo', 'skills', 'a/b/skills'],
    ])
  })

  it('skips the repo-root candidate when the repo name is not a valid skill name', () => {
    expect(discoverRepoEntries([blob('SKILL.md', 1)], 'a/Not A Skill')).toEqual([])
  })

  it('returns empty when no SKILL.md exists', () => {
    expect(discoverRepoEntries([blob('README.md'), blob('skills/foo/README.md')], 'a/b')).toEqual([])
  })
})

describe('skillDirOf', () => {
  it('recovers the nested upstream directory from the manifest', () => {
    const source = { root: 'skills', manifest: { 'skills/engineering/ask-matt/SKILL.md': 100, 'skills/engineering/ask-matt/OTHER.md': 5 } }
    expect(skillDirOf(source, 'ask-matt')).toBe('skills/engineering/ask-matt')
  })

  it('finds the skill in the upstream tree when the manifest lacks an entry', () => {
    const source = { root: 'skills' }
    const paths = ['skills/engineering/grill-with-docs/SKILL.md', 'skills/engineering/grill-with-docs/agents/openai.yaml']
    expect(skillDirOf(source, 'grill-with-docs', paths)).toBe('skills/engineering/grill-with-docs')
  })

  it('prefers the top-level-root match over a same-name skill elsewhere', () => {
    const source = { root: 'skills' }
    const paths = ['docs/engineering/a/SKILL.md', 'skills/misc/a/SKILL.md']
    expect(skillDirOf(source, 'a', paths)).toBe('skills/misc/a')
  })

  it('follows an upstream move away from the manifest path', () => {
    const source = { root: 'skills', manifest: { 'skills/old/ask-matt/SKILL.md': 100 } }
    const paths = ['skills/new/ask-matt/SKILL.md']
    expect(skillDirOf(source, 'ask-matt', paths)).toBe('skills/new/ask-matt')
  })

  it('falls back to root/name without a manifest entry or tree', () => {
    const source = { root: 'skills' }
    expect(skillDirOf(source, 'plain')).toBe('skills/plain')
  })

  it('works with arbitrary roots', () => {
    const source = { root: 'templates', manifest: { 'templates/my-tmpl/SKILL.md': 10 } }
    expect(skillDirOf(source, 'my-tmpl')).toBe('templates/my-tmpl')
    expect(skillDirOf({ root: 'workflows' }, 'deploy', ['workflows/deploy/SKILL.md'])).toBe('workflows/deploy')
  })
})

describe('diffRemoteSkills', () => {
  it('matches nested skills via the manifest and reports real deletions only', () => {
    const source = {
      root: 'skills',
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
    const source = { root: 'skills', skills: ['grill-with-docs'] }
    const tree = [blob('skills/engineering/grill-with-docs/SKILL.md', 100)]
    expect(diffRemoteSkills(tree, source)).toEqual({ updated: ['grill-with-docs'], deleted: [] })
  })

  it('reports size changes as updated', () => {
    const source = { root: 'skills', skills: ['a'], manifest: { 'skills/engineering/a/SKILL.md': 100 } }
    expect(diffRemoteSkills([blob('skills/engineering/a/SKILL.md', 120)], source)).toEqual({ updated: ['a'], deleted: [] })
  })

  it('works with arbitrary roots', () => {
    const source = { root: 'templates', skills: ['x'], manifest: { 'templates/x/SKILL.md': 10 } }
    expect(diffRemoteSkills([blob('templates/x/SKILL.md', 11)], source)).toEqual({ updated: ['x'], deleted: [] })
    expect(diffRemoteSkills([], source)).toEqual({ updated: [], deleted: ['x'] })
  })
})

describe('repo-root skills (SKILL.md at the repository root)', () => {
  it('maps paths without a leading slash or an over-eager slice', () => {
    // The prefix is empty, so relative === absolute and slicing would eat a char.
    expect(skillFileAt('')).toBe('SKILL.md')
    expect(relativeToSkillDir('', 'SKILL.md')).toBe('SKILL.md')
    expect(relativeToSkillDir('', 'agents/openai.yaml')).toBe('agents/openai.yaml')
    // Nested dirs are unchanged.
    expect(skillFileAt('skills/demo')).toBe('skills/demo/SKILL.md')
    expect(relativeToSkillDir('skills/demo', 'skills/demo/SKILL.md')).toBe('SKILL.md')
    expect(relativeToSkillDir('skills/demo', 'skills/demo/agents/a.yaml')).toBe('agents/a.yaml')
  })

  it('builds a repo-root entry whose dir is empty and whose path is a bare SKILL.md', () => {
    expect(repoSkillEntry('humanizer', '', 'blader/humanizer')).toEqual({
      name: 'humanizer',
      dir: '',
      path: 'SKILL.md',
      root: '',
      origin: 'blader/humanizer',
      fileCount: 0,
      totalBytes: 0,
      existing: false,
    })
  })

  it('resolves the skill directory to the repo root, never to "/name"', () => {
    const manifest = { 'SKILL.md': 900, 'README.md': 30 }
    expect(skillDirOf({ root: '', manifest }, 'humanizer')).toBe('')
    // A tree lookup must not drag it into a same-name nested skill.
    expect(skillDirOf({ root: '' }, 'humanizer', ['SKILL.md', 'skills/humanizer/SKILL.md'])).toBe('')
    // Upstream deleted the SKILL.md: still '', so the diff reports a deletion
    // instead of hunting for a nested directory that never existed.
    expect(skillDirOf({ root: '', manifest }, 'humanizer', ['README.md'])).toBe('')
  })

  it('does not mistake an unchanged repo-root skill for a deletion', () => {
    // Regression guard for the mid-upgrade hazard: with the old fallback
    // (root + '/' + name) the prefix was '/humanizer/', matched no blob, and
    // the skill was reported as deleted — which the GUI turns into a move to
    // the trash can, even though upstream never changed.
    const source = { root: '', skills: ['humanizer'], manifest: { 'SKILL.md': 900, 'README.md': 30, 'agents/openai.yaml': 5 } }
    const tree = [blob('SKILL.md', 900), blob('README.md', 30), blob('agents/openai.yaml', 5), blob('.github/workflows/ci.yml', 999)]
    expect(diffRemoteSkills(tree, source)).toEqual({ updated: [], deleted: [] })
  })

  it('reports repo-root updates and deletions', () => {
    const source = { root: '', skills: ['humanizer'], manifest: { 'SKILL.md': 900, 'README.md': 30 } }
    expect(diffRemoteSkills([blob('SKILL.md', 1200), blob('README.md', 30)], source)).toEqual({ updated: ['humanizer'], deleted: [] })
    // A file removed upstream changes the manifest without being a deletion.
    expect(diffRemoteSkills([blob('SKILL.md', 900)], source)).toEqual({ updated: ['humanizer'], deleted: [] })
    // No SKILL.md at all is a real deletion.
    expect(diffRemoteSkills([blob('README.md', 30)], source)).toEqual({ updated: [], deleted: ['humanizer'] })
  })

  it('treats repo tooling as neither an addition nor a change', () => {
    // A .github-only upstream change must not flip the skill to "updated".
    const source = { root: '', skills: ['humanizer'], manifest: { 'SKILL.md': 900 } }
    const tree = [blob('SKILL.md', 900), blob('.github/workflows/ci.yml', 1)]
    expect(diffRemoteSkills(tree, source)).toEqual({ updated: [], deleted: [] })
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

  it('imports a repo-root skill keeping its top-level paths intact', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-repo-download-root-'))
    try {
      const targetRoot = join(parent, 'skills')
      const entry: RepoSkillEntry = repoSkillEntry('humanizer', '', 'blader/humanizer')
      const files = [
        { path: 'SKILL.md', size: 1 },
        { path: 'agents/openai.yaml', size: 1 },
      ]
      const fetchImpl = async () => new Response('---\nname: humanizer\ndescription: Rewrite AI-sounding text\n---\n\nbody', { status: 200 })
      const result = await downloadRepoSkill('blader/humanizer', 'main', entry, files, targetRoot, fetchImpl as typeof fetch)
      expect(result.skillPath).toBe(join(targetRoot, 'humanizer', 'SKILL.md'))
      // 'SKILL.md' must not be sliced down to 'KILL.md'.
      await expect(readFile(join(targetRoot, 'humanizer', 'SKILL.md'), 'utf8')).resolves.toContain('name: humanizer')
      await expect(readFile(join(targetRoot, 'humanizer', 'agents', 'openai.yaml'), 'utf8')).resolves.toContain('name: humanizer')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe('downloadGitHubFile', () => {
  it('falls back to the api contents endpoint when raw is unreachable', async () => {
    const calls: string[] = []
    const fetchImpl = async (url: string) => {
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

describe('getRepoStats', () => {
  it('sums stars and release asset downloads', async () => {
    const fetchImpl = async (url: string) => {
      if (url.includes('/releases')) {
        return new Response(JSON.stringify([
          { tag_name: 'v2', assets: [{ download_count: 30 }, { download_count: 12 }] },
          { tag_name: 'v1', assets: [{ download_count: 8 }] },
        ]), { status: 200 })
      }
      return new Response(JSON.stringify({ stargazers_count: 1500 }), { status: 200 })
    }
    expect(await getRepoStats('a/b', fetchImpl as typeof fetch)).toEqual({ stars: 1500, downloads: 50 })
  })

  it('tolerates a failing releases endpoint', async () => {
    const fetchImpl = async (url: string) => {
      if (url.includes('/releases')) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({ stargazers_count: 7 }), { status: 200 })
    }
    expect(await getRepoStats('a/b', fetchImpl as typeof fetch)).toEqual({ stars: 7, downloads: 0 })
  })
})

describe('GitHub 请求头', () => {
  it('总是要求未压缩实体', () => {
    // 经代理的响应会丢掉 content-encoding 但 body 仍是 gzip（见 github-client.ts
    // 里 NO_COMPRESSION 的说明），一旦漏掉这个头，所有 GitHub 调用会假性失败并
    // 报 `invalid github response for <url>`。
    expect(NO_COMPRESSION['accept-encoding']).toBe('identity')
    expect(apiHeaders()['accept-encoding']).toBe('identity')
  })

  it('保留 JSON 的 accept 头', () => {
    expect(apiHeaders().accept).toBe('application/vnd.github+json')
  })
})
