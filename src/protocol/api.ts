/**
 * Root path of the skill-hub API family. The host also registers this as its
 * 404 catch-all prefix, so a mistyped path answers with a plain 404 naming the
 * path instead of falling through to the SPA fallback (which answers 401 and
 * reads like an auth problem).
 */
export const SKILL_HUB_API_ROOT = '/api/skill-hub'

/**
 * 写接口的 CSRF 标记头。
 *
 * 信任栅栏（Host / Origin / 会话）回答的是「谁在发」，这一层回答的是
 * 「这是不是本插件页面发的」：浏览器不允许表单提交、`<img>`、`sendBeacon`
 * 和简单跨源 fetch 携带自定义头，所以别的站点构造出来的 POST 到不了处理器。
 * 同源请求不触发 CORS 预检，因此不增加一次往返；跨源时预检会先撞上围栏
 * 直接失败，也不会漏过来。
 *
 * 只对 POST 生效 —— GET 不改状态，加上它只会让只读接口更难调。
 */
export const SKILL_HUB_WRITE_HEADER = 'x-dsh-skill-hub'
export const SKILL_HUB_WRITE_VALUE = '1'

/**
 * Browser-facing base paths of the skill-hub API family.
 *
 * Naming rule: a path's segments mirror its scope. Market sources own the
 * `/market/source/*` subtree — add, delete, ref, versions, check, sync — so
 * the update check and the sync that acts on its result sit side by side.
 */
export const SKILL_HUB_API = {
  catalog: '/api/skill-hub/catalog',
  skill: '/api/skill-hub/skill',
  skillDelete: '/api/skill-hub/skill/delete',
  toggle: '/api/skill-hub/toggle',
  toggleBatch: '/api/skill-hub/toggle-batch',
  create: '/api/skill-hub/create',
  stats: '/api/skill-hub/stats',
  config: '/api/skill-hub/config',
  market: '/api/skill-hub/market',
  marketSource: '/api/skill-hub/market/source',
  marketSourceDelete: '/api/skill-hub/market/source/delete',
  marketSourceRef: '/api/skill-hub/market/source/ref',
  marketCheck: '/api/skill-hub/market/source/check',
  marketSync: '/api/skill-hub/market/source/sync',
  repo: '/api/skill-hub/repo',
  repoImport: '/api/skill-hub/repo/import',
  repoImportProgress: '/api/skill-hub/repo/import/progress',
  repoImportCancel: '/api/skill-hub/repo/import/cancel',
  update: '/api/skill-hub/update',
  groups: '/api/skill-hub/groups',
  tag: '/api/skill-hub/tag',
  tagDelete: '/api/skill-hub/tag/delete',
  tagMembers: '/api/skill-hub/tag/members',
  tagReorder: '/api/skill-hub/tag/reorder',
  collectionReorder: '/api/skill-hub/collections/reorder',
  sourceGroupReorder: '/api/skill-hub/source-groups/reorder',
  sources: '/api/skill-hub/sources',
  sourceCheck: '/api/skill-hub/sources/check',
  sourceSync: '/api/skill-hub/sources/sync',
  sourceDelete: '/api/skill-hub/sources/delete',
  sourceRestore: '/api/skill-hub/sources/restore',
  sourceTrashClear: '/api/skill-hub/sources/trash/clear',
  diagnosticFix: '/api/skill-hub/diagnostic/fix',
  marketSourceVersions: '/api/skill-hub/market/source/versions',
  marketStats: '/api/skill-hub/market/stats',
  marketSkillsSh: '/api/skill-hub/market/skills-sh',
  marketSkillsShInstall: '/api/skill-hub/market/skills-sh/install',
  foreign: '/api/skill-hub/foreign',
  foreignImport: '/api/skill-hub/foreign/import',
  importZip: '/api/skill-hub/import/zip',
} as const
