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
  type ImportResponse,
  type MarketResponse,
  type RepoDiscoverResponse,
  type RepoImportRequest,
  type RepoImportResponse,
  type SkillDetail,
  type SkillDetailResponse,
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

  /** List installable market skills (with local installed flags). */
  async market(): Promise<MarketResponse> {
    const response = await fetch(SKILL_HUB_API.market)
    return readJson<MarketResponse>(response)
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

  /** Install selected repo skills into the user-dsh root. */
  async repoImport(repo: string, paths: string[]): Promise<RepoImportResponse> {
    const payload: RepoImportRequest = { repo, paths }
    const response = await fetch(SKILL_HUB_API.repoImport, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return readJson<RepoImportResponse>(response)
  }

  /** Install one market skill by name; resolves with its new path. */
  async importMarket(name: string): Promise<ImportResponse> {
    const response = await fetch(SKILL_HUB_API.importSkill, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    return readJson<ImportResponse>(response)
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

  /** 新建（无 id）或重命名（带 id）一个场景；返回全部场景。 */
  async saveScene(payload: import('../protocol.ts').SceneSaveRequest): Promise<import('../protocol.ts').Scene[]> {
    const response = await fetch(SKILL_HUB_API.scene, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await readJson<import('../protocol.ts').SceneSaveResponse>(response)
    return body.scenes
  }

  /** 删除一个场景；返回全部场景。 */
  async deleteScene(id: string): Promise<import('../protocol.ts').Scene[]> {
    const response = await fetch(SKILL_HUB_API.sceneDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id } satisfies import('../protocol.ts').SceneDeleteRequest),
    })
    const body = await readJson<import('../protocol.ts').SceneDeleteResponse>(response)
    return body.scenes
  }

  /** 直接设置某场景的完整成员列表；返回全部场景。 */
  async setSceneMembers(id: string, skillNames: string[]): Promise<import('../protocol.ts').Scene[]> {
    const response = await fetch(SKILL_HUB_API.sceneMembers, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, skillNames } satisfies import('../protocol.ts').SceneMembersRequest),
    })
    const body = await readJson<import('../protocol.ts').SceneMembersResponse>(response)
    return body.scenes
  }

  /** 标记/清除某技能归属的集合；返回变更后的 origins + collections。 */
  async setOrigin(skillName: string, origin: string | null): Promise<import('../protocol.ts').OriginResponse> {
    const response = await fetch(SKILL_HUB_API.origin, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skillName, origin } satisfies import('../protocol.ts').OriginRequest),
    })
    return readJson<import('../protocol.ts').OriginResponse>(response)
  }
}
