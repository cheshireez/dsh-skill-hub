/**
 * Root-absolute route paths must resolve against the page's base, not the site
 * root: behind a reverse proxy that owns a path prefix (`https://host/app/dsh/`)
 * a root-absolute URL loses the prefix and the gateway answers 404 HTML — the
 * `HTTP 404: invalid JSON response` banner in issue #18.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillHubApi, resolveApiUrl } from './api.ts'

describe('resolveApiUrl (issue #18)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('resolves to the site root for a plain deployment', () => {
    vi.stubGlobal('document', { baseURI: 'http://127.0.0.1:3080/' })
    expect(resolveApiUrl('/api/skill-hub/catalog')).toBe('http://127.0.0.1:3080/api/skill-hub/catalog')
  })

  it('keeps a reverse proxy path prefix', () => {
    vi.stubGlobal('document', { baseURI: 'https://host.example.com/app/dsh/' })
    expect(resolveApiUrl('/api/skill-hub/catalog')).toBe('https://host.example.com/app/dsh/api/skill-hub/catalog')
  })

  it('passes full URLs through and tolerates a missing document (SSR/tests)', () => {
    expect(resolveApiUrl('https://cdn.example.com/x.json')).toBe('https://cdn.example.com/x.json')
    expect(resolveApiUrl('/api/skill-hub/catalog')).toBe('/api/skill-hub/catalog')
  })
})

describe('SkillHubApi outbound boundary (issue #18)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('sends every request through the resolved URL, prefix included', async () => {
    vi.stubGlobal('document', { baseURI: 'https://host.example.com/app/dsh/' })
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ ok: true, skills: [], disabled: [], diagnostics: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const api = new SkillHubApi()
    await api.catalog()

    // One outbound path for the whole family: the prefix is applied once, here.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe('https://host.example.com/app/dsh/api/skill-hub/catalog')
  })
})
