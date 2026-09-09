/**
 * 错误文案收敛：宿主各处把 unknown 异常转成一行可读文字。原先这条表达式
 * 在宿主侧内联了 22 次（`error instanceof Error ? error.message : String(error)`），
 * 现在统一走这里。浏览器半有自己的 `helpers.errorMessage`，两半互不引用。
 */

/** 从 unknown 异常取出可读文案；非 Error 值用 String 兜底。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
