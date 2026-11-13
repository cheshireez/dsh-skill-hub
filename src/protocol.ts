/**
 * Shared API contract for dsh-skill-hub: the route paths and payload shapes
 * both the host half and the browser half import. The browser half must never
 * depend on host SDK packages, so registry types are re-spelled here as
 * plain JSON-safe interfaces.
 *
 * 按域拆分后的重导出入口：老 `from './protocol.ts'` 写法保持可用，
 * 新代码可按需直引 `from './protocol/<domain>.ts'`。
 *
 * 不要再为了「摇树」把 client 的 import 全部改成直引域文件 —— 实测无收益：
 * `lib/client.js` 里 `resolveHubConfig` / `redactGithubToken` /
 * `computeAnnouncementBudget` / `CONFIG_FIELDS` / `HUB_CONFIG_DEFAULTS` 各出现
 * **0 次**，只有 client 真正用到的 `isProjectSource`(15) 和 `SKILL_HUB_API`(41)
 * 被打进包。barrel 的 `export ... from` 已被完整摇掉。
 */

export { SKILL_HUB_API, SKILL_HUB_API_ROOT, SKILL_HUB_WRITE_HEADER, SKILL_HUB_WRITE_VALUE } from './protocol/api.ts'
export type {
  WritableRoot,
  HubInvocation,
  CatalogSkill,
  DisabledSkill,
  DiagnosticEntry,
  AnnouncementBudget,
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
export { ANNOUNCEMENT_CHAR_BUDGET, computeAnnouncementBudget } from './protocol/catalog.ts'
export type { SkillStat, StatsResponse, SkillStatsCheckpoint } from './protocol/stats.ts'
export type { ErrorResponse, HubConfig, HubSettingsValue, RedactedHubConfig, ConfigResponse, ConfigRequest } from './protocol/config.ts'
export { HUB_CONFIG_DEFAULTS, HUB_ENTRY_ID, HEX_COLOR_RE, GITHUB_TOKEN_RE, CONFIG_FIELDS, CONFIG_FIELD_TYPES, resolveHubConfig, redactGithubToken, type ConfigField } from './protocol/config.ts'
export type {
  MarketSourceRecord,
  MarketSourcesResponse,
  MarketSourceRequest,
  MarketSourceAddResponse,
  MarketSourceResponse,
  MarketSourceRefRequest,
  MarketSourceVersionsResponse,
  MarketStatsSnapshot,
  MarketStatsResponse,
  MarketCheckResponse,
  MarketSyncRequest,
  MarketSyncResponse,
  MarketSkillsShEntry,
  MarketSkillsShResponse,
  MarketSkillsShInstallRequest,
  MarketSkillsShInstallResponse,
} from './protocol/market.ts'
export type { AuditWarningView } from './protocol/audit.ts'
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
export type { ForeignRootView, ForeignSkillView, ForeignListResponse, ForeignImportRequest, ForeignImportResponse, ForeignImportItem, ForeignScope } from './protocol/foreign.ts'
export type { ZipAuditWarning, ZipImportResponse } from './protocol/zip.ts'
