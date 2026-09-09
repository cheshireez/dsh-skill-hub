/**
 * GitHub repository skill discovery/import helpers.
 *
 * Kept dependency-free and mostly pure so the root/origin rules are easy to
 * test. Roots are auto-derived: any top-level directory that contains a
 * `**\/SKILL.md` (e.g. `skills/**`, `design-templates/**`, `templates/**`,
 * `workflows/**`) is treated as a skill root. No hard-coded allowlist.
 *
 * The implementation now lives under `./repo/` (types, discovery, api,
 * install) and this module is a barrel that re-exports it.
 */

// 后向兼容：老 `from './repo.ts'` 写法继续可用，新代码可直引 github-client。
export { RepoFetchError, fetchError, fetchJson, fetchJsonCached, githubAuthHeaders, isAbortError, setGithubToken } from './repo/github-client.ts'

export type { RepoRef, RepoTreeItem, RepoFile } from './repo/types.ts'

export {
  repoSlug,
  normalizeRepoInput,
  collectRepoSkillFiles,
  originForRoot,
  discoverRepoEntries,
  skillManifest,
  skillDirOf,
  diffRemoteSkills,
  repoSkillEntry,
} from './repo/discovery.ts'

export {
  loadRepoTree,
  getLatestReleaseTag,
  getRepoStats,
  listRepoReleases,
  listRepoBranches,
  getLatestCommit,
  loadRepoTreeAt,
} from './repo/api.ts'

export { downloadGitHubFile, downloadRepoSkill, cleanupLeftoverImportDirs } from './repo/install.ts'
