/**
 * Hub sidecar store: remembers which skills the user paused and the
 * user's organization/tracking records. Pausing is a policy, not a file move:
 * the discovery file stays in place and an invocation override turns off model
 * auto-invocation; this store keeps the paused-skill ledger (name/path/root)
 * and the override paths. It also persists
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
