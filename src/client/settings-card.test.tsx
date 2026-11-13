// @vitest-environment jsdom
/**
 * 设置卡片的"有新版本"提示：数据来自 update 路由，渲染在标题行的版本徽标旁。
 * 折叠状态下也看得见是刻意的 —— 更新提示藏进展开区等于没有。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginSettingsCard } from './settings-card.tsx'
import type { CardShell } from './settings-form.ts'
import type { HubKey } from './locales.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const READY: CardShell = { available: true, exposed: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
const t = (key: HubKey): string => String(key)

describe('PluginSettingsCard version badge', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    if (root !== undefined) act(() => { root?.unmount() })
    container?.remove()
    root = undefined
    container = undefined
  })

  /** Mount the card with the given version props and return the rendered DOM. */
  function mount(props: { version?: string; versionExtra?: React.ReactElement }): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(createElement(PluginSettingsCard, {
        t,
        titleKey: 'settings.title' as HubKey,
        descriptionKey: 'settings.description' as HubKey,
        state: READY,
        onSave: () => {},
        onDiscard: () => {},
        ...props,
      }))
    })
    return container
  }

  it('renders the bare version tag when there is no update', () => {
    const dom = mount({ version: '0.3.34' })
    expect(dom.textContent).toContain('v0.3.34')
    expect(dom.querySelector('a')).toBeNull()
  })

  it('renders the update link beside the version, without opening the card', () => {
    const dom = mount({
      version: '0.3.34',
      versionExtra: createElement('a', { href: 'https://example.test/v1', rel: 'noreferrer' }, 'new version'),
    })
    const link = dom.querySelector('a')
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toBe('https://example.test/v1')
    // 提示要在 header 里（折叠可见），不是 body 里。
    expect(dom.querySelector('a')?.closest('button')).not.toBeNull()
    expect(dom.textContent).toContain('v0.3.34')
  })

  it('omits the version block entirely while the version is unknown', () => {
    const dom = mount({})
    expect(dom.textContent).not.toContain('v0.')
    expect(dom.querySelector('a')).toBeNull()
  })
})
