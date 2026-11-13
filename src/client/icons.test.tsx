// @vitest-environment jsdom
/**
 * Browser-half smoke test: proves the jsdom environment is wired up so hook /
 * component regressions can be added here instead of only being verifiable by
 * opening the live GUI. A pure SVG icon is enough to exercise React DOM.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { IconSkillOutline16 } from './icons.tsx'

// React's act() requires this flag in a non-testing-library environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('browser-half rendering', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    if (root !== undefined) {
      const toUnmount = root
      act(() => toUnmount.unmount())
      root = undefined
    }
    container?.remove()
    container = undefined
  })

  it('renders the skill icon into a real DOM container', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const target = container
    act(() => {
      root = createRoot(target)
      root.render(createElement(IconSkillOutline16, { size: 16 }))
    })
    expect(target.querySelector('svg')).not.toBeNull()
  })
})
