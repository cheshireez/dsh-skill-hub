/**
 * 市场域路由：market 列表 / source 增删 / ref 锁定 / versions 选择器 /
 * source/check 更新检查 / stats 星标统计 / source/sync 对齐版本。
 * 从 routes.ts 原样搬出，handler 逻辑不变。
 */

import {
  SKILL_HUB_API,
  type MarketCheckResponse,
  type MarketSourceAddResponse,
  type MarketSourceResponse,
  type MarketSourcesResponse,
  type MarketSourceVersionsResponse,
  type MarketSkillsShResponse,
  type MarketSkillsShInstallResponse,
  type MarketStatsResponse,
  type MarketSyncResponse,
} from '../protocol.ts'
import {
  diffRemoteSkills,
  downloadSkillsShSkill,
  getLatestCommit,
  getLatestReleaseTag,
  getRepoStats,
  listRepoBranches,
  listRepoReleases,
  loadRepoTreeAt,
  normalizeRepoInput,
  repoSlug,
  searchSkillsSh,
  SkillsShError,
} from '../repo.ts'
import { compareVersions, parseVersion } from '../update.ts'
import { errorText } from '../error-text.ts'
import { mapConcurrent } from '../concurrency.ts'
import {
  queryParam,
  homeOf,
  knownSkillNames,
  readString,
  writeError,
  writeJson,
  type RouteHandler,
  type RouteSpec,
  type SkillHubRouteDeps,
} from './helpers.ts'
import { installSkillBundle } from './install-bundle.ts'
import { retireNamePlaceholders } from './route-state.ts'
import { rootPath } from '../skillfs.ts'
import type { AuditFinding } from '../skillfs/audit.ts'
import {
  MARKET_STATS_TTL_MS,
  MIN_CHECK_INTERVAL_MS,
  lastMarketCheck,
  lastMarketStats,
  lastSourceCheck,
  marketStatsCache,
  seedMarketStats,
} from './route-state.ts'

