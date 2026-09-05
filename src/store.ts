/**
 * Hub sidecar store: remembers which skills the hub toggled off and the
 * user's organization/tracking records. Disabling renames the skill's
 * SKILL.md (or flat .md) out of the filesystem provider's discovery shapes,
 * so the provider catalog alone cannot see disabled skills; this store keeps
 * name/path/root so the GUI can list them and re-enable. It also persists
 * user tag groups, upstream source records (repo + commit snapshot for
 * update checks), the market source list, and the trash (skills removed
 * after upstream deletion).
 *
 * State file: $DSH_HOME/dsh-skill-hub.json — a small JSON document written
 * atomically (tmp file + rename).
 *
 * 按职责拆分后的重导出入口：老 `from './store.ts'` 写法保持可用，
 * 新代码可按需直引 `from './store/<module>.ts'`。
 */

export { DEFAULT_SCENE_NAME, STORE_VERSION, dshHome, statePath, type StoreFile } from './store/paths.ts'
export { StoreError } from './store/errors.ts'
export { migrateStore, hydrateMigratedState, type MigratedStore, type HydratedState } from './store/migrate.ts'
export { SkillHubStore } from './store/store.ts'
