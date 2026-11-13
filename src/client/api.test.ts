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

  it('passes a workspace cwd when toggling a project skill', async () => {
    let seenBody: string | undefined
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      seenBody = typeof init?.body === 'string' ? init.body : undefined
      return new Response(JSON.stringify({ ok: true, catalog: { skills: [], disabled: [], diagnostics: [], complete: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const api = new SkillHubApi()
    await api.toggle('proj-skill', false, { cwd: '/repo' })
    expect(JSON.parse(seenBody ?? '{}')).toEqual({ name: 'proj-skill', enabled: false, cwd: '/repo' })
  })

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

/**
 * 市场扫描点「扫描」时面板弹出 `signal is aborted without reason`：
 * fetchWithTimeout 的 timer 调 `abort()` 没带 reason，Chromium 就抛这个
 * DOMException，errorMessage() 原样显示。同时 /repo 扫描要串行 3 次 GitHub
 * 往返，却仍用着纯本地读的 10s 预算，注定被掐断。
 */
describe('fetchWithTimeout (market scan abort)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** 永挂的请求：按浏览器的方式在 abort 时 reject(signal.reason)。 */
  function stubHangingFetch(onAbort?: () => void): void {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal == null) return
      signal.addEventListener('abort', () => { onAbort?.(); reject(signal.reason) }, { once: true })
    }))
  }

  function stubChineseDocument(): void {
    vi.stubGlobal('document', { baseURI: 'http://127.0.0.1:3080/', documentElement: { lang: 'zh-CN' } })
  }

  it('shows a readable timeout instead of the raw browser AbortError text', async () => {
    vi.useFakeTimers()
    stubChineseDocument()
    stubHangingFetch()
    const api = new SkillHubApi()
    const pending = api.catalog()
    const assertion = expect(pending).rejects.toThrow('请求超时（10 秒）')
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  })

  it('gives the repo scan the 60s network budget, not the 10s local-read one', async () => {
    vi.useFakeTimers()
    stubChineseDocument()
    let aborted = false
    stubHangingFetch(() => { aborted = true })
    const api = new SkillHubApi()
    const pending = api.repoDiscover('owner/repo')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(aborted).toBe(false)
    const assertion = expect(pending).rejects.toThrow('请求超时（60 秒）')
    await vi.advanceTimersByTimeAsync(50_000)
    await assertion
    expect(aborted).toBe(true)
  })
})
