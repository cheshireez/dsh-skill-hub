/**
 * Browser-side API client for the /api/skill-hub route family. The only
 * data access path the panel uses — plain fetch, same origin.
 */
import {
  SKILL_HUB_API,
  SKILL_HUB_WRITE_HEADER,
  SKILL_HUB_WRITE_VALUE,
  type CatalogResponse,
  type ConfigResponse,
  type CreateRequest,
  type CreateResponse,
  type DiagnosticFixRequest,
  type DiagnosticFixResponse,
  type ForeignImportRequest,
  type ForeignImportResponse,
  type ForeignImportItem,
  type ForeignListResponse,
  type GroupsResponse,
  type MarketCheckResponse,
  type MarketSourceAddResponse,
  type MarketSourceRefRequest,
  type MarketSourceRequest,
  type MarketSourceResponse,
  type MarketSourcesResponse,
  type MarketSourceVersionsResponse,
  type MarketSkillsShResponse,
  type MarketSkillsShInstallRequest,
  type MarketSkillsShInstallResponse,
  type MarketStatsResponse,
  type MarketSyncResponse,
  type RepoDiscoverResponse,
  type RepoImportCancelResponse,
  type RepoImportProgressResponse,
  type RepoImportRequest,
  type RepoImportResponse,
  type SkillDetail,
  type SkillDetailResponse,
  type SkillDeleteRequest,
  type SkillDeleteResponse,
  type SkillTag,
  type SourceCheckRequest,
  type SourceCheckResponse,
  type SourceDeleteRequest,
  type SourceDeleteResponse,
  type SourceGroupReorderRequest,
  type SourceGroupReorderResponse,
  type SourceRestoreRequest,
  type SourceRestoreResponse,
  type SourceTrashClearResponse,
  type SourcesResponse,
  type SourceSyncRequest,
  type SourceSyncResponse,
  type StatsResponse,
  type TagDeleteRequest,
  type TagDeleteResponse,
  type TagMembersRequest,
  type TagMembersResponse,
  type TagReorderRequest,
  type TagReorderResponse,
  type TagSaveRequest,
  type TagSaveResponse,
  type ToggleBatchRequest,
  type ToggleBatchResponse,
  type ToggleRequest,
  type ToggleResponse,
  type UpdateCheckResponse,
  type ZipImportResponse,
} from '../protocol.ts'

/** Error carrying the route's JSON error message. */
export class SkillHubApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillHubApiError'
  }
}

/** Parse a JSON response or throw a SkillHubApiError. */
async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new SkillHubApiError('HTTP ' + response.status + ': invalid JSON response')
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : 'HTTP ' + response.status
    throw new SkillHubApiError(message)
  }
  return body as T
}

/**
 * Resolve one route path against the page's base.
 *
 * Every route in this family is registered on the server as a root-absolute
 * path (`/api/skill-hub/...`), which is right there but wrong in a browser
 * behind a reverse proxy that owns a path prefix: the page loads from
 * `https://host/app/dsh/` while a root-absolute URL drops the prefix entirely,
 * so the gateway answers 404 HTML and `readJson` reports "invalid JSON
 * response" (issue #18). Resolving against `document.baseURI` is the host's own
 * convention — `dsh-client-connection` opens its browser carrier with
 * `new URL(path.slice(1), document.baseURI)` — so a root deployment resolves to
 * exactly the same absolute path while a prefixed one keeps its prefix, and the
 * gateway strips it before forwarding: the server still receives
 * `/api/skill-hub/*`.
 *
 * `SKILL_HUB_API_ROOT` must stay absolute (the same constant registers the
 * routes on the server), which is why the prefix is applied here at the single
 * outbound boundary rather than in the constants.
 * @param path - one route path, root-absolute unless it is already a full URL.
 * @returns the URL to fetch.
 */
export function resolveApiUrl(path: string): string {
  if (!path.startsWith('/')) return path
  if (typeof document === 'undefined') return path
  try {
    return new URL(path.slice(1), document.baseURI).href
  } catch {
    return path
  }
}

/**
 * Fetch with a hard timeout: a hung connection (proxy, stalled keep-alive,
 * host wedged) must never leave the panel stuck on "loading" forever — it
 * fails fast and surfaces the error banner instead.
 */
