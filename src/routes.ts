/**
 * The /api/skill-hub route family: full catalog (enabled skills from the
 * official registry + hub-disabled skills + discovery diagnostics), skill
 * detail, enable/disable toggle, new-skill scaffold, user groups (tags +
 * origin collections), and upstream source tracking (check/sync/follow
 * upstream deletion into a restorable trash). Every route carries a
 * loopback-only trust fence — these endpoints rename files under the user's
 * skill roots, so LAN-exposed dsh web deployments must not serve them.
 *
 * Every handler is declared through the local `route()` wrapper, which owns
 * the shared request fences (loopback trust, HTTP method, master switch,
 * JSON body) exactly once, so a new route cannot forget them.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { randomUUID } from 'node:crypto'
import {
  cleanupLeftoverImportDirs,
  collectRepoSkillFiles,
  diffRemoteSkills,
  discoverRepoEntries,
  downloadRepoSkill,
  getLatestCommit,
  getLatestReleaseTag,
  getRepoStats,
  isAbortError,
  listRepoBranches,
  listRepoReleases,
  loadRepoTree,
  loadRepoTreeAt,
  normalizeRepoInput,
  repoSkillEntry,
  repoSlug,
  RepoFetchError,
  skillDirOf,
  skillManifest,
} from './repo.ts'
import {
  SKILL_HUB_API,
  type CatalogResponse,
  type RepoImportCancelRequest,
  type RepoImportCancelResponse,
  type RepoImportProgressResponse,
  type RepoImportRequest,
  type RepoImportResponse,
  type CatalogSkill,
  type CollectionGroup,
  type ConfigResponse,
  type CreateResponse,
  type RepoDiscoverResponse,
  type CreateRequest,
  type ErrorResponse,
  type GroupsResponse,
  type HubConfig,
  type MarketCheckResponse,
  type MarketSourceRefRequest,
  type MarketSourceRequest,
  type MarketSourceResponse,
  type MarketSourcesResponse,
  type MarketSourceVersionsResponse,
  type MarketStatsResponse,
  type MarketSyncResponse,
  type SourceCheckRequest,
  type SourceCheckResponse,
  type SourceCheckResult,
  type SourceDeleteRequest,
  type SourceDeleteResponse,
  type SourceRestoreRequest,
  type SourceRestoreResponse,
  type SourceTrashClearResponse,
  type SourcesResponse,
  type SourceSyncRequest,
  type SourceSyncResponse,
  type SkillDetail,
  type SkillDetailResponse,
  type SkillDeleteRequest,
  type SkillDeleteResponse,
  type TagDeleteRequest,
  type TagDeleteResponse,
  type TagMembersRequest,
  type TagMembersResponse,
  type TagReorderRequest,
  type TagReorderResponse,
  type CollectionReorderRequest,
  type CollectionReorderResponse,
  type SourceGroupReorderRequest,
  type SourceGroupReorderResponse,
  type TagSaveRequest,
  type TagSaveResponse,
  type DiagnosticFixRequest,
  type DiagnosticFixResponse,
  type ToggleBatchRequest,
  type ToggleBatchResponse,
  type ToggleRequest,
  type ToggleResponse,
  type WritableRoot,
  GITHUB_TOKEN_RE,
  HEX_COLOR_RE,
  isProjectSource,
  resolveHubConfig,
} from './protocol.ts'
import { clearTrash, createSkill, disableSkill, enableSkill, fixDiagnosticFile, parseFrontmatter, readSkillInterface, restoreSkill, rootOfPath, rootPath, scanDiagnostics, trashSkill } from './skillfs.ts'
import { checkLatestRelease, CURRENT_VERSION } from './update.ts'
import { dshHome, StoreError, type SkillHubStore } from './store.ts'
import type { SkillStatsReader } from './stats.ts'
import {
  buildCatalog,
  buildGroups,
  configOf,
  createRoute,
  disabledGate,
  homeOf,
  isWritableSource,
  knownSkillNames,
  pathExists,
  queryParam,
  resolveWritableSkill,
  savedOf,
  toDetail,
  workspaceEntries,
  writeError,
  writeJson,
  writeRouteError,
  type RouteSpec,
  type SkillHubRouteDeps,
  type SkillLookupLike,
} from './routes/helpers.ts'
import {
  IMPORT_JOB_MAX,
  IMPORT_JOB_TTL_MS,
  MARKET_STATS_TTL_MS,
  MIN_CHECK_INTERVAL_MS,
  gcImportJobs,
  importJobs,
  lastMarketCheck,
  lastMarketStats,
  lastSourceCheck,
  marketStatsCache,
  replaceSkillDir,
  seedMarketStats,
  type ImportJob,
} from './routes/route-state.ts'

export type { SkillHubRouteDeps, SkillLookupLike } from './routes/helpers.ts'

/**
 * Build every /api/skill-hub route.
 * @param deps - skill registry view + sidecar store.
 * @returns the exact-path routes.
 */
