/**
 * 仓库导入的纯结构类型：仓库引用、GitHub 树条目、技能目录内文件。
 * 从 repo.ts 抽出，仅含 interface，无运行时依赖。
 */

/** Parsed GitHub repository reference. */
export interface RepoRef {
  owner: string
  repo: string
  /** Explicit branch/tag when supplied; undefined means use the default branch. */
  ref?: string
}

/** One file inside a GitHub repo tree. */
export interface RepoTreeItem {
  path: string
  type: 'blob' | 'tree'
  size?: number
}

/** One file belonging to a skill directory. */
export interface RepoFile {
  path: string
  size: number
}