async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, ms = 10_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(typeof input === 'string' ? resolveApiUrl(input) : input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Headers every write request carries: the plugin marker (the host rejects a
 * POST without it — a cross-site page cannot set a custom header through a
 * simple request) plus whatever the call adds. Centralised so no method can
 * forget it; a forgotten one only surfaces as a 403 in production.
 */
function writeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { [SKILL_HUB_WRITE_HEADER]: SKILL_HUB_WRITE_VALUE, ...extra }
}

/** The browser half's only data entry point. */
export class SkillHubApi {
  /** One GET round trip (query already encoded by the caller). */
  private async get<T>(path: string, query = '', ms?: number): Promise<T> {
    const response = await fetchWithTimeout(path + query, undefined, ms)
    return readJson<T>(response)
  }

  /** One POST round trip (body omitted for routes that take none). */
  private async post<T>(path: string, body?: unknown, ms?: number): Promise<T> {
    const response = await fetchWithTimeout(path, {
      method: 'POST',
      headers: writeHeaders(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }, ms)
    return readJson<T>(response)
  }

  /** Catalog lookup options (cwd selects a workspace's project skills). */
  catalog(options?: { cwd?: string }): Promise<CatalogResponse> {
    const query = options?.cwd !== undefined && options.cwd !== '' ? '?cwd=' + encodeURIComponent(options.cwd) : ''
    return this.get<CatalogResponse>(SKILL_HUB_API.catalog, query)
  }

  /** One skill's detail (cwd selects a workspace's project skills). */
  async skill(name: string, options?: { cwd?: string }): Promise<SkillDetail> {
    const cwd = options?.cwd !== undefined && options.cwd !== '' ? '&cwd=' + encodeURIComponent(options.cwd) : ''
    const body = await this.get<SkillDetailResponse>(SKILL_HUB_API.skill, '?name=' + encodeURIComponent(name) + cwd)
    return body.skill
  }

  /** Move one writable skill into the restorable trash. */
  deleteSkill(name: string): Promise<SkillDeleteResponse> {
    return this.post<SkillDeleteResponse>(SKILL_HUB_API.skillDelete, { name } satisfies SkillDeleteRequest)
  }

  /** Toggle one skill; resolves with the fresh catalog from the route. */
  async toggle(name: string, enabled: boolean): Promise<CatalogResponse> {
    const body = await this.post<ToggleResponse>(SKILL_HUB_API.toggle, { name, enabled } satisfies ToggleRequest)
    return body.catalog
  }

  create(payload: CreateRequest): Promise<CreateResponse> {
    return this.post<CreateResponse>(SKILL_HUB_API.create, payload)
  }

  stats(): Promise<StatsResponse> {
    return this.get<StatsResponse>(SKILL_HUB_API.stats)
  }

  /** Toggle a whole group in one write; resolves with the fresh catalog + failures. */
  toggleBatch(names: string[], enabled: boolean): Promise<ToggleBatchResponse> {
    const payload: ToggleBatchRequest = { names, enabled }
    return this.post<ToggleBatchResponse>(SKILL_HUB_API.toggleBatch, payload)
  }

  /** The user's added market sources. */
  market(): Promise<MarketSourcesResponse> {
    return this.get<MarketSourcesResponse>(SKILL_HUB_API.market)
  }

  /** Add a market source repo; resolves with the fresh list plus the resolved slug. */
  addMarketSource(repo: string): Promise<MarketSourceAddResponse> {
    return this.post<MarketSourceAddResponse>(SKILL_HUB_API.marketSource, { repo } satisfies MarketSourceRequest)
  }

  /** Remove a market source repo; resolves with the fresh list. */
  removeMarketSource(repo: string): Promise<MarketSourcesResponse> {
    return this.post<MarketSourceResponse>(SKILL_HUB_API.marketSourceDelete, { repo } satisfies MarketSourceRequest)
  }

  /** Stars + downloads per market source (hourly server-side cache; refresh=1 refetches stale entries). */
  marketStats(refresh = false): Promise<MarketStatsResponse> {
    const query = refresh ? '?refresh=1' : ''
    return this.get<MarketStatsResponse>(SKILL_HUB_API.marketStats, query, refresh ? 60_000 : undefined)
  }

  /** Check every market source for updates (throttled server-side). */
  marketCheck(): Promise<MarketCheckResponse> {
    return this.get<MarketCheckResponse>(SKILL_HUB_API.marketCheck)
  }

  /** Align a market source to its pinned ref; resolves with tracked skills. */
  marketSync(repo: string): Promise<MarketSyncResponse> {
    return this.post<MarketSyncResponse>(SKILL_HUB_API.marketSync, { repo })
  }

  /** Releases + branches of a market source for the version picker. */
  marketSourceVersions(repo: string): Promise<MarketSourceVersionsResponse> {
    return this.get<MarketSourceVersionsResponse>(SKILL_HUB_API.marketSourceVersions, '?repo=' + encodeURIComponent(repo))
  }

  /** Pin a market source to an explicit ref (branch picker). */
  setMarketSourceRef(repo: string, ref: string): Promise<MarketSourcesResponse> {
    return this.post<MarketSourceResponse>(SKILL_HUB_API.marketSourceRef, { repo, ref } satisfies MarketSourceRefRequest)
  }

  /** Release notes / latest version of the hub's own GitHub release. */
  updateCheck(): Promise<UpdateCheckResponse> {
    return this.get<UpdateCheckResponse>(SKILL_HUB_API.update)
  }

  /**
   * 在 skills.sh 索引里搜技能。
   *
   * 走服务端代理：上游没有 CORS 头，浏览器直连会被拦；而且搜索不该把用户
   * 的出口 IP 交给第三方。返回的 `source` 已被服务端校验成严格 owner/repo，
   * 可以直接当市场源入参。
   */
  searchSkillsSh(query: string): Promise<MarketSkillsShResponse> {
    return this.get<MarketSkillsShResponse>(SKILL_HUB_API.marketSkillsSh, '?q=' + encodeURIComponent(query))
  }

  /**
   * 直接安装 skills.sh 里的单个技能。
   *
   * 不登记来源：上游只给 skillId，不给它在仓库里的路径，编一个 `root` 会让
   * 后续更新检查去找一个不存在的目录。所以这条路只解决「我就要这一个」，
   * 想要跟随上游请走「加为源」。
   */
  installSkillsShSkill(source: string, skillId: string): Promise<MarketSkillsShInstallResponse> {
    const payload: MarketSkillsShInstallRequest = { source, skillId }
    return this.post<MarketSkillsShInstallResponse>(SKILL_HUB_API.marketSkillsShInstall, payload)
  }

  /** Discover importable skills in a GitHub repo. */
  repoDiscover(repo: string): Promise<RepoDiscoverResponse> {
    return this.get<RepoDiscoverResponse>(SKILL_HUB_API.repo, '?repo=' + encodeURIComponent(repo))
  }

  /** Install selected repo skills into the user-dsh root (records the source). Returns jobId for polling. */
  repoImport(repo: string, paths: string[], ref?: string): Promise<RepoImportResponse> {
    const payload: RepoImportRequest = { repo, paths, ...(ref !== undefined && ref !== '' ? { ref } : {}) }
    return this.post<RepoImportResponse>(SKILL_HUB_API.repoImport, payload)
  }

  /** Poll import job progress (B方案轮询) */
  repoImportProgress(jobId: string): Promise<RepoImportProgressResponse> {
    return this.get<RepoImportProgressResponse>(SKILL_HUB_API.repoImportProgress, '?jobId=' + encodeURIComponent(jobId))
  }

  /** Cancel a running import job (选项2：唯有取消才停) */
  repoImportCancel(jobId: string): Promise<RepoImportCancelResponse> {
    return this.post<RepoImportCancelResponse>(SKILL_HUB_API.repoImportCancel, { jobId })
  }

  /** Read the hub's runtime config (effective values + saved overrides). */
  config(): Promise<ConfigResponse> {
    return this.get<ConfigResponse>(SKILL_HUB_API.config)
  }

  /** 用户 tag 分组 + 系统集合组 + origin 映射。 */
  groups(): Promise<GroupsResponse> {
    return this.get<GroupsResponse>(SKILL_HUB_API.groups)
  }

  /** 新建（无 id）或重命名（带 id）一个 tag 分组；返回全部 tag。 */
  async saveTag(payload: TagSaveRequest): Promise<SkillTag[]> {
    const body = await this.post<TagSaveResponse>(SKILL_HUB_API.tag, payload)
    return body.tags
  }

  /** 删除一个 tag 分组；返回全部 tag。 */
  async deleteTag(id: string): Promise<SkillTag[]> {
    const body = await this.post<TagDeleteResponse>(SKILL_HUB_API.tagDelete, { id } satisfies TagDeleteRequest)
    return body.tags
  }

  /** 直接设置某 tag 的完整成员列表；返回全部 tag。 */
  async setTagMembers(id: string, skillNames: string[]): Promise<SkillTag[]> {
    const body = await this.post<TagMembersResponse>(SKILL_HUB_API.tagMembers, { id, skillNames } satisfies TagMembersRequest)
    return body.tags
  }

  /** 拖拽重排场景分组 */
  async reorderTags(orderedIds: string[]): Promise<SkillTag[]> {
    const body = await this.post<TagReorderResponse>(SKILL_HUB_API.tagReorder, { orderedIds } satisfies TagReorderRequest)
    return body.tags
  }

  /** 拖拽重排来源顶层分组（project / collections / personal） */
  async reorderSourceGroups(orderedKeys: string[]): Promise<string[]> {
    const body = await this.post<SourceGroupReorderResponse>(SKILL_HUB_API.sourceGroupReorder, { orderedKeys } satisfies SourceGroupReorderRequest)
    return body.order
  }

  /** 来源列表 + 派生 origin 映射 + 集合组 + 回收站。 */
  sources(): Promise<SourcesResponse> {
    return this.get<SourcesResponse>(SKILL_HUB_API.sources)
  }

  /** 列出其他 agent 用户级技能目录里的可收编技能（只读扫描）。 */
  listForeignSkills(): Promise<ForeignListResponse> {
    return this.get<ForeignListResponse>(SKILL_HUB_API.foreign)
  }

  /** 收编所选外部技能（用户级 → ~/.dsh/skills；项目级 → <projectRoot>/.dsh/skills）。 */
  importForeignSkills(items: ForeignImportItem[]): Promise<ForeignImportResponse> {
    const payload: ForeignImportRequest = { items }
    return this.post<ForeignImportResponse>(SKILL_HUB_API.foreignImport, payload)
  }

  /**
   * 从 ZIP 导入技能：整包字节原样发出（不做 base64），服务端逐个技能审计后落盘。
   *
   * 超时比普通请求长得多 —— 解压、审计、写盘都在服务端一次完成，10 秒对
   * 一个几十 MiB 的包不够，而客户端的 10 秒默认值只适合读写状态的请求。
   */
  async importZip(file: Blob): Promise<ZipImportResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.importZip, {
      method: 'POST',
      headers: writeHeaders({ 'content-type': 'application/zip' }),
      body: await file.arrayBuffer(),
    }, 60_000)
    return readJson<ZipImportResponse>(response)
  }

  /** 检查指定（或全部）来源的上游更新。 */
  checkSources(repo?: string): Promise<SourceCheckResponse> {
    const payload: SourceCheckRequest = repo !== undefined ? { repo } : {}
    return this.post<SourceCheckResponse>(SKILL_HUB_API.sourceCheck, payload)
  }

  /** 同步一个来源的所选（或全部）技能到上游最新版本。 */
  syncSource(repo: string, skills?: string[]): Promise<SourceSyncResponse> {
    const payload: SourceSyncRequest = skills !== undefined ? { repo, skills } : { repo }
    return this.post<SourceSyncResponse>(SKILL_HUB_API.sourceSync, payload)
  }

  /** 跟进上游删除：把所选技能移入回收站。 */
  confirmDeleteSource(repo: string, skills: string[]): Promise<SourceDeleteResponse> {
    const payload: SourceDeleteRequest = { repo, skills }
    return this.post<SourceDeleteResponse>(SKILL_HUB_API.sourceDelete, payload)
  }

  /** 从回收站恢复一个技能。 */
  restoreSource(name: string): Promise<SourceRestoreResponse> {
    const payload: SourceRestoreRequest = { name }
    return this.post<SourceRestoreResponse>(SKILL_HUB_API.sourceRestore, payload)
  }

  /** Permanently delete every skill currently in the trash. */
  clearTrash(): Promise<SourceTrashClearResponse> {
    return this.post<SourceTrashClearResponse>(SKILL_HUB_API.sourceTrashClear)
  }

  /** Auto-fix a fixable diagnostic (e.g. unquoted colon). */
  fixDiagnostic(path: string): Promise<DiagnosticFixResponse> {
    return this.post<DiagnosticFixResponse>(SKILL_HUB_API.diagnosticFix, { path } satisfies DiagnosticFixRequest)
  }
}
