/**
 * Browser-side API client for the /api/skill-hub route family. The only
 * data access path the panel uses — plain fetch, same origin.
 */
import {
  SKILL_HUB_API,
  type CatalogResponse,
  type CollectionGroup,
  type ConfigRequest,
  type ConfigResponse,
  type CreateRequest,
  type CreateResponse,
  type CollectionReorderRequest,
  type CollectionReorderResponse,
  type SourceGroupReorderRequest,
  type SourceGroupReorderResponse,
  type MarketCheckResponse,
  type MarketStatsResponse,
  type MarketSourceRefRequest,
  type MarketSourceRequest,
  type MarketSourceResponse,
  type MarketSourcesResponse,
  type MarketSourceVersionsResponse,
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
  type SourceRestoreRequest,
  type SourceRestoreResponse,
  type SourceTrashClearResponse,
  type SourcesResponse,
  type SourceSyncRequest,
  type SourceSyncResponse,
  type StatsResponse,
  type TagReorderRequest,
  type TagReorderResponse,
  type ToggleBatchRequest,
  type ToggleBatchResponse,
  type UpdateCheckResponse,
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
 * Fetch with a hard timeout: a hung connection (proxy, stalled keep-alive,
 * host wedged) must never leave the panel stuck on "loading" forever — it
 * fails fast and surfaces the error banner instead.
 */
async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, ms = 10_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** The browser half's only data entry point. */
export class SkillHubApi {
  /** Catalog lookup options (cwd selects a workspace's project skills). */
  catalog(options?: { cwd?: string }): Promise<CatalogResponse> {
    const url = options?.cwd !== undefined && options.cwd !== '' ? SKILL_HUB_API.catalog + '?cwd=' + encodeURIComponent(options.cwd) : SKILL_HUB_API.catalog
    return fetchWithTimeout(url).then((response) => readJson<CatalogResponse>(response))
  }

  /** One skill's detail (cwd selects a workspace's project skills). */
  async skill(name: string, options?: { cwd?: string }): Promise<SkillDetail> {
    const cwd = options?.cwd !== undefined && options.cwd !== '' ? '&cwd=' + encodeURIComponent(options.cwd) : ''
    const url = SKILL_HUB_API.skill + '?name=' + encodeURIComponent(name) + cwd
    const response = await fetchWithTimeout(url)
    const body = await readJson<SkillDetailResponse>(response)
    return body.skill
  }

  /** Move one writable skill into the restorable trash. */
  async deleteSkill(name: string): Promise<SkillDeleteResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.skillDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name } satisfies SkillDeleteRequest),
    })
    return readJson<SkillDeleteResponse>(response)
  }

  /** Toggle one skill; resolves with the fresh catalog from the route. */
  async toggle(name: string, enabled: boolean): Promise<CatalogResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.toggle, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, enabled } satisfies import('../protocol.ts').ToggleRequest),
    })
    const body = await readJson<import('../protocol.ts').ToggleResponse>(response)
    return body.catalog
  }

  async create(payload: CreateRequest): Promise<CreateResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.create, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<CreateResponse>(response)
  }

  async stats(): Promise<StatsResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.stats)
    return readJson<StatsResponse>(response)
  }

  /** Toggle a whole group in one write; resolves with the fresh catalog + failures. */
  async toggleBatch(names: string[], enabled: boolean): Promise<ToggleBatchResponse> {
    const payload: ToggleBatchRequest = { names, enabled }
    const response = await fetchWithTimeout(SKILL_HUB_API.toggleBatch, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<ToggleBatchResponse>(response)
  }

  /** The user's added market sources. */
  async market(): Promise<MarketSourcesResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.market)
    return readJson<MarketSourcesResponse>(response)
  }

  /** Add a market source repo; resolves with the fresh list. */
  async addMarketSource(repo: string): Promise<MarketSourcesResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.marketSource, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo } satisfies MarketSourceRequest),
    })
    return readJson<MarketSourceResponse>(response)
  }

  /** Remove a market source repo; resolves with the fresh list. */
  async removeMarketSource(repo: string): Promise<MarketSourcesResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.marketSourceDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo } satisfies MarketSourceRequest),
    })
    return readJson<MarketSourceResponse>(response)
  }

  /** Stars + downloads per market source (hourly server-side cache; refresh=1 refetches stale entries). */
  async marketStats(refresh = false): Promise<MarketStatsResponse> {
    const url = refresh ? SKILL_HUB_API.marketStats + '?refresh=1' : SKILL_HUB_API.marketStats
    const response = await fetchWithTimeout(url, undefined, refresh ? 60_000 : undefined)
    return readJson<MarketStatsResponse>(response)
  }

  /** Check every market source for updates (throttled server-side). */
  async marketCheck(): Promise<MarketCheckResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.marketCheck)
    return readJson<MarketCheckResponse>(response)
  }

  /** Align a market source to its pinned ref; resolves with tracked skills. */
  async marketSync(repo: string): Promise<MarketSyncResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.marketSync, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo }),
    })
    return readJson<MarketSyncResponse>(response)
  }

  /** Releases + branches of a market source for the version picker. */
  async marketSourceVersions(repo: string): Promise<MarketSourceVersionsResponse> {
    const url = SKILL_HUB_API.marketSourceVersions + '?repo=' + encodeURIComponent(repo)
    const response = await fetchWithTimeout(url)
    return readJson<MarketSourceVersionsResponse>(response)
  }

  /** Pin a market source to an explicit ref (branch picker). */
  async setMarketSourceRef(repo: string, ref: string): Promise<MarketSourcesResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.marketSourceRef, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, ref } satisfies MarketSourceRefRequest),
    })
    return readJson<MarketSourceResponse>(response)
  }

  /** Check the hub's own latest GitHub release. */
  async updateCheck(): Promise<UpdateCheckResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.update)
    return readJson<UpdateCheckResponse>(response)
  }

  /** Discover importable skills in a GitHub repo. */
  async repoDiscover(repo: string): Promise<RepoDiscoverResponse> {
    const url = SKILL_HUB_API.repo + '?repo=' + encodeURIComponent(repo)
    const response = await fetchWithTimeout(url)
    return readJson<RepoDiscoverResponse>(response)
  }

  /** Install selected repo skills into the user-dsh root (records the source). Returns jobId for polling. */
  async repoImport(repo: string, paths: string[], ref?: string): Promise<RepoImportResponse> {
    const payload: RepoImportRequest = { repo, paths, ...(ref !== undefined && ref !== '' ? { ref } : {}) }
    const response = await fetchWithTimeout(SKILL_HUB_API.repoImport, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<RepoImportResponse>(response)
  }

  /** Poll import job progress (B方案轮询) */
  async repoImportProgress(jobId: string): Promise<RepoImportProgressResponse> {
    const url = SKILL_HUB_API.repoImportProgress + '?jobId=' + encodeURIComponent(jobId)
    const response = await fetchWithTimeout(url)
    return readJson<RepoImportProgressResponse>(response)
  }

  /** Cancel a running import job (选项2：唯有取消才停) */
  async repoImportCancel(jobId: string): Promise<RepoImportCancelResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.repoImportCancel, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId }),
    })
    return readJson<RepoImportCancelResponse>(response)
  }

  /** Read the hub's runtime config (effective values + saved overrides). */
  async config(): Promise<ConfigResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.config)
    return readJson<ConfigResponse>(response)
  }

  /** Patch the hub's runtime config (null clears a saved override). */
  async saveConfig(patch: ConfigRequest): Promise<ConfigResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.config, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    return readJson<ConfigResponse>(response)
  }

  /** 用户 tag 分组 + 系统集合组 + origin 映射。 */
  async groups(): Promise<import('../protocol.ts').GroupsResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.groups)
    return readJson<import('../protocol.ts').GroupsResponse>(response)
  }

  /** 新建（无 id）或重命名（带 id）一个 tag 分组；返回全部 tag。 */
  async saveTag(payload: import('../protocol.ts').TagSaveRequest): Promise<import('../protocol.ts').SkillTag[]> {
    const response = await fetchWithTimeout(SKILL_HUB_API.tag, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await readJson<import('../protocol.ts').TagSaveResponse>(response)
    return body.tags
  }

  /** 删除一个 tag 分组；返回全部 tag。 */
  async deleteTag(id: string): Promise<import('../protocol.ts').SkillTag[]> {
    const response = await fetchWithTimeout(SKILL_HUB_API.tagDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id } satisfies import('../protocol.ts').TagDeleteRequest),
    })
    const body = await readJson<import('../protocol.ts').TagDeleteResponse>(response)
    return body.tags
  }

  /** 直接设置某 tag 的完整成员列表；返回全部 tag。 */
  async setTagMembers(id: string, skillNames: string[]): Promise<import('../protocol.ts').SkillTag[]> {
    const response = await fetchWithTimeout(SKILL_HUB_API.tagMembers, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, skillNames } satisfies import('../protocol.ts').TagMembersRequest),
    })
    const body = await readJson<import('../protocol.ts').TagMembersResponse>(response)
    return body.tags
  }

  /** 拖拽重排场景分组 */
  async reorderTags(orderedIds: string[]): Promise<SkillTag[]> {
    const response = await fetchWithTimeout(SKILL_HUB_API.tagReorder, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderedIds } satisfies TagReorderRequest),
    })
    const body = await readJson<TagReorderResponse>(response)
    return body.tags
  }

  /** 拖拽重排来源集合 */
  async reorderCollections(orderedNames: string[]): Promise<CollectionGroup[]> {
    const response = await fetchWithTimeout(SKILL_HUB_API.collectionReorder, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderedNames } satisfies CollectionReorderRequest),
    })
    const body = await readJson<CollectionReorderResponse>(response)
    return body.collections
  }

  /** 拖拽重排来源顶层分组（project / collections / personal） */
  async reorderSourceGroups(orderedKeys: string[]): Promise<string[]> {
    const response = await fetchWithTimeout(SKILL_HUB_API.sourceGroupReorder, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderedKeys } satisfies SourceGroupReorderRequest),
    })
    const body = await readJson<SourceGroupReorderResponse>(response)
    return body.order
  }

  /** 来源列表 + 派生 origin 映射 + 集合组 + 回收站。 */
  async sources(): Promise<SourcesResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.sources)
    return readJson<SourcesResponse>(response)
  }

  /** 检查指定（或全部）来源的上游更新。 */
  async checkSources(repo?: string): Promise<SourceCheckResponse> {
    const payload: SourceCheckRequest = repo !== undefined ? { repo } : {}
    const response = await fetchWithTimeout(SKILL_HUB_API.sourceCheck, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<SourceCheckResponse>(response)
  }

  /** 同步一个来源的所选（或全部）技能到上游最新版本。 */
  async syncSource(repo: string, skills?: string[]): Promise<SourceSyncResponse> {
    const payload: SourceSyncRequest = skills !== undefined ? { repo, skills } : { repo }
    const response = await fetchWithTimeout(SKILL_HUB_API.sourceSync, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<SourceSyncResponse>(response)
  }

  /** 跟进上游删除：把所选技能移入回收站。 */
  async confirmDeleteSource(repo: string, skills: string[]): Promise<SourceDeleteResponse> {
    const payload: SourceDeleteRequest = { repo, skills }
    const response = await fetchWithTimeout(SKILL_HUB_API.sourceDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<SourceDeleteResponse>(response)
  }

  /** 从回收站恢复一个技能。 */
  async restoreSource(name: string): Promise<SourceRestoreResponse> {
    const payload: SourceRestoreRequest = { name }
    const response = await fetchWithTimeout(SKILL_HUB_API.sourceRestore, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<SourceRestoreResponse>(response)
  }

  /** Permanently delete every skill currently in the trash. */
  async clearTrash(): Promise<SourceTrashClearResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.sourceTrashClear, { method: 'POST' })
    return readJson<SourceTrashClearResponse>(response)
  }

  /** Auto-fix a fixable diagnostic (e.g. unquoted colon). */
  async fixDiagnostic(path: string): Promise<import('../protocol.ts').DiagnosticFixResponse> {
    const response = await fetchWithTimeout(SKILL_HUB_API.diagnosticFix, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path } satisfies import('../protocol.ts').DiagnosticFixRequest),
    })
    return readJson<import('../protocol.ts').DiagnosticFixResponse>(response)
  }
}