/** 市场域全部路由 spec（由 routes.ts 经 createRoute 包上统一围栏）。 */
export function marketRoutes(deps: SkillHubRouteDeps): RouteSpec[] {
  // Update check over every market source: compares the pinned ref's commit
  // against the recorded baseline and surfaces newer releases. 5-minute
  // throttle mirrors the source check.
  const checkMarketSources: RouteHandler = async ({ res }) => {
    const sources = await deps.store.listMarketSources()
    if (lastMarketCheck.size > 500) lastMarketCheck.clear()
    // Bounded parallel checks: a dozen sources used to take 2 × N sequential
    // GitHub round trips, which could exceed the client's read timeout before
    // any result was returned. Keep the result order aligned with the market
    // list, and cap concurrency to avoid a burst that trips rate limiting.
    const results = await mapConcurrent(sources, 4, async (source) => {
      const base = { repo: source.repo, ...(source.ref !== undefined ? { ref: source.ref } : {}) }
      const now = Date.now()
      const last = lastMarketCheck.get(source.repo) ?? 0
      if (now - last < MIN_CHECK_INTERVAL_MS) {
        return { ...base, updateAvailable: false, commitSha: source.commitSha ?? '', throttled: true }
      }
      try {
        const latestTag = await getLatestReleaseTag(source.repo)
        if (source.ref === undefined) {
          // Not pinned yet: report the latest release so the UI can
          // suggest pinning, but never claim an update.
          lastMarketCheck.set(source.repo, now)
          return { ...base, updateAvailable: false, commitSha: source.commitSha ?? '', ...(latestTag !== undefined ? { latestTag } : {}) }
        }
        const latest = await getLatestCommit(source.repo, source.ref)
        // Both GitHub calls succeeded before the attempt may count against the
        // 5-minute throttle. A failed commit lookup must remain retryable on
        // the next click instead of being hidden behind a throttled negative.
        const refVersion = parseVersion(source.ref)
        const newRelease = refVersion !== null && latestTag !== undefined && parseVersion(latestTag) !== null && compareVersions(latestTag, source.ref) > 0
        const hasBaseline = source.commitSha !== undefined && source.commitSha !== ''
        const commitMoved = hasBaseline && latest.commitSha !== source.commitSha
        if (!hasBaseline) {
          // First check / freshly imported source: adopt this commit as the
          // baseline. The missing snapshot itself must not claim an update.
          await deps.store.setMarketSourceCommit(source.repo, latest.commitSha)
        }
        lastMarketCheck.set(source.repo, now)
        return { ...base, updateAvailable: newRelease || commitMoved, commitSha: latest.commitSha, ...(newRelease ? { latestTag } : {}) }
      } catch (error) {
        return { ...base, updateAvailable: false, commitSha: source.commitSha ?? '', error: errorText(error) }
      }
    })
    writeJson(res, 200, { ok: true, results } satisfies MarketCheckResponse)
  }

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
        const input = readString(body, 'repo').trim()
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        // An explicit @ref pins the source immediately (e.g. repo@v1.2.3);
        // otherwise the first scan resolves latest-release / branch choice.
        const ref = parsed.ref
        const slug = repoSlug(parsed)
        // Return the normalized slug explicitly: the client scans it right
        // away, and `repos` order carries no "this one" signal (re-adding an
        // existing repo only rewrites its ref in place).
        writeJson(res, 200, { ok: true, repo: slug, repos: await deps.store.addMarketSource(slug, ref) } satisfies MarketSourceAddResponse)
      },
    },
    {
      path: SKILL_HUB_API.marketSourceDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const input = readString(body, 'repo').trim()
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
        const parsed = normalizeRepoInput(readString(body, 'repo'))
        const ref = readString(body, 'ref').trim()
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        if (ref === '') { writeError(res, 400, 'ref is required'); return }
        const repo = repoSlug(parsed)
        const record = await deps.store.setMarketSourceRef(repo, ref)
        if (record === undefined) { writeError(res, 404, 'market source not found: ' + repo); return }
        // The tracked source follows the market pin: checks and syncs use
        // SourceRecord.ref, so leaving it behind would make the row show the
        // new version while downloads still came from the old one.
        const tracked = await deps.store.getSource(repo)
        if (tracked !== undefined) await deps.store.setSourceRef(repo, ref)
        lastMarketCheck.delete(repo)
        lastSourceCheck.delete(repo)
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
    // ------------------------------------------------- market/source/check
    // Canonical path; the sibling sync route lives at market/source/sync.
    {
      path: SKILL_HUB_API.marketCheck,
      methods: ['GET'],
      handler: checkMarketSources,
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
              results.push({ repo: source.repo, stars: 0, downloads: 0, error: errorText(error) })
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
        const parsed = normalizeRepoInput(readString(body, 'repo'))
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        const source = await deps.store.getMarketSource(repo)
        if (source === undefined) { writeError(res, 404, 'market source not found: ' + repo); return }
        // Resolve the target ref and its commit before touching persistent
        // state: a bad ref or a transient GitHub failure must leave the saved
        // pin and baseline exactly as they were.
        const requestedRef = readString(body, 'ref').trim()
        let ref = requestedRef !== '' ? requestedRef : source.ref
        if (ref === undefined || ref === '') {
          const latestTag = await getLatestReleaseTag(repo)
          if (latestTag === undefined) { writeError(res, 409, 'repo has no release — pick a branch first'); return }
          ref = latestTag
        }
        const latest = await getLatestCommit(repo, ref)
        await deps.store.setMarketSourcePin(repo, ref, latest.commitSha)
        // Propagate the ref to the tracked source record so checks follow it.
        await deps.store.setSourceRef(repo, ref)
        // Both sides changed; the old 5-minute throttle would otherwise hide
        // the post-sync state from the next check.
        lastMarketCheck.delete(repo)
        lastSourceCheck.delete(repo)
        const tracked = await deps.store.getSource(repo)
        // Report the real skill-level diff under the newly resolved tree so a
        // batch-update dialog can select only skills that actually changed.
        // A tree fetch failure must not turn a successful pin into an error.
        let updated: string[] | undefined
        let deleted: string[] | undefined
        if (tracked !== undefined) {
          try {
            const tree = await loadRepoTreeAt(repo, latest.treeSha)
            const diff = diffRemoteSkills(tree, tracked)
            updated = diff.updated
            deleted = diff.deleted
          } catch {
            // The pin itself succeeded; omit the optional diff fields.
          }
        }
        writeJson(res, 200, {
          ok: true,
          repo,
          ref,
          commitSha: latest.commitSha,
          skills: tracked !== undefined ? [...tracked.skills] : [],
          ...(updated !== undefined ? { updated } : {}),
          ...(deleted !== undefined ? { deleted } : {}),
        } satisfies MarketSyncResponse)
      },
    },
    // skills.sh 搜索：把外部索引变成候选列表。这是「发现」而不是「源」——
    // 结果点「添加」后走的是正常的市场源登记 + 仓库扫描链路，因此更新跟踪、
    // 版本钉选、回收站这些行为与手工添加的源完全一致。
    {
      path: SKILL_HUB_API.marketSkillsSh,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        try {
          const skills = await searchSkillsSh(queryParam(url, 'q') ?? '')
          writeJson(res, 200, { ok: true, skills } satisfies MarketSkillsShResponse)
        } catch (error) {
          // 400 = 查询词问题，502 = 上游问题；两者都是用户可读的失败原因。
          if (error instanceof SkillsShError) { writeError(res, error.status, error); return }
          throw error
        }
      },
    },
    // skills.sh 直装：只装这一个技能，不登记来源。
    //
    // 为什么不记来源：上游只给 skillId（仓库里的目录名），不给它在仓库中的
    // 完整路径，因此 `SourceRecord.root` 无从确定 —— 编一个出来会让后续的
    // 更新检查去扫一个不存在的目录。宁可如实地说「不跟踪更新」，让想要
    // 跟踪的人走「加为源」。
    {
      path: SKILL_HUB_API.marketSkillsShInstall,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const source = readString(body, 'source')
        const skillId = readString(body, 'skillId')
        if (source === '' || skillId === '') { writeError(res, 400, 'source and skillId are required'); return }

        let pkg
        try {
          pkg = await downloadSkillsShSkill(source, skillId)
        } catch (error) {
          if (error instanceof SkillsShError) { writeError(res, error.status, error); return }
          throw error
        }

        const targetRoot = rootPath('user-dsh', homeOf(deps))
        const existing = await knownSkillNames(deps, { includeDisabled: false })
        const outcome = await installSkillBundle({
          targetRoot,
          files: pkg.files.map((file) => ({ path: file.path, size: file.data.length, data: file.data })),
          label: pkg.origin,
          existing,
          retire: async (name) => (await retireNamePlaceholders(deps, targetRoot, name)) !== undefined,
        })
        if (outcome.status === 'installed') deps.invalidate?.()

        writeJson(res, 200, {
          ok: true,
          status: outcome.status,
          name: outcome.name,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          ...(outcome.replaced === true ? { replaced: true } : {}),
          ...(outcome.warnings !== undefined ? { warnings: outcome.warnings.map((finding: AuditFinding) => ({ rule: finding.rule, severity: 'warn' as const, file: finding.file, ...(finding.line !== undefined ? { line: finding.line } : {}), message: finding.message })) } : {}),
        } satisfies MarketSkillsShInstallResponse)
      },
    },
  ]
}
