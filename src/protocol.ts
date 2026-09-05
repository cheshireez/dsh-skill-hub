/**
 * Shared API contract for dsh-skill-hub: the route paths and payload shapes
 * both the host half and the browser half import. The browser half must never
 * depend on host SDK packages, so registry types are re-spelled here as
 * plain JSON-safe interfaces.
 *
 * 按域拆分后的重导出入口：老 `from './protocol.ts'` 写法保持可用，
 * 新代码可按需直引 `from './protocol/<domain>.ts'`。
 */

export { SKILL_HUB_API } from './protocol/api.ts'
export type {
  WritableRoot,
  HubInvocation,
  CatalogSkill,
  DisabledSkill,
  DiagnosticEntry,
  DiagnosticFixRequest,
  DiagnosticFixResponse,
  CatalogResponse,
  SkillDetail,
  SkillDetailResponse,
  SkillDeleteRequest,
  SkillDeleteResponse,
  ToggleRequest,
  ToggleResponse,
  ToggleBatchRequest,
  ToggleBatchResponse,
  CreateRequest,
  CreateResponse,
} from './protocol/catalog.ts'
export type { SkillStat, StatsResponse, SkillStatsCheckpoint } from './protocol/stats.ts'
export type { ErrorResponse, HubConfig, HubSettingsValue, ConfigResponse, ConfigRequest } from './protocol/config.ts'
export { HUB_CONFIG_DEFAULTS, HEX_COLOR_RE, GITHUB_TOKEN_RE, resolveHubConfig } from './protocol/config.ts'
export type {
  MarketSourceRecord,
  MarketSourcesResponse,
  MarketSourceRequest,
  MarketSourceResponse,
  MarketSourceRefRequest,
  MarketSourceVersionsResponse,
  MarketStatsSnapshot,
  MarketStatsResponse,
  MarketCheckResponse,
  MarketSyncResponse,
} from './protocol/market.ts'
export type {
  RepoSkillEntry,
  RepoRoot,
  RepoDiscoverResponse,
  RepoImportRequest,
  RepoImportResponse,
  RepoImportProgressResponse,
  RepoImportCancelRequest,
  RepoImportCancelResponse,
  UpdateCheckResponse,
} from './protocol/repo.ts'
export type {
  SkillTag,
  CollectionGroup,
  GroupsResponse,
  TagSaveRequest,
  TagSaveResponse,
  TagDeleteRequest,
  TagDeleteResponse,
  TagMembersRequest,
  TagMembersResponse,
  TagReorderRequest,
  TagReorderResponse,
  CollectionReorderRequest,
  CollectionReorderResponse,
  SourceGroupReorderRequest,
  SourceGroupReorderResponse,
} from './protocol/groups.ts'
export type {
  SourceRecord,
  TrashEntry,
  SourcesResponse,
  SourceCheckRequest,
  SourceCheckResult,
  SourceCheckResponse,
  SourceSyncRequest,
  SourceSyncResponse,
  SourceDeleteRequest,
  SourceDeleteResponse,
  SourceRestoreRequest,
  SourceRestoreResponse,
  SourceTrashClearResponse,
} from './protocol/sources.ts'
export { isProjectSource } from './protocol/sources.ts'
