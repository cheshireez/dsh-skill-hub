import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkLatestRelease, compareVersions, CURRENT_VERSION, isUpdateAvailable, parseVersion, resetUpdateCache } from './update.ts'

const REPO = 'cheshireez/dsh-skill-hub'

/** A fetch stub that answers the registry and the GitHub API from separate routes. */
function routedFetch(routes: { registry?: () => Response; github?: () => Response }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('registry.npmjs.org')) {
      if (routes.registry === undefined) throw new Error('registry unreachable')
      return routes.registry()
    }
    if (routes.github === undefined) throw new Error('github unreachable')
    return routes.github()
  }) as typeof fetch
}

/** Registry answer carrying one published version. */
function registryVersion(version: string): () => Response {
  return () => new Response(JSON.stringify({ name: 'dsh-skill-hub', version }), { status: 200 })
}

/** GitHub latest-release answer carrying one tag. */
function githubTag(tag: string): () => Response {
  return () => new Response(JSON.stringify({ tag_name: tag, html_url: 'https://github.com/' + REPO + '/releases/tag/' + tag }), { status: 200 })
}

describe('CURRENT_VERSION', () => {
  it('matches the package manifest version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(CURRENT_VERSION).toBe(pkg.version)
  })
})

describe('parseVersion', () => {
  it('parses plain and v-prefixed semver tags', () => {
    expect(parseVersion('0.1.0')).toEqual([0, 1, 0])
    expect(parseVersion('v1.20.300')).toEqual([1, 20, 300])
  })

  it('rejects non-semver tags and prerelease junk', () => {
    expect(parseVersion('latest')).toBeNull()
    expect(parseVersion('v1.2')).toBeNull()
    expect(parseVersion('v1.2.3-beta')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders numeric components correctly', () => {
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0)
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.1.0', '1.0.9')).toBeGreaterThan(0)
  })
})

describe('isUpdateAvailable', () => {
  it('is true only for strictly newer latest versions', () => {
    expect(isUpdateAvailable('0.1.0', '0.1.1')).toBe(true)
    expect(isUpdateAvailable('0.1.0', '0.1.0')).toBe(false)
    expect(isUpdateAvailable('0.2.0', '0.1.9')).toBe(false)
  })
})

describe('checkLatestRelease — 数据源', () => {
  beforeEach(() => { resetUpdateCache() })

  it('prefers the npm dist-tag and never asks GitHub', async () => {
    let githubCalls = 0
    const result = await checkLatestRelease(REPO, routedFetch({
      registry: registryVersion('9.9.9'),
      github: () => { githubCalls += 1; return githubTag('v1.0.0')() },
    }), { refresh: true })
    expect(result.source).toBe('npm')
    expect(result.latestVersion).toBe('9.9.9')
    expect(result.updateAvailable).toBe(true)
    // Release URL is derived from the version instead of costing a second request.
    expect(result.url).toBe('https://github.com/' + REPO + '/releases/tag/v9.9.9')
    expect(githubCalls).toBe(0)
  })

  it('falls back to the GitHub release when the registry is unreachable', async () => {
    const result = await checkLatestRelease(REPO, routedFetch({
      registry: () => { throw new Error('ECONNRESET') },
      github: githubTag('v9.9.9'),
    }), { refresh: true })
    expect(result.source).toBe('github')
    expect(result.latestVersion).toBe('9.9.9')
    expect(result.updateAvailable).toBe(true)
  })

  it('falls back when the registry only has a prerelease tag', async () => {
    // 本项目对外只发 x.y.z；预发布形态交给 GitHub 兜底，而不是拿比不了的东西去比。
    const result = await checkLatestRelease(REPO, routedFetch({
      registry: registryVersion('9.9.9-rc.1'),
      github: githubTag('v8.8.8'),
    }), { refresh: true })
    expect(result.source).toBe('github')
    expect(result.latestVersion).toBe('8.8.8')
  })

  it('reports up to date when the published version matches', async () => {
    const result = await checkLatestRelease(REPO, routedFetch({ registry: registryVersion(CURRENT_VERSION) }), { refresh: true })
    expect(result.source).toBe('npm')
    expect(result.updateAvailable).toBe(false)
    expect(result.latestVersion).toBe(CURRENT_VERSION)
  })

  it('treats a GitHub 404 as no release', async () => {
    const result = await checkLatestRelease(REPO, routedFetch({
      registry: () => new Response('', { status: 404 }),
      github: () => new Response('', { status: 404 }),
    }), { refresh: true })
    expect(result.latestVersion).toBeNull()
    expect(result.updateAvailable).toBe(false)
    expect(result.error).toBe('no release published yet')
  })

  it('surfaces fetch failures without throwing', async () => {
    const result = await checkLatestRelease(REPO, routedFetch({
      registry: () => { throw new Error('registry down') },
      github: () => { throw new Error('network down') },
    }), { refresh: true })
    expect(result.latestVersion).toBeNull()
    expect(result.error).toBe('network down')
  })
})

describe('checkLatestRelease — 缓存', () => {
  beforeEach(() => { resetUpdateCache() })

  /** Counts registry hits so a cached reply is visible as "no second request". */
  function countingFetch(): { fetchImpl: typeof fetch; calls: () => number } {
    let calls = 0
    const fetchImpl = routedFetch({
      registry: () => { calls += 1; return registryVersion('9.9.9')() },
    })
    return { fetchImpl, calls: () => calls }
  }

  it('reuses a fresh result instead of hitting the network twice', async () => {
    const { fetchImpl, calls } = countingFetch()
    await checkLatestRelease(REPO, fetchImpl, { now: 1_000 })
    const second = await checkLatestRelease(REPO, fetchImpl, { now: 2_000 })
    expect(calls()).toBe(1)
    expect(second.latestVersion).toBe('9.9.9')
  })

  it('re-checks once the TTL has passed', async () => {
    const { fetchImpl, calls } = countingFetch()
    await checkLatestRelease(REPO, fetchImpl, { now: 0 })
    await checkLatestRelease(REPO, fetchImpl, { now: 11 * 60 * 1000 })
    expect(calls()).toBe(2)
  })

  it('re-checks when refresh is requested, even inside the TTL', async () => {
    const { fetchImpl, calls } = countingFetch()
    await checkLatestRelease(REPO, fetchImpl, { now: 0 })
    await checkLatestRelease(REPO, fetchImpl, { now: 1, refresh: true })
    expect(calls()).toBe(2)
  })

  it('replays the cached verdict without re-deriving the version', async () => {
    const { fetchImpl } = countingFetch()
    const first = await checkLatestRelease(REPO, fetchImpl, { now: 0 })
    const replayed = await checkLatestRelease(REPO, fetchImpl, { now: 1 })
    // 缓存的是完整结论：currentVersion 覆盖成当前进程版本，其余字段原样复用。
    expect(replayed).toEqual({ ...first, currentVersion: CURRENT_VERSION })
  })
})
