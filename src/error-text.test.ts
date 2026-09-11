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

  it('appends a cause message to a fetch failure', () => {
    const error = new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.github.com') })
    expect(errorText(error)).toBe('fetch failed (getaddrinfo ENOTFOUND api.github.com)')
  })

  it('appends an error code when the cause message does not contain it', () => {
    const cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    expect(errorText(new TypeError('fetch failed', { cause }))).toBe('fetch failed (Connect Timeout Error [UND_ERR_CONNECT_TIMEOUT])')
  })

  it('does not duplicate a code already present in the cause message', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' })
    expect(errorText(new TypeError('fetch failed', { cause }))).toBe('fetch failed (getaddrinfo ENOTFOUND api.github.com)')
  })

  it('walks nested cause chains', () => {
    const inner = new Error('inner reason')
    const outer = new Error('outer', { cause: inner })
    expect(errorText(new TypeError('fetch failed', { cause: outer }))).toBe('fetch failed (outer; inner reason)')
  })

  it('expands an AggregateError cause', () => {
    const cause = new AggregateError([
      new Error('connect ECONNREFUSED 127.0.0.1:443'),
      new Error('connect ECONNREFUSED [::1]:443'),
    ])
    expect(errorText(new TypeError('fetch failed', { cause }))).toBe('fetch failed (connect ECONNREFUSED 127.0.0.1:443; connect ECONNREFUSED [::1]:443)')
  })

  it('stops at self-referencing cause chains', () => {
    const error = new Error('fetch failed')
    error.cause = error
    expect(errorText(error)).toBe('fetch failed')
  })

  it('stringifies non-Error causes', () => {
    const error = new Error('fetch failed')
    error.cause = 'socket closed'
    expect(errorText(error)).toBe('fetch failed (socket closed)')
  })

  it('returns the cause detail alone when the top message is empty', () => {
    expect(errorText(new Error('', { cause: new Error('boom') }))).toBe('boom')
  })
})