export function makeRoutes(deps: SkillHubRouteDeps): WebRoute[] {
  /**
   * Wrap one handler in the shared request fences (loopback trust → method →
   * master switch → JSON body → unified error mapping).实现在 helpers.ts，
   * 这里只绑定 deps。
   */
  const route = (spec: RouteSpec): WebRoute => createRoute(deps, spec)

  return [
    // ------------------------------------------------------------ catalog
    route({
      path: SKILL_HUB_API.catalog,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const cwd = queryParam(url, 'cwd')
        writeJson(res, 200, await buildCatalog(deps, cwd))
      },
    }),
    // -------------------------------------------------------------- detail
    route({
      path: SKILL_HUB_API.skill,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const name = queryParam(url, 'name')
        if (name === undefined || name === '') { writeError(res, 400, 'name query parameter is required'); return }
        const cwd = queryParam(url, 'cwd')
        // 显式 cwd 只看该工作区；否则按已知工作区逐个查找（与目录默认视图
        // 一致），最后回退用户级根，保证默认视图里可见的项目技能能打开详情。
        let skill: SkillDefinition | undefined
        if (cwd !== undefined && cwd !== '') {
          skill = await deps.skills.get(name, { cwd })
        } else {
          for (const ws of await workspaceEntries(homeOf(deps))) {
            skill = await deps.skills.get(name, { cwd: ws.path })
            if (skill !== undefined) break
          }
          if (skill === undefined) skill = await deps.skills.get(name)
        }
        if (skill === undefined) {
          // Hub-disabled skills live outside registry discovery (renamed to .disabled);
          // serve their detail straight from the sidecar record + file.
          const record = await deps.store.getDisabled(name)
          if (record !== undefined) {
            try {
              const text = await readFile(record.path, 'utf8')
              const parsed = parseFrontmatter(text)
              if (!('error' in parsed)) {
                const disabledDetail: SkillDetail = {
                  name: record.name,
                  description: parsed.value.description,
                  ...(parsed.value.whenToUse !== undefined ? { whenToUse: parsed.value.whenToUse } : {}),
                  invocation: { ...parsed.value.invocation },
                  provider: 'skill-hub (disabled)',
                  path: record.path,
                  content: parsed.value.content,
                }
                try {
                  const times = await stat(record.path)
                  disabledDetail.addedAt = times.birthtimeMs
                  disabledDetail.updatedAt = times.mtimeMs
                } catch {
                  // ignore
                }
                writeJson(res, 200, { ok: true, skill: disabledDetail } satisfies SkillDetailResponse)
                return
              }
            } catch {
              // fall through to 404 below
            }
          }
          writeError(res, 404, 'skill not found: ' + name)
          return
        }
        const detail = toDetail(skill)
        if (skill.path !== undefined) {
          try {
            const times = await stat(skill.path)
            detail.addedAt = times.birthtimeMs
            detail.updatedAt = times.mtimeMs
          } catch {
            // 文件不可读时省略时间字段，详情页不显示这两行。
          }
          // UI metadata from agents/openai.yaml beside the skill directory (codex).
          try {
            const rb = skill.resourceBase as { kind?: string; path?: string } | undefined
            const dir = rb?.kind === 'directory' && typeof rb.path === 'string' ? rb.path : (skill.path.endsWith('SKILL.md') ? dirname(skill.path) : undefined)
            if (dir !== undefined) {
              const iface = await readSkillInterface(dir)
              if (iface !== undefined) {
                if (iface.displayName !== undefined) detail.displayName = iface.displayName
                if (iface.shortDescription !== undefined) detail.shortDescription = iface.shortDescription
                if (iface.brandColor !== undefined) detail.brandColor = iface.brandColor
                if (iface.iconSmall !== undefined) detail.iconSmall = iface.iconSmall
                if (iface.iconLarge !== undefined) detail.iconLarge = iface.iconLarge
                if (iface.defaultPrompt !== undefined) detail.defaultPrompt = iface.defaultPrompt
              }
            }
          } catch {
            // best-effort
          }
        }
        writeJson(res, 200, { ok: true, skill: detail } satisfies SkillDetailResponse)
      },
    }),
    // -------------------------------------------------------- skill/delete
    // 把单个技能（目录或平面文件）移入回收站（可恢复），并清理禁用记录、tag 成员与来源映射。
    route({
      path: SKILL_HUB_API.skillDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SkillDeleteRequest & { cwd?: string }
        const name = typeof request.name === 'string' ? request.name : ''
        if (name === '') { writeError(res, 400, 'name is required'); return }
        const resolved = await resolveWritableSkill(deps, name, typeof request.cwd === 'string' ? request.cwd : undefined)
        // 已禁用的技能不在 registry 中，resolve 会 404，这里单独处理：允许整组删除未开启的技能
        let trashResult: { path: string; source: string } | null = null
        if (!resolved.ok) {
          const disabled = await deps.store.getDisabled(name)
          if (disabled !== undefined) {
            // 禁用态：SKILL.md.disabled 或 *.md.disabled，直接将其所在技能整体移入回收站
            const isBundleDisabled = disabled.path.endsWith('SKILL.md.disabled')
            const sourceToTrash = isBundleDisabled ? dirname(disabled.path) : disabled.path
            const trashDir = join(dirname(sourceToTrash), '.trash')
            await mkdir(trashDir, { recursive: true })
            const target = join(trashDir, basename(sourceToTrash) + '-' + Date.now())
            await rename(sourceToTrash, target)
            trashResult = { path: target, source: sourceToTrash }
          } else {
            writeError(res, resolved.status, resolved.error); return
          }
        }
        // 入回收站前快照来源归属与场景成员：恢复时把它们加回来，否则恢复
        // 后的技能会丢失来源（变成「个人技能」）和场景分组。
        const tracked = await deps.store.getSourceForSkill(name)
        const tagIds = (await deps.store.listTags()).filter((tag) => tag.skillNames.includes(name)).map((tag) => tag.id)
        const { path, source } = trashResult ?? await trashSkill((resolved as { ok: true; path: string }).path)
        await deps.store.addTrash({
          name,
          path,
          movedAt: Date.now(),
          sourcePath: source,
          ...(tracked !== undefined
            ? { origin: { repo: tracked.repo, root: tracked.root, ...(tracked.ref !== undefined && tracked.ref !== '' ? { ref: tracked.ref } : {}), commitSha: tracked.commitSha } }
            : {}),
          ...(tagIds.length > 0 ? { tagIds } : {}),
        })
        await deps.store.removeDisabled(name)
        await deps.store.removeSkillFromSources(name)
        await deps.store.removeSkillFromTags(name)
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, name, path } satisfies SkillDeleteResponse)
      },
    }),
    // -------------------------------------------------------------- toggle
    route({
      path: SKILL_HUB_API.toggle,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as ToggleRequest & { cwd?: string }
        const name = typeof request.name === 'string' ? request.name : ''
        if (name === '') { writeError(res, 400, 'name is required'); return }
        const lookup = typeof request.cwd === 'string' && request.cwd !== '' ? { cwd: request.cwd } : undefined
        if (request.enabled === true) {
          const record = await deps.store.getDisabled(name)
          if (record === undefined) { writeError(res, 404, 'skill is not hub-disabled: ' + name); return }
          try {
            await enableSkill(record.path)
          } catch (error) {
            // The renamed file may have vanished (external cleanup); report
            // precisely instead of a generic 500, like toggle-batch does.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              writeError(res, 409, 'disabled skill file is missing on disk: ' + record.path)
              return
            }
            throw error
          }
          await deps.store.removeDisabled(name)
        } else {
          const resolved = await resolveWritableSkill(deps, name, typeof request.cwd === 'string' ? request.cwd : undefined)
          if (!resolved.ok) { writeError(res, resolved.status, resolved.error); return }
          const disabledPath = await disableSkill(resolved.path)
          await deps.store.addDisabled({
            name,
            description: resolved.skill.description,
            path: disabledPath,
            root: resolved.root,
            disabledAt: Date.now(),
          })
        }
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, catalog: await buildCatalog(deps, lookup?.cwd) } satisfies ToggleResponse)
      },
    }),
    // -------------------------------------------------------- toggle-batch
    // One write for a whole group: enables every hub-disabled name, or
    // disables every writable name. Skips already-target states as no-ops;
    // per-name failures are reported, never fatal.
    route({
      path: SKILL_HUB_API.toggleBatch,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as ToggleBatchRequest & { cwd?: string }
        const names = Array.isArray(request.names) ? request.names.filter((n): n is string => typeof n === 'string' && n !== '') : []
        if (names.length === 0) { writeError(res, 400, 'names must be a non-empty array'); return }
        const enabled = request.enabled === true
        const lookup = typeof request.cwd === 'string' && request.cwd !== '' ? { cwd: request.cwd } : undefined
        const failures: Array<{ name: string; error: string }> = []
        for (const name of names) {
          try {
            if (enabled) {
              const record = await deps.store.getDisabled(name)
              if (record === undefined) continue // already enabled: no-op
              await enableSkill(record.path)
              await deps.store.removeDisabled(name)
            } else {
              const resolved = await resolveWritableSkill(deps, name, typeof request.cwd === 'string' ? request.cwd : undefined)
              if (!resolved.ok) { failures.push({ name, error: resolved.error }); continue }
              const disabledPath = await disableSkill(resolved.path)
              await deps.store.addDisabled({ name, description: resolved.skill.description, path: disabledPath, root: resolved.root, disabledAt: Date.now() })
            }
          } catch (error) {
            failures.push({ name, error: error instanceof Error ? error.message : String(error) })
          }
        }
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, catalog: await buildCatalog(deps, lookup?.cwd), failures } satisfies ToggleBatchResponse)
      },
    }),
    // -------------------------------------------------------------- create
    route({
      path: SKILL_HUB_API.create,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as CreateRequest
        const name = typeof request.name === 'string' ? request.name.trim() : ''
        if (!isSkillName(name)) { writeError(res, 400, 'skill name must be kebab-case (lowercase letters, digits, dashes)'); return }
        const root: WritableRoot = request.root ?? 'user-dsh'
        if (root !== 'user-dsh' && root !== 'user-agents') { writeError(res, 400, 'root must be user-dsh or user-agents'); return }
        const existing = await deps.skills.get(name)
        if (existing !== undefined) { writeError(res, 409, 'skill name already exists: ' + name); return }
        if (await deps.store.getDisabled(name) !== undefined) { writeError(res, 409, 'skill name is disabled: re-enable it from the disabled list first'); return }
        // A directory may exist without producing a registry entry (invalid
        // frontmatter — exactly what the diagnostics section reports).
        // Refuse to overwrite it instead of silently truncating its SKILL.md.
        const target = join(rootPath(root, homeOf(deps)), name)
        if (await pathExists(target)) {
          writeError(res, 409, 'skill directory already exists on disk: ' + name + ' (check the discovery diagnostics)')
          return
        }
        const path = await createSkill(root, name, typeof request.description === 'string' ? request.description : '', homeOf(deps))
        // 新技能自动归入默认场景（「通用」）。
        const defaultTag = await deps.store.getDefaultTag()
        if (defaultTag !== undefined) await deps.store.addSkillToTag(defaultTag.id, name)
        deps.invalidate?.()
        writeJson(res, 201, { ok: true, path, root } satisfies CreateResponse)
      },
    }),
    // ---------------------------------------------------------------- stats
    route({
      path: SKILL_HUB_API.stats,
      methods: ['GET'],
      handler: async ({ res }) => {
        if (deps.stats === undefined) {
          writeJson(res, 200, { ok: true, available: false, stats: [] } satisfies import('./protocol.ts').StatsResponse)
          return
        }
        const stats = await deps.stats()
        writeJson(res, 200, { ok: true, available: true, stats } satisfies import('./protocol.ts').StatsResponse)
      },
    }),
    // --------------------------------------------------------------- config
    // The config route stays mounted even with the master switch off, so the
    // settings card can always read and re-enable the hub.
    route({
      path: SKILL_HUB_API.config,
      methods: ['GET', 'POST'],
      jsonBody: true,
      skipGate: true,
      handler: async ({ req, res, body }) => {
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, pluginVersion: CURRENT_VERSION, config: configOf(deps), saved: savedOf(deps) } satisfies ConfigResponse)
          return
        }
        const raw = body
        const patch: Partial<HubConfig> = {}
        if (raw.enabled !== undefined) {
          if (raw.enabled === null) patch.enabled = undefined
          else if (typeof raw.enabled !== 'boolean') { writeError(res, 400, 'enabled must be a boolean or null'); return }
          else patch.enabled = raw.enabled
        }
        if (raw.announceToAgent !== undefined) {
          if (raw.announceToAgent === null) patch.announceToAgent = undefined
          else if (typeof raw.announceToAgent !== 'boolean') { writeError(res, 400, 'announceToAgent must be a boolean or null'); return }
          else patch.announceToAgent = raw.announceToAgent
        }
        for (const key of ['showUseCount', 'showUseTime', 'showGroupSummary'] as const) {
          const value = raw[key]
          if (value === undefined) continue
          if (value === null) { patch[key] = undefined; continue }
          if (typeof value !== 'boolean') { writeError(res, 400, key + ' must be a boolean or null'); return }
          patch[key] = value
        }
        for (const key of ['dotModelColor', 'dotUserColor'] as const) {
          const value = raw[key]
          if (value === undefined) continue
          if (value === null) { patch[key] = undefined; continue }
          if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) { writeError(res, 400, key + ' must be a #rrggbb color or null'); return }
          patch[key] = value
        }
        if (raw.githubToken !== undefined) {
          const value = raw.githubToken
          if (value === null) { patch.githubToken = undefined; /* cleared → anonymous/env */ }
          else if (typeof value !== 'string' || value.trim() === '') { patch.githubToken = undefined }
          else if (!GITHUB_TOKEN_RE.test(value.trim())) { writeError(res, 400, 'githubToken looks invalid (expected a personal access token)'); return }
          else patch.githubToken = value.trim()
        }
        let config: HubConfig
        if (deps.updateConfig === undefined) {
          const merged: HubConfig = { ...configOf(deps) }
          for (const [key, value] of Object.entries(patch) as Array<[keyof HubConfig, boolean | string | undefined]>) {
            if (value === undefined) delete merged[key]
            else (merged as unknown as Record<string, unknown>)[key] = value
          }
          config = merged
        } else {
          config = await deps.updateConfig(patch)
        }
        writeJson(res, 200, { ok: true, pluginVersion: CURRENT_VERSION, config, saved: savedOf(deps) } satisfies ConfigResponse)
      },
    }),
    // --------------------------------------------------------------- market
    // Market sources: the user adds repo slugs; each source can
    // be scanned through /repo and imported through /repo/import.
    route({
      path: SKILL_HUB_API.market,
      methods: ['GET'],
      handler: async ({ res }) => {
        writeJson(res, 200, { ok: true, repos: await deps.store.listMarketSources() } satisfies MarketSourcesResponse)
      },
    }),
    route({
      path: SKILL_HUB_API.marketSource,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as MarketSourceRequest
        const input = typeof request.repo === 'string' ? request.repo.trim() : ''
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        // An explicit @ref pins the source immediately (e.g. repo@v1.2.3);
        // otherwise the first scan resolves latest-release / branch choice.
        const ref = parsed.ref !== undefined ? parsed.ref : undefined
        writeJson(res, 200, { ok: true, repos: await deps.store.addMarketSource(repoSlug(parsed), ref) } satisfies MarketSourceResponse)
      },
    }),
    route({
      path: SKILL_HUB_API.marketSourceDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as MarketSourceRequest
        const input = typeof request.repo === 'string' ? request.repo.trim() : ''
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        writeJson(res, 200, { ok: true, repos: await deps.store.removeMarketSource(repoSlug(parsed)) } satisfies MarketSourceResponse)
      },
    }),
    // ------------------------------------------------------- market/source/ref
    // Pin a market source to an explicit ref (branch chosen after a scan
    // found no release, or a user-specified tag).
    route({
      path: SKILL_HUB_API.marketSourceRef,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as MarketSourceRefRequest
        const parsed = normalizeRepoInput(typeof request.repo === 'string' ? request.repo : '')
        const ref = typeof request.ref === 'string' ? request.ref.trim() : ''
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        if (ref === '') { writeError(res, 400, 'ref is required'); return }
        const record = await deps.store.setMarketSourceRef(repoSlug(parsed), ref)
        if (record === undefined) { writeError(res, 404, 'market source not found: ' + repoSlug(parsed)); return }
        writeJson(res, 200, { ok: true, repos: await deps.store.listMarketSources() } satisfies MarketSourceResponse)
      },
    }),
    // -------------------------------------------- market/source/versions
    // Version picker data: release tags + branch names for one market source.
    route({
      path: SKILL_HUB_API.marketSourceVersions,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const input = queryParam(url, 'repo') ?? ''
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        const source = await deps.store.getMarketSource(repo)
        if (source === undefined) { writeError(res, 404, 'market source not found: ' + repo); return }
        const [releases, branches] = await Promise.all([listRepoReleases(repo), listRepoBranches(repo)])
        writeJson(res, 200, {
          ok: true,
          repo,
          ...(source.ref !== undefined && source.ref !== '' ? { current: source.ref } : {}),
          releases,
          branches,
        } satisfies MarketSourceVersionsResponse)
      },
    }),
    // ------------------------------------------------------- market/check
    // Update check over every market source: compares the pinned ref's
    // commit against the recorded baseline and surfaces newer releases.
    // 5-minute throttle mirrors the source check.
    route({
      path: SKILL_HUB_API.marketCheck,
      methods: ['GET'],
      handler: async ({ res }) => {
        const sources = await deps.store.listMarketSources()
        if (lastMarketCheck.size > 500) lastMarketCheck.clear()
        const results: MarketCheckResponse['results'] = []
        for (const source of sources) {
          const base = { repo: source.repo, ...(source.ref !== undefined ? { ref: source.ref } : {}) }
          const now = Date.now()
          const last = lastMarketCheck.get(source.repo) ?? 0
          if (now - last < MIN_CHECK_INTERVAL_MS) {
            results.push({ ...base, updateAvailable: false, commitSha: source.commitSha ?? '', throttled: true })
            continue
          }
          try {
            const latestTag = await getLatestReleaseTag(source.repo)
            if (source.ref === undefined) {
              // Not pinned yet: report the latest release so the UI can
              // suggest pinning, but never claim an update.
              results.push({ ...base, updateAvailable: false, commitSha: source.commitSha ?? '', ...(latestTag !== undefined ? { latestTag } : {}) })
              continue
            }
            const latest = await getLatestCommit(source.repo, source.ref)
            lastMarketCheck.set(source.repo, now)
            const commitMoved = source.commitSha !== undefined && latest.commitSha !== source.commitSha
            const newRelease = latestTag !== undefined && latestTag !== source.ref
            results.push({ ...base, updateAvailable: commitMoved || newRelease, commitSha: latest.commitSha, ...(newRelease ? { latestTag } : {}) })
          } catch (error) {
            results.push({ ...base, updateAvailable: false, commitSha: source.commitSha ?? '', error: error instanceof Error ? error.message : String(error) })
          }
        }
        writeJson(res, 200, { ok: true, results } satisfies MarketCheckResponse)
      },
    }),
    // ------------------------------------------------------- market/stats
    // Stars + release-asset downloads per market source. Stale-while-revalidate:
    // the base call always answers from cache instantly (stale-flagged past the
    // hourly TTL); `?refresh=1` refetches stale entries in that same round.
    // Numbers barely move within a session, and each repo costs two GitHub requests.
    route({
      path: SKILL_HUB_API.marketStats,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const refresh = queryParam(url, 'refresh') === '1'
        await seedMarketStats(deps)
        const sources = await deps.store.listMarketSources()
        if (lastMarketStats.size > 500) lastMarketStats.clear()
        const results: MarketStatsResponse['results'] = []
        const now = Date.now()
        let fetchedAny = false
        for (const source of sources) {
          const cached = marketStatsCache.get(source.repo)
          const age = now - (lastMarketStats.get(source.repo) ?? 0)
          if (cached !== undefined && (!refresh || age < MARKET_STATS_TTL_MS)) {
            results.push({
              repo: source.repo,
              stars: cached.stars,
              downloads: cached.downloads,
              ...(age >= MARKET_STATS_TTL_MS ? { stale: true } : refresh ? { throttled: true } : {}),
            })
            continue
          }
          try {
            const stats = await getRepoStats(source.repo)
            marketStatsCache.set(source.repo, stats)
            lastMarketStats.set(source.repo, now)
            fetchedAny = true
            results.push({ repo: source.repo, ...stats })
          } catch (error) {
            if (cached !== undefined) {
              results.push({ repo: source.repo, stars: cached.stars, downloads: cached.downloads, stale: true })
            } else {
              results.push({ repo: source.repo, stars: 0, downloads: 0, error: error instanceof Error ? error.message : String(error) })
            }
          }
        }
        if (fetchedAny) {
          // Persist the fresh snapshot so a restart still shows numbers instantly.
          void deps.store.saveMarketStatsState({
            fetchedAt: now,
            stats: Object.fromEntries(marketStatsCache),
          }).catch(() => { /* best-effort; memory cache already updated */ })
        }
        writeJson(res, 200, { ok: true, results } satisfies MarketStatsResponse)
      },
    }),
    // ------------------------------------------------------- market/source/sync
    // Align a market source to its version: resolve the pinned ref (or pick
    // the latest release when unpinned), record the commit, and propagate the
    // ref to the matching tracked source record so source checks/syncs follow
    // it. Returns the local skills tracked from this repo so the UI can offer
    // a batch update.
    route({
      path: SKILL_HUB_API.marketSync,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as MarketSourceRefRequest
        const parsed = normalizeRepoInput(typeof request.repo === 'string' ? request.repo : '')
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        const source = await deps.store.getMarketSource(repo)
        if (source === undefined) { writeError(res, 404, 'market source not found: ' + repo); return }
        // Resolve the ref: pinned ref wins; otherwise auto-adopt the latest
        // release; a repo without releases must be pinned via the branch picker first.
        let ref = source.ref
        if (ref === undefined || ref === '') {
          const latestTag = await getLatestReleaseTag(repo)
          if (latestTag === undefined) { writeError(res, 409, 'repo has no release — pick a branch first'); return }
          ref = latestTag
          await deps.store.setMarketSourceRef(repo, ref)
        }
        const latest = await getLatestCommit(repo, ref)
        await deps.store.setMarketSourceCommit(repo, latest.commitSha)
        // Propagate the ref to the tracked source record so checks follow it.
        await deps.store.setSourceRef(repo, ref)
        const tracked = await deps.store.getSource(repo)
        writeJson(res, 200, {
          ok: true,
          repo,
          ref,
          commitSha: latest.commitSha,
          skills: tracked !== undefined ? [...tracked.skills] : [],
        } satisfies MarketSyncResponse)
      },
    }),
    // ---------------------------------------------------------------- repo
    // Discover importable skills in a public GitHub repo (any top-level root containing SKILL.md).
    route({
      path: SKILL_HUB_API.repo,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const input = queryParam(url, 'repo') ?? ''
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        // Version resolution: explicit @ref wins; then the market source's
        // pinned ref (branch picked earlier); then the latest release;
        // a repo without releases must be pinned to a branch by the user
        // (branches returned, ref null).
        let ref = parsed.ref
        if (ref === undefined || ref === '') {
          const pinned = await deps.store.getMarketSource(repo)
          if (pinned?.ref !== undefined && pinned.ref !== '') {
            ref = pinned.ref
          }
        }
        if (ref === undefined || ref === '') {
          const releaseTag = await getLatestReleaseTag(repo)
          if (releaseTag !== undefined) {
            ref = releaseTag
            // Auto-pin an existing but unpinned market source to the resolved
            // release, so the row shows the tracked version from the first scan.
            const existing = await deps.store.getMarketSource(repo)
            if (existing !== undefined && (existing.ref === undefined || existing.ref === '')) {
              await deps.store.setMarketSourceRef(repo, releaseTag)
            }
          } else {
            const branches = await listRepoBranches(repo)
            if (branches.length === 0) { writeError(res, 404, 'repo has no branches to scan'); return }
            writeJson(res, 200, { ok: true, repo, ref: null, branches, entries: [] } satisfies RepoDiscoverResponse)
            return
          }
        }
        const { ref: resolvedRef, tree, truncated } = await loadRepoTree(repo, ref)
        const existing = await knownSkillNames(deps)
        const entries = discoverRepoEntries(tree, repo, existing)
        writeJson(res, 200, { ok: true, repo, ref: resolvedRef, entries, ...(truncated ? { truncated: true } : {}) } satisfies RepoDiscoverResponse)
      },
    }),
    // ----------------------------------------------------------- repo/import  B方案 Job
    // Install selected repo skills — now async job (B方案：轮询 + 选项2后台继续)
    // POST returns jobId instantly (<500ms), GET /progress polls for done.
    route({
      path: SKILL_HUB_API.repoImport,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as RepoImportRequest
        const input = typeof request.repo === 'string' ? request.repo.trim() : ''
        const paths = Array.isArray(request.paths) ? request.paths.filter((path): path is string => typeof path === 'string' && path !== '') : []
        if (paths.length === 0) { writeError(res, 400, 'paths must be a non-empty array'); return }
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        const ref = typeof request.ref === 'string' && request.ref !== '' ? request.ref : parsed.ref
        const { ref: resolvedRef, tree } = await loadRepoTree(repo, ref)
        const existing = await knownSkillNames(deps)
        const entries = discoverRepoEntries(tree, repo, existing)
        // truncated tree is still usable for the selected paths the user already picked from the prior discover response
        const byPath = new Map(entries.map((entry) => [entry.path, entry]))
        const selected = paths.map((path) => byPath.get(path)).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        if (selected.length === 0) { writeError(res, 400, 'no matching skills for selected paths'); return }
        if (selected.length > 500) { writeError(res, 400, 'select at most 500 skills per import'); return }
        const totalBytes = selected.reduce((sum, entry) => sum + entry.totalBytes, 0)
        if (totalBytes > 200 * 1024 * 1024) { writeError(res, 400, 'selected skills exceed the 200MB import limit'); return }

        let commitSha = ''
        try {
          const latest = await getLatestCommit(repo, resolvedRef)
          commitSha = latest.commitSha
        } catch {
          // empty snapshot ok
        }

        const jobId = 'imp_' + randomUUID().slice(0, 8)
        const controller = new AbortController()
        const now = Date.now()
        const job: ImportJob = {
          jobId,
          repo,
          ref: resolvedRef,
          total: selected.length,
          done: 0,
          totalBytes,
          downloadedBytes: 0,
          startTime: now,
          imported: [],
          skipped: [],
          failed: [],
          status: 'running',
          controller,
          createdAt: now,
        }
        gcImportJobs()
        importJobs.set(jobId, job)

        // 启动时顺手清理一次残留临时目录（best-effort，不阻塞响应）
        const targetRootEarly = rootPath('user-dsh', homeOf(deps))
        void cleanupLeftoverImportDirs(targetRootEarly).catch(() => {})

        // 后台执行，不阻塞响应（选项2：关面板也继续跑，唯有 /cancel 才 abort）
        void (async () => {
          const targetRoot = rootPath('user-dsh', homeOf(deps))
          await mkdir(targetRoot, { recursive: true })
          const defaultTag = await deps.store.getDefaultTag()
          let needInvalidate = false
          for (const entry of selected) {
            if (controller.signal.aborted) break
            job.current = entry.name
            job.currentFile = entry.dir + '/SKILL.md'
            if (entry.existing) {
              job.skipped.push({ name: entry.name, reason: 'exists' })
              job.downloadedBytes += entry.totalBytes
              job.done += 1
              continue
            }
            if (await pathExists(join(targetRoot, entry.name))) {
              job.skipped.push({ name: entry.name, reason: 'exists' })
              job.downloadedBytes += entry.totalBytes
              job.done += 1
              continue
            }
            if (controller.signal.aborted) break
            const files = collectRepoSkillFiles(tree, entry.dir)
            try {
              const result = await downloadRepoSkill(repo, resolvedRef, entry, files, targetRoot, fetch, controller.signal, (bytes, file) => {
                job.downloadedBytes += bytes
                job.currentFile = entry.dir + '/' + file
              })
              await deps.store.addSourceSkill(repo, entry.root, commitSha, resolvedRef, entry.name)
              await deps.store.mergeSourceManifest(repo, skillManifest(tree, entry.dir), entry.dir)
              if (defaultTag !== undefined) await deps.store.addSkillToTag(defaultTag.id, entry.name)
              job.imported.push({ name: entry.name, origin: entry.origin, path: result.skillPath })
              needInvalidate = true
            } catch (error) {
              if (isAbortError(error) || controller.signal.aborted) {
                // 取消时不记为 failed，保留已完成的 imported/skipped，直接跳出
                break
              }
              job.failed.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) })
            } finally {
              job.done += 1
            }
          }
          if (controller.signal.aborted) {
            job.status = 'cancelled'
            job.current = undefined
            job.currentFile = undefined
          } else {
            job.status = 'done'
            job.current = undefined
            job.currentFile = undefined
            // 确保字节进度最终对齐（避免浮点/并发尾差）
            job.downloadedBytes = job.totalBytes
          }
          if (needInvalidate) deps.invalidate?.()
        })().catch((error) => {
          job.status = 'error'
          job.error = error instanceof Error ? error.message : String(error)
          job.current = undefined
          job.currentFile = undefined
        })

        writeJson(res, 200, { ok: true, jobId, total: selected.length, totalBytes } satisfies RepoImportResponse)
      },
    }),
    // 进度轮询（含字节级进度和速度）
    route({
      path: SKILL_HUB_API.repoImportProgress,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const jobId = queryParam(url, 'jobId') ?? ''
        if (jobId === '') { writeError(res, 400, 'jobId is required'); return }
        const job = importJobs.get(jobId)
        if (job === undefined) { writeError(res, 404, 'import job not found: ' + jobId); return }
        const elapsedSec = Math.max(0.5, (Date.now() - job.startTime) / 1000)
        const bytesPerSecond = job.status === 'running' ? Math.round(job.downloadedBytes / elapsedSec) : undefined
        writeJson(res, 200, {
          ok: true,
          jobId: job.jobId,
          status: job.status,
          total: job.total,
          done: job.done,
          ...(job.current !== undefined ? { current: job.current } : {}),
          ...(job.currentFile !== undefined ? { currentFile: job.currentFile } : {}),
          totalBytes: job.totalBytes,
          downloadedBytes: job.downloadedBytes,
          ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
          imported: [...job.imported],
          skipped: [...job.skipped],
          failed: [...job.failed],
          ...(job.error !== undefined ? { error: job.error } : {}),
        } satisfies RepoImportProgressResponse)
      },
    }),
    // 取消任务（选项2：唯有点取消才停）
    route({
      path: SKILL_HUB_API.repoImportCancel,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as RepoImportCancelRequest
        const jobId = typeof request.jobId === 'string' ? request.jobId : ''
        if (jobId === '') { writeError(res, 400, 'jobId is required'); return }
        const job = importJobs.get(jobId)
        if (job === undefined) { writeError(res, 404, 'import job not found: ' + jobId); return }
        if (job.status === 'running') {
          job.controller.abort()
          job.status = 'cancelled'
        }
        writeJson(res, 200, { ok: true, jobId: job.jobId, status: job.status as 'cancelled' | 'done' } satisfies RepoImportCancelResponse)
      },
    }),
    // -------------------------------------------------------------- update
    // 自身更新检查：查询 GitHub latest release。
    route({
      path: SKILL_HUB_API.update,
      methods: ['GET'],
      handler: async ({ res }) => {
        writeJson(res, 200, await checkLatestRelease())
      },
    }),
    // -------------------------------------------------------------- groups
    // 用户 tag 分组 + 系统集合组 + origin 映射（前端分组栏的数据源）。
    route({
      path: SKILL_HUB_API.groups,
      methods: ['GET'],
      handler: async ({ res }) => {
        writeJson(res, 200, await buildGroups(deps))
      },
    }),
    // ----------------------------------------------------------------- tag
    // 新建（缺省 id）或重命名（带 id）一个用户 tag 分组。
    route({
      path: SKILL_HUB_API.tag,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '') { writeError(res, 400, 'tag name is required'); return }
        const id = typeof body.id === 'string' && body.id !== '' ? body.id : undefined
        await deps.store.saveTag({ id, name })
        writeJson(res, 200, { ok: true, tags: await deps.store.listTags() } satisfies TagSaveResponse)
      },
    }),
    // ----------------------------------------------------------- tag/delete
    route({
      path: SKILL_HUB_API.tagDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const id = typeof (body as unknown as TagDeleteRequest).id === 'string' ? (body as unknown as TagDeleteRequest).id : ''
        if (id === '') { writeError(res, 400, 'tag id is required'); return }
        const tag = await deps.store.getTag(id)
        if (tag?.default === true) { writeError(res, 409, 'the default scene cannot be deleted'); return }
        await deps.store.deleteTag(id)
        writeJson(res, 200, { ok: true, tags: await deps.store.listTags() } satisfies TagDeleteResponse)
      },
    }),
    // ---------------------------------------------------------- tag/members
    // 直接设置某 tag 的完整成员列表；后端只保留目录中实际存在的技能名。
    route({
      path: SKILL_HUB_API.tagMembers,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as TagMembersRequest
        const id = typeof request.id === 'string' ? request.id : ''
        if (id === '') { writeError(res, 400, 'tag id is required'); return }
        const names = Array.isArray(request.skillNames) ? request.skillNames.filter((n): n is string => typeof n === 'string') : []
        const known = await knownSkillNames(deps)
        const saved = await deps.store.setTagMembers(id, names.filter((n) => known.has(n)))
        if (saved === undefined) { writeError(res, 404, 'tag not found: ' + id); return }
        writeJson(res, 200, { ok: true, tags: await deps.store.listTags() } satisfies TagMembersResponse)
      },
    }),
    // ---------------------------------------------------------- tag/reorder
    // 拖拽重排场景分组顺序
    route({
      path: SKILL_HUB_API.tagReorder,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as TagReorderRequest
        const orderedIds = Array.isArray(request.orderedIds) ? request.orderedIds.filter((id): id is string => typeof id === 'string' && id !== '') : []
        try {
          const tags = await deps.store.reorderTags(orderedIds)
          writeJson(res, 200, { ok: true, tags } satisfies TagReorderResponse)
        } catch (error) {
          if (error instanceof StoreError) { writeError(res, error.kind === 'validation' ? 400 : error.kind === 'not-found' ? 404 : 409, error.message); return }
          throw error
        }
      },
    }),
    // ------------------------------------------------- collection/reorder
    // 拖拽重排来源集合顺序
    route({
      path: SKILL_HUB_API.collectionReorder,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as CollectionReorderRequest
        const orderedNames = Array.isArray(request.orderedNames) ? request.orderedNames.filter((n): n is string => typeof n === 'string' && n !== '') : []
        const order = await deps.store.reorderCollections(orderedNames)
        const groups = await buildGroups(deps)
        writeJson(res, 200, { ok: true, collections: groups.collections, order } satisfies CollectionReorderResponse)
      },
    }),
    // ------------------------------------------------ source-group/reorder
    // 拖拽重排来源顶层分组（project / collections / personal 统一顺序）
    route({
      path: SKILL_HUB_API.sourceGroupReorder,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceGroupReorderRequest
        const orderedKeys = Array.isArray(request.orderedKeys) ? request.orderedKeys.filter((k): k is string => typeof k === 'string' && k !== '') : []
        const order = await deps.store.reorderSourceGroups(orderedKeys)
        writeJson(res, 200, { ok: true, order } satisfies SourceGroupReorderResponse)
      },
    }),
    // ------------------------------------------------------------- sources
    // 来源列表 + 派生 origin 映射 + 集合组 + 回收站。
    route({
      path: SKILL_HUB_API.sources,
      methods: ['GET'],
      handler: async ({ res }) => {
        const [sources, origins, trash, collectionOrder] = await Promise.all([deps.store.listSources(), deps.store.listOrigins(), deps.store.listTrash(), deps.store.getCollectionOrder()])
        const byCollection = new Map<string, string[]>()
        for (const [skillName, origin] of Object.entries(origins)) {
          const list = byCollection.get(origin)
          if (list === undefined) byCollection.set(origin, [skillName])
          else list.push(skillName)
        }
        const orderIndex = new Map(collectionOrder.map((name, i) => [name, i] as const))
        const collections: CollectionGroup[] = [...byCollection.entries()]
          .map(([name, skillNames]) => ({ name, skillNames: [...skillNames].sort((a, b) => a.localeCompare(b)) }))
          .sort((a, b) => {
            const ai = orderIndex.has(a.name) ? orderIndex.get(a.name)! : Infinity
            const bi = orderIndex.has(b.name) ? orderIndex.get(b.name)! : Infinity
            if (ai !== bi) return ai - bi
            return a.name.localeCompare(b.name)
          })
        writeJson(res, 200, { ok: true, sources, origins, collections, trash } satisfies SourcesResponse)
      },
    }),
    // -------------------------------------------------------- sources/check
    // 检查指定（或全部）来源的上游更新。每个来源最多 1 次 commit 请求；
    // 仅当 commit 变化时再拉一次 tree 做逐技能差异。5 分钟节流。
    route({
      path: SKILL_HUB_API.sourceCheck,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceCheckRequest
        let only: string | undefined
        if (typeof request.repo === 'string' && request.repo !== '') {
          // Normalize URLs/slugs the same way every other route does, so a
          // check for "https://github.com/a/b" finds the "a/b" record.
          const parsedOnly = normalizeRepoInput(request.repo)
          only = parsedOnly !== null ? repoSlug(parsedOnly) : undefined
        }
        const source = only !== undefined ? await deps.store.getSource(only) : undefined
        if (only !== undefined && source === undefined) { writeError(res, 404, 'source not found: ' + only); return }
        const sources = source !== undefined ? [source] : await deps.store.listSources()
        if (lastSourceCheck.size > 500) lastSourceCheck.clear()
        const results: SourceCheckResult[] = []
        for (const item of sources) {
          const base = { repo: item.repo, ...(item.ref !== undefined ? { ref: item.ref } : {}) }
          const now = Date.now()
          const last = lastSourceCheck.get(item.repo) ?? 0
          if (now - last < MIN_CHECK_INTERVAL_MS) {
            results.push({ ...base, changed: false, updated: [], deleted: [], throttled: true })
            continue
          }
          try {
            const latest = await getLatestCommit(item.repo, item.ref)
            lastSourceCheck.set(item.repo, now)
            if (item.commitSha === '') {
              // Migrated/legacy record without a snapshot: backfill the
              // commit now and report "unverified" instead of claiming every
              // skill is updated (there is no baseline to diff against yet).
              await deps.store.setSourceCommit(item.repo, latest.commitSha)
              results.push({ ...base, changed: false, updated: [], deleted: [], unverified: true, commitSha: latest.commitSha })
              continue
            }
            if (latest.commitSha === item.commitSha) {
              results.push({ ...base, changed: false, updated: [], deleted: [] })
              continue
            }
            const tree = await loadRepoTreeAt(item.repo, latest.treeSha)
            const diff = diffRemoteSkills(tree, item)
            results.push({ ...base, changed: true, commitSha: latest.commitSha, updated: diff.updated, deleted: diff.deleted })
          } catch (error) {
            results.push({ ...base, changed: false, updated: [], deleted: [], error: error instanceof Error ? error.message : String(error) })
          }
        }
        writeJson(res, 200, { ok: true, results } satisfies SourceCheckResponse)
      },
    }),
    // --------------------------------------------------------- sources/sync
    // 按上游重新下载所选（或全部）技能并更新 commit 快照与 manifest。
    route({
      path: SKILL_HUB_API.sourceSync,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceSyncRequest
        const repo = typeof request.repo === 'string' ? request.repo.trim() : ''
        if (repo === '') { writeError(res, 400, 'repo is required'); return }
        const selected = Array.isArray(request.skills) ? request.skills.filter((n): n is string => typeof n === 'string' && n !== '') : undefined
        const source = await deps.store.getSource(repo)
        if (source === undefined) { writeError(res, 404, 'source not found: ' + repo); return }
        const targets = selected !== undefined ? selected : source.skills
        const latest = await getLatestCommit(repo, source.ref)
        const tree = await loadRepoTreeAt(repo, latest.treeSha)
        const targetRoot = rootPath('user-dsh', homeOf(deps))
        await mkdir(targetRoot, { recursive: true })
        const synced: string[] = []
        const failed: Array<{ name: string; error: string }> = []
        for (const name of targets) {
          // Sync writes under the user root: only accept real skill names
          // this source actually tracks (a bare join would otherwise fold
          // `..` segments out of the writable root).
          if (!isSkillName(name) || !source.skills.includes(name)) {
            failed.push({ name, error: 'skill is not tracked by this source' })
            continue
          }
          try {
            const entry = repoSkillEntry(name, source.root, repo)
            // 上游可能用分类子目录（skills/engineering/<name>/）且目录会移动：
            // 先在上游 tree 里搜真实位置，manifest 兜底，否则嵌套技能会 404。
            entry.dir = skillDirOf(source, name, tree.map((item) => item.path))
            entry.path = entry.dir + '/SKILL.md'
            const files = collectRepoSkillFiles(tree, entry.dir)
            if (files.length === 0) { failed.push({ name, error: 'skill missing upstream' }); continue }
            const targetDir = join(targetRoot, name)
            const wasDisabled = (await deps.store.getDisabled(name)) !== undefined
            if (await pathExists(targetDir)) {
              await replaceSkillDir(targetDir, async () => {
                await downloadRepoSkill(repo, latest.commitSha, entry, files, targetRoot)
              })
            } else {
              await downloadRepoSkill(repo, latest.commitSha, entry, files, targetRoot)
            }
            if (wasDisabled) {
              // Preserve the disabled state: the fresh SKILL.md must not
              // re-enter discovery.
              await rename(join(targetDir, 'SKILL.md'), join(targetDir, 'SKILL.md.disabled'))
            } else {
              await deps.store.removeDisabled(name)
            }
            await deps.store.mergeSourceManifest(repo, skillManifest(tree, entry.dir), entry.dir)
            synced.push(name)
          } catch (error) {
            failed.push({ name, error: error instanceof Error ? error.message : String(error) })
          }
        }
        // Only advance the commit snapshot when every skill landed: a failed
        // sync keeps the old commit, so the next check still diffs the tree
        // and re-reports the missing skills instead of silently hiding them.
        if (failed.length === 0) {
          await deps.store.setSourceCommit(repo, latest.commitSha)
        }
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, repo, commitSha: latest.commitSha, synced, failed } satisfies SourceSyncResponse)
      },
    }),
    // ------------------------------------------------------- sources/delete
    // 跟进上游删除：把所选技能的本地目录移入回收站（可恢复）。
    route({
      path: SKILL_HUB_API.sourceDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceDeleteRequest
        const repo = typeof request.repo === 'string' ? request.repo.trim() : ''
        const skills = Array.isArray(request.skills) ? request.skills.filter((n): n is string => typeof n === 'string' && n !== '') : []
        if (repo === '') { writeError(res, 400, 'repo is required'); return }
        if (skills.length === 0) { writeError(res, 400, 'skills must be a non-empty array'); return }
        const source = await deps.store.getSource(repo)
        if (source === undefined) { writeError(res, 404, 'source not found: ' + repo); return }
        const home = homeOf(deps)
        const trashed: string[] = []
        const failed: Array<{ name: string; error: string }> = []
        const sourceNames = new Set(source.skills)
        for (const name of skills) {
          // Every name must be a real kebab-case skill that this source
          // actually tracks; anything else must never touch the filesystem
          // (a bare `join` would otherwise fold `..` segments out of the
          // writable root — see the path-containment assert below).
          if (!isSkillName(name) || !sourceNames.has(name)) {
            failed.push({ name, error: 'skill is not tracked by this source' })
            continue
          }
          const sourcePath = join(rootPath('user-dsh', home), name)
          if (rootOfPath(sourcePath, home) === undefined) {
            failed.push({ name, error: 'skill path is outside the hub writable roots' })
            continue
          }
          if (!await pathExists(sourcePath)) {
            failed.push({ name, error: 'skill directory not found' })
            continue
          }
          try {
            // 入回收站前快照来源与场景归属，恢复时挂回（见 sourceRestore）。
            const tagIds = (await deps.store.listTags()).filter((tag) => tag.skillNames.includes(name)).map((tag) => tag.id)
            const { path } = await trashSkill(sourcePath)
            await deps.store.addTrash({
              name,
              path,
              movedAt: Date.now(),
              sourcePath,
              origin: { repo: source.repo, root: source.root, ...(source.ref !== undefined && source.ref !== '' ? { ref: source.ref } : {}), commitSha: source.commitSha },
              ...(tagIds.length > 0 ? { tagIds } : {}),
            })
            await deps.store.removeDisabled(name)
            await deps.store.removeSkillFromTags(name)
            trashed.push(name)
          } catch (error) {
            failed.push({ name, error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (trashed.length > 0) {
          await deps.store.setSourceSkills(repo, source.skills.filter((n) => !trashed.includes(n)))
          deps.invalidate?.()
        }
        writeJson(res, 200, { ok: true, trashed, failed } satisfies SourceDeleteResponse)
      },
    }),
    // ------------------------------------------------------ sources/restore
    // 从回收站恢复一个技能目录。
    route({
      path: SKILL_HUB_API.sourceRestore,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceRestoreRequest
        const name = typeof request.name === 'string' ? request.name : ''
        if (name === '') { writeError(res, 400, 'name is required'); return }
        const entry = await deps.store.getTrash(name)
        if (entry === undefined) { writeError(res, 404, 'trash entry not found: ' + name); return }
        const home = homeOf(deps)
        const target = entry.sourcePath ?? join(rootPath('user-dsh', home), name)
        if (await pathExists(target)) {
          writeError(res, 409, 'skill already exists: ' + name)
          return
        }
        const path = await restoreSkill(entry, home)
        // 恢复来源归属（入回收站前快照的来源记录）与场景成员，否则恢复后
        // 的技能会变成「个人技能」并脱离原场景。
        if (entry.origin !== undefined) {
          await deps.store.addSourceSkill(entry.origin.repo, entry.origin.root, entry.origin.commitSha, entry.origin.ref, name)
        }
        for (const tagId of entry.tagIds ?? []) {
          await deps.store.addSkillToTag(tagId, name)
        }
        await deps.store.removeTrash(name)
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, name, path } satisfies SourceRestoreResponse)
      },
    }),
    // ------------------------------------------------- sources/trash/clear
    // 清空回收站：永久删除 .trash 里的技能，失败项保留可重试。
    route({
      path: SKILL_HUB_API.sourceTrashClear,
      methods: ['POST'],
      handler: async ({ res }) => {
        const home = homeOf(deps)
        const entries = await deps.store.listTrash()
        const deleted: string[] = []
        const failed: Array<{ name: string; error: string }> = []
        for (const entry of entries) {
          try {
            await clearTrash(entry, home)
            // A permanently deleted skill must not linger in user groups.
            await deps.store.removeSkillFromTags(entry.name)
            deleted.push(entry.name)
          } catch (error) {
            failed.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) })
          }
        }
        for (const name of deleted) await deps.store.removeTrash(name)
        if (deleted.length > 0) deps.invalidate?.()
        writeJson(res, 200, { ok: true, deleted, failed } satisfies SourceTrashClearResponse)
      },
    }),
    // -------------------------------------------------------- diagnostic fix
    route({
      path: SKILL_HUB_API.diagnosticFix,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as DiagnosticFixRequest
        const rawPath = typeof request.path === 'string' ? request.path.trim() : ''
        if (rawPath === '') { writeError(res, 400, 'path is required'); return }
        try {
          await fixDiagnosticFile(rawPath, homeOf(deps))
          deps.invalidate?.()
          writeJson(res, 200, { ok: true, path: rawPath } satisfies DiagnosticFixResponse)
        } catch (error) {
          writeRouteError(res, error)
        }
      },
    }),
  ]
}
