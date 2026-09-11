/**
 * 错误文案收敛：宿主各处把 unknown 异常转成一行可读文字。原先这条表达式
 * 在宿主侧内联了 22 次（`error instanceof Error ? error.message : String(error)`），
 * 现在统一走这里。浏览器半有自己的 `helpers.errorMessage`，两半互不引用。
 *
 * Error 的 `cause` 链（undici 的 `fetch failed`、AggregateError 的多地址
 * 失败、TLS 证书错误等）以括号附录带出，避免只剩笼统的顶层 message。
 */

/** cause 链最大展开深度，防自引用/超深链。 */
const MAX_CAUSE_DEPTH = 4

/** 合成一条 cause 细节；code 已在 message 里则不重复。 */
function causeDetail(message: string, code: string): string {
  const text = message.trim()
  if (code === '') return text
  if (text === '') return '[' + code + ']'
  return text.includes(code) ? text : text + ' [' + code + ']'
}

/** 深度受限地收集 cause 链细节（AggregateError 展开其 errors）。 */
function collectCauseDetails(cause: unknown, depth: number, seen: Set<unknown>, out: string[]): void {
  if (depth > MAX_CAUSE_DEPTH || cause === null || cause === undefined || seen.has(cause)) return
  seen.add(cause)
  if (cause instanceof Error) {
    const errors = (cause as { errors?: unknown }).errors
    if (Array.isArray(errors)) {
      for (const item of errors) collectCauseDetails(item, depth + 1, seen, out)
    }
    const rawCode: unknown = (cause as { code?: unknown }).code
    const code = typeof rawCode === 'string' ? rawCode : ''
    const detail = causeDetail(cause.message, code)
    if (detail !== '') out.push(detail)
    collectCauseDetails(cause.cause, depth + 1, seen, out)
    return
  }
  const detail = causeDetail(String(cause), '')
  if (detail !== '') out.push(detail)
}

/** 从 unknown 异常取出可读文案；非 Error 值用 String 兜底，cause 附在括号里。 */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const details: string[] = []
  collectCauseDetails(error.cause, 1, new Set(), details)
  for (let index = details.length - 1; index >= 0; index -= 1) {
    if (details[index] === error.message || details.indexOf(details[index]) !== index) details.splice(index, 1)
  }
  if (details.length === 0) return error.message
  const suffix = details.join('; ')
  return error.message === '' ? suffix : error.message + ' (' + suffix + ')'
}
