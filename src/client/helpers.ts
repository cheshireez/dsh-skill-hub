/**
 * Shared panel helpers: the active-dictionary pick (document-language
 * based, family precedent) plus a small error-message extractor.
 */
import { en, t, zh, type HubKey, type TranslateValues } from './locales.ts'

/** Active dictionary, picked by the document language at call time. */
let cachedDictionaryLang = ''
let cachedDictionary: Record<string, string> | null = null
export function dictionary(): Record<string, string> {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
  const key = lang.toLowerCase().startsWith('en') ? 'en' : 'zh'
  // 字典是静态常量：按语言缓存一份，避免每次 tt() 都全量 spread
  // 258 个键。调用方只读（t() 纯读取），共享引用安全。
  if (cachedDictionary === null || cachedDictionaryLang !== key) {
    cachedDictionaryLang = key
    cachedDictionary = key === 'en' ? { ...en } : { ...zh }
  }
  return cachedDictionary
}

/** Translate a key with optional {name} template params (current language). */
export function tt(key: HubKey, values?: TranslateValues): string {
  return t(dictionary(), key, values)
}

/** Human-readable error text from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Whether a displayName is worth showing beside the kebab-case name.
 * Pure case/punctuation variants (e.g. "Code Review" vs "code-review") are redundant.
 */
export function isDisplayNameDistinct(name: string, displayName: string | undefined): displayName is string {
  if (displayName === undefined) return false
  const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
  return normalize(displayName) !== normalize(name)
}

/**
 * Copy text to the clipboard. Uses the async API with a positioned-textarea
 * fallback for insecure contexts. Resolves true only when the copy succeeded.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy path below.
    }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

