/**
 * Business-rule failure the routes layer can map onto a 4xx status instead
 * of a blanket 500: user input is invalid (validation → 400), the target
 * does not exist (not-found → 404), or the operation conflicts with an
 * invariant (conflict → 409).
 */
export class StoreError extends Error {
  readonly kind: 'validation' | 'not-found' | 'conflict'
  constructor(kind: StoreError['kind'], message: string) {
    super(message)
    this.name = 'StoreError'
    this.kind = kind
  }
}
