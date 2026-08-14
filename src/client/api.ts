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
  type SkillDetail,
  type SkillDetailResponse,
  type StatsResponse,
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

  /** Toggle a skill; resolves with the fresh catalog from the route. */
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
}

