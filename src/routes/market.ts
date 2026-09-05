/**
 * 市场域路由：market 列表 / source 增删 / ref 锁定 / versions 选择器 /
 * check 更新检查 / stats 星标统计 / sync 对齐版本。从 routes.ts 原样搬出，
 * handler 逻辑不变。
 */

import {
  SKILL_HUB_API,
  type MarketCheckResponse,
  type MarketSourceRefRequest,
  type MarketSourceRequest,
  type MarketSourceResponse,
  type MarketSourcesResponse,
  type MarketSourceVersionsResponse,
  type MarketStatsResponse,
  type MarketSyncResponse,
} from '../protocol.ts'
import {
  getLatestCommit,
  getLatestReleaseTag,
  getRepoStats,
  listRepoBranches,
  listRepoReleases,
  normalizeRepoInput,
  repoSlug,
} from '../repo.ts'
import {
  queryParam,
  writeError,
  writeJson,
  type RouteSpec,
  type SkillHubRouteDeps,
} from './helpers.ts'
import {
  MARKET_STATS_TTL_MS,
  MIN_CHECK_INTERVAL_MS,
  lastMarketCheck,
  lastMarketStats,
  marketStatsCache,
  seedMarketStats,
} from './route-state.ts'

/** 市场域全部路由 spec（由 routes.ts 经 createRoute 包上统一围栏）。 */
export function marketRoutes(deps: SkillHubRouteDeps): RouteSpec[] {
  return [
    // --------------------------------------------------------------- market
    // Market sources: the user adds repo slugs; each source can
    // be scanned through /repo and imported through /repo/import.
    {
      path: SKILL_HUB_API.market,
      methods: ['GET'],
      handler: async ({ res }) => {
        writeJson(res, 200, { ok: true, repos: await deps.store.listMarketSources() } satisfies MarketSourcesResponse)
      },
    },
    {
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
    },
    {
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
    },
    // ------------------------------------------------------- market/source/ref
    // Pin a market source to an explicit ref (branch chosen after a scan
    // found no release, or a user-specified tag).
    {
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
    },
    // -------------------------------------------- market/source/versions
    // Version picker data: release tags + branch names for one market source.
    {
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
    },
    // ------------------------------------------------------- market/check
    // Update check over every market source: compares the pinned ref's
    // commit against the recorded baseline and surfaces newer releases.
    // 5-minute throttle mirrors the source check.
    {
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
    },
    // ------------------------------------------------------- market/stats
    // Stars + release-asset downloads per market source. Stale-while-revalidate:
    // the base call always answers from cache instantly (stale-flagged past the
    // hourly TTL); `?refresh=1` refetches stale entries in that same round.
    // Numbers barely move within a session, and each repo costs two GitHub requests.
    {
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
    },
    // ------------------------------------------------------- market/source/sync
    // Align a market source to its version: resolve the pinned ref (or pick
    // the latest release when unpinned), record the commit, and propagate the
    // ref to the matching tracked source record so source checks/syncs follow
    // it. Returns the local skills tracked from this repo so the UI can offer
    // a batch update.
    {
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
    },
  ]
}
