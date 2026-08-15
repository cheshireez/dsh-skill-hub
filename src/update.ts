/**
 * Self-update check for dsh-skill-hub, mirroring cc-switch's behavior:
 * query GitHub's latest release and compare it to the installed version.
 *
 * This stays dependency-free: Node's global fetch is used and the version
 * comparison is a small semver-subset parser (the plugin only publishes
 * plain x.y.z tags, optionally prefixed with `v`).
 */

import { createRequire } from 'node:module'
import type { UpdateCheckResponse } from './protocol.ts'

/** Repository checked for releases. Keep in sync with package.json. */
export const UPDATE_REPO = 'cheshireez/dsh-skill-hub'

/** Installed plugin version, read from the package manifest. */
const require = createRequire(import.meta.url)
export const CURRENT_VERSION = (require('../package.json') as { version: string }).version

/** Normalize a release tag (`v1.2.3` → `1.2.3`) and parse it numerically. */
export function parseVersion(tag: string): [number, number, number] | null {
  const match = /^[vV]?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Compare two dotted version strings: negative when a < b, 0 equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return a.localeCompare(b, 'en')
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

/** True when latest is strictly newer than current. */
export function isUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  return compareVersions(latestVersion, currentVersion) > 0
}

/** Best-effort GitHub latest-release lookup. Always resolves with ok:true. */
export async function checkLatestRelease(repo = UPDATE_REPO, fetchImpl: typeof fetch = fetch): Promise<UpdateCheckResponse> {
  const currentVersion = CURRENT_VERSION
  const url = `https://api.github.com/repos/${repo}/releases/latest`
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/vnd.github+json' },
    })
  } catch (error) {
    return {
      ok: true,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      url: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  if (response.status === 404) {
    return {
      ok: true,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      url: null,
      error: 'no release published yet',
    }
  }

  if (!response.ok) {
    return {
      ok: true,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      url: null,
      error: 'GitHub HTTP ' + response.status,
    }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    return {
      ok: true,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      url: null,
      error: error instanceof Error ? error.message : 'invalid GitHub response',
    }
  }

  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const rawTag = typeof record.tag_name === 'string' ? record.tag_name.trim() : ''
  const parsed = parseVersion(rawTag)
  if (parsed === null) {
    return {
      ok: true,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      url: null,
      error: 'unsupported release tag: ' + (rawTag || 'missing'),
    }
  }

  const latestVersion = `${parsed[0]}.${parsed[1]}.${parsed[2]}`
  return {
    ok: true,
    currentVersion,
    latestVersion,
    updateAvailable: isUpdateAvailable(currentVersion, latestVersion),
    url: typeof record.html_url === 'string' ? record.html_url : null,
  }
}
