/** A skill discovered in a GitHub repo under any top-level root (e.g. skills/, templates/). */
export interface RepoSkillEntry {
  /** Kebab-case skill name (directory basename). */
  name: string
  /** Root-relative skill directory, e.g. skills/code-review. */
  dir: string
  /** Root-relative SKILL.md path, e.g. skills/code-review/SKILL.md. */
  path: string
  /** Repo root the skill lives in. */
  root: RepoRoot
  /** Collection name recorded as origin after import. */
  origin: string
  /** Number of files in the skill directory. */
  fileCount: number
  /** Total bytes across all files in the skill directory. */
  totalBytes: number
  /** Whether a same-named skill already exists locally. */
  existing: boolean
}

/** Skill root in a GitHub repo: the top-level directory that contains skills (e.g. skills, design-templates, templates). Auto-derived from SKILL.md locations, not hard-coded. */
export type RepoRoot = string

/** GET /api/skill-hub/repo — discover importable skills in a GitHub repo. */
export interface RepoDiscoverResponse {
  ok: true
  repo: string
  /**
   * Ref the discovery ran against (release tag / branch / default branch).
   * Null means the repo has no release and no pinned ref — the client must
   * ask the user to pick a branch (see `branches`) and pin it first.
   */
  ref: string | null
  /** Branch names to choose from when ref is null (default branch first). */
  branches?: string[]
  entries: RepoSkillEntry[]
  /** GitHub truncated the tree; discovery is partial (mirrors codex walk_truncated). */
  truncated?: boolean
}

/** POST /api/skill-hub/repo/import — install selected repo skills. */
export interface RepoImportRequest {
  repo: string
  /** Selected SKILL.md paths from the discover response. */
  paths: string[]
  /** The ref the discovery ran against; the import must use the same one. */
  ref?: string
}

/** POST /api/skill-hub/repo/import — now creates an async job (B方案) */
export interface RepoImportResponse {
  ok: true
  jobId: string
  total: number
  totalBytes: number
}

/** GET /api/skill-hub/repo/import/progress?jobId=xxx */
export interface RepoImportProgressResponse {
  ok: true
  jobId: string
  status: 'running' | 'done' | 'cancelled' | 'error'
  total: number
  done: number
  /** 当前正在下载的 skill 名，done < total 时有效 */
  current?: string
  /** 当前正在下载的文件路径（相对 skill dir） */
  currentFile?: string
  /** 字节级进度 */
  totalBytes: number
  downloadedBytes: number
  /** 下载速度 bytes/sec，running 时有效 */
  bytesPerSecond?: number
  imported: Array<{ name: string; origin: string; path: string }>
  skipped: Array<{ name: string; reason: 'exists' }>
  failed: Array<{ name: string; error: string }>
  /** error 状态时的原因 */
  error?: string
}

/** POST /api/skill-hub/repo/import/cancel */
export interface RepoImportCancelRequest {
  jobId: string
}
export interface RepoImportCancelResponse {
  ok: true
  jobId: string
  status: 'cancelled' | 'done'
}

/** GET /api/skill-hub/update — check the plugin's own latest GitHub release. */
export interface UpdateCheckResponse {
  ok: true
  /** Installed plugin version (from the bundled host build). */
  currentVersion: string
  /** Latest release tag, normalized without the leading v; null when unknown. */
  latestVersion: string | null
  /** True when latestVersion is strictly newer than currentVersion. */
  updateAvailable: boolean
  /** Release page URL; null when unavailable. */
  url: string | null
  /** Best-effort message when the check failed or no release exists. */
  error?: string
}
