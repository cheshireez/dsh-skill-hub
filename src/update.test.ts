import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkLatestRelease, compareVersions, CURRENT_VERSION, isUpdateAvailable, parseVersion } from './update.ts'

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

describe('checkLatestRelease', () => {
  it('reports an available update for a newer release', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ tag_name: 'v0.2.0', html_url: 'https://github.com/cheshireez/dsh-skill-hub/releases/tag/v0.2.0' }), { status: 200 })
    const result = await checkLatestRelease('cheshireez/dsh-skill-hub', fetchImpl as typeof fetch)
    expect(result.ok).toBe(true)
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.updateAvailable).toBe(true)
    expect(result.url).toBe('https://github.com/cheshireez/dsh-skill-hub/releases/tag/v0.2.0')
  })

  it('reports up to date when the latest release matches', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ tag_name: 'v0.1.0' }), { status: 200 })
    const result = await checkLatestRelease('cheshireez/dsh-skill-hub', fetchImpl as typeof fetch)
    expect(result.updateAvailable).toBe(false)
    expect(result.latestVersion).toBe('0.1.0')
  })

  it('treats 404 as no release', async () => {
    const fetchImpl = async () => new Response('', { status: 404 })
    const result = await checkLatestRelease('cheshireez/dsh-skill-hub', fetchImpl as typeof fetch)
    expect(result.latestVersion).toBeNull()
    expect(result.updateAvailable).toBe(false)
    expect(result.error).toBe('no release published yet')
  })

  it('surfaces fetch failures without throwing', async () => {
    const fetchImpl = async () => { throw new Error('network down') }
    const result = await checkLatestRelease('cheshireez/dsh-skill-hub', fetchImpl as typeof fetch)
    expect(result.latestVersion).toBeNull()
    expect(result.error).toBe('network down')
  })
})
