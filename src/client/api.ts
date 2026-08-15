/**
 * Browser-side API client for the /api/skill-hub route family. The only
 * data access path the panel uses — plain fetch, same origin.
 */
import {
  SKILL_HUB_API,
  type CatalogResponse,
  type ConfigRequest,
  type ConfigResponse,
  type CreateRequest,
  type CreateResponse,
  type MarketSourceRequest,
  type MarketSourceResponse,
  type MarketSourcesResponse,
  type RepoDiscoverResponse,
  type RepoImportRequest,
  type RepoImportResponse,
  type SkillDetail,
  type SkillDetailResponse,
  type SourceCheckRequest,
  type SourceCheckResponse,
  type SourceDeleteRequest,
  type SourceDeleteResponse,
  type SourceRestoreRequest,
  type SourceRestoreResponse,
  type SourcesResponse,
  type SourceSyncRequest,
  type SourceSyncResponse,
  type StatsResponse,
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

/** The browser half's only data entry point. */
export class SkillHubApi {
  async catalog(): Promise<CatalogResponse> {
    const response = await fetch(SKILL_HUB_API.catalog)
    return readJson<CatalogResponse>(response)
  }

  async skill(name: string): Promise<SkillDetail> {
    const url = SKILL_HUB_API.skill + '?name=' + encodeURIComponent(name)
    const response = await fetch(url)
    const body = await readJson<SkillDetailResponse>(response)
    return body.skill
  }

  /** Toggle one skill; resolves with the fresh catalog from the route. */
  async toggle(name: string, enabled: boolean): Promise<CatalogResponse> {
    const response = await fetch(SKILL_HUB_API.toggle, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, enabled } satisfies import('../protocol.ts').ToggleRequest),
    })
    const body = await readJson<import('../protocol.ts').ToggleResponse>(response)
    return body.catalog
  }

  async create(payload: CreateRequest): Promise<CreateResponse> {
    const response = await fetch(SKILL_HUB_API.create, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<CreateResponse>(response)
  }

  async stats(): Promise<StatsResponse> {
    const response = await fetch(SKILL_HUB_API.stats)
    return readJson<StatsResponse>(response)
  }

  /** Toggle a whole group in one write; resolves with the fresh catalog + failures. */
  async toggleBatch(names: string[], enabled: boolean): Promise<ToggleBatchResponse> {
    const payload: ToggleBatchRequest = { names, enabled }
    const response = await fetch(SKILL_HUB_API.toggleBatch, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<ToggleBatchResponse>(response)
  }

  /** The user's added market sources (codex-style repo slugs). */
  async market(): Promise<MarketSourcesResponse> {
    const response = await fetch(SKILL_HUB_API.market)
    return readJson<MarketSourcesResponse>(response)
  }

  /** Add a market source repo; resolves with the fresh list. */
  async addMarketSource(repo: string): Promise<MarketSourcesResponse> {
    const response = await fetch(SKILL_HUB_API.marketSource, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo } satisfies MarketSourceRequest),
    })
    return readJson<MarketSourceResponse>(response)
  }

  /** Remove a market source repo; resolves with the fresh list. */
  async removeMarketSource(repo: string): Promise<MarketSourcesResponse> {
    const response = await fetch(SKILL_HUB_API.marketSourceDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo } satisfies MarketSourceRequest),
    })
    return readJson<MarketSourceResponse>(response)
  }

  /** Check the hub's own latest GitHub release. */
  async updateCheck(): Promise<UpdateCheckResponse> {
    const response = await fetch(SKILL_HUB_API.update)
    return readJson<UpdateCheckResponse>(response)
  }

  /** Discover importable skills in a GitHub repo. */
  async repoDiscover(repo: string): Promise<RepoDiscoverResponse> {
    const url = SKILL_HUB_API.repo + '?repo=' + encodeURIComponent(repo)
    const response = await fetch(url)
    return readJson<RepoDiscoverResponse>(response)
  }

  /** Install selected repo skills into the user-dsh root (records the source). */
  async repoImport(repo: string, paths: string[]): Promise<RepoImportResponse> {
    const payload: RepoImportRequest = { repo, paths }
    const response = await fetch(SKILL_HUB_API.repoImport, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<RepoImportResponse>(response)
  }

  /** Read the hub's runtime config (effective values + saved overrides). */
  async config(): Promise<ConfigResponse> {
    const response = await fetch(SKILL_HUB_API.config)
    return readJson<ConfigResponse>(response)
  }

  /** Patch the hub's runtime config (null clears a saved override). */
  async saveConfig(patch: ConfigRequest): Promise<ConfigResponse> {
    const response = await fetch(SKILL_HUB_API.config, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    return readJson<ConfigResponse>(response)
  }

  /** 用户 tag 分组 + 系统集合组 + origin 映射。 */
  async groups(): Promise<import('../protocol.ts').GroupsResponse> {
    const response = await fetch(SKILL_HUB_API.groups)
    return readJson<import('../protocol.ts').GroupsResponse>(response)
  }

  /** 新建（无 id）或重命名（带 id）一个 tag 分组；返回全部 tag。 */
  async saveTag(payload: import('../protocol.ts').TagSaveRequest): Promise<import('../protocol.ts').SkillTag[]> {
    const response = await fetch(SKILL_HUB_API.tag, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await readJson<import('../protocol.ts').TagSaveResponse>(response)
    return body.tags
  }

  /** 删除一个 tag 分组；返回全部 tag。 */
  async deleteTag(id: string): Promise<import('../protocol.ts').SkillTag[]> {
    const response = await fetch(SKILL_HUB_API.tagDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id } satisfies import('../protocol.ts').TagDeleteRequest),
    })
    const body = await readJson<import('../protocol.ts').TagDeleteResponse>(response)
    return body.tags
  }

  /** 直接设置某 tag 的完整成员列表；返回全部 tag。 */
  async setTagMembers(id: string, skillNames: string[]): Promise<import('../protocol.ts').SkillTag[]> {
    const response = await fetch(SKILL_HUB_API.tagMembers, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, skillNames } satisfies import('../protocol.ts').TagMembersRequest),
    })
    const body = await readJson<import('../protocol.ts').TagMembersResponse>(response)
    return body.tags
  }

  /** 来源列表 + 派生 origin 映射 + 集合组 + 回收站。 */
  async sources(): Promise<SourcesResponse> {
    const response = await fetch(SKILL_HUB_API.sources)
    return readJson<SourcesResponse>(response)
  }

  /** 检查指定（或全部）来源的上游更新。 */
  async checkSources(repo?: string): Promise<SourceCheckResponse> {
    const payload: SourceCheckRequest = repo !== undefined ? { repo } : {}
    const response = await fetch(SKILL_HUB_API.sourceCheck, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<SourceCheckResponse>(response)
  }

  /** 同步一个来源的所选（或全部）技能到上游最新版本。 */
  async syncSource(repo: string, skills?: string[]): Promise<SourceSyncResponse> {
    const payload: SourceSyncRequest = skills !== undefined ? { repo, skills } : { repo }
    const response = await fetch(SKILL_HUB_API.sourceSync, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<SourceSyncResponse>(response)
  }

  /** 跟进上游删除：把所选技能移入回收站。 */
  async confirmDeleteSource(repo: string, skills: string[]): Promise<SourceDeleteResponse> {
    const payload: SourceDeleteRequest = { repo, skills }
    const response = await fetch(SKILL_HUB_API.sourceDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<SourceDeleteResponse>(response)
  }

  /** 从回收站恢复一个技能。 */
  async restoreSource(name: string): Promise<SourceRestoreResponse> {
    const payload: SourceRestoreRequest = { name }
    const response = await fetch(SKILL_HUB_API.sourceRestore, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<SourceRestoreResponse>(response)
  }
}
