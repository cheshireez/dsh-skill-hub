import { describe, expect, it } from 'vitest'
import { errorText } from './error-text.ts'

describe('errorText', () => {
  it('uses the message of an Error', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
  })

  it('stringifies non-Error values', () => {
    expect(errorText('plain')).toBe('plain')
    expect(errorText(42)).toBe('42')
    expect(errorText(null)).toBe('null')
    expect(errorText(undefined)).toBe('undefined')
  })

  it('uses an empty message when the Error has none', () => {
    expect(errorText(new Error(''))).toBe('')
  })
})
