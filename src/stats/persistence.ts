import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** Narrow structural view of the session-query service (kept loose for tests). */
export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: SessionId; createdAt?: number } }>>
  readSession(id: SessionId): Promise<{ events: SessionEvent[] }>
}

/**
 * Narrow structural view of the host's session-persistence seam (kept loose
 * so no runtime import of host packages is needed — the owner adapts the real
 * service via {@link asPersistenceSeam}). Raw log reads here cost decompress +
 * parse only: no Session restore, no per-event clone, no deep-freeze.
 */
export interface ColdSessionSnapshot {
  header: { id: SessionId; createdAt?: number }
  /** Opaque per-session change token, kept as its string form. */
  revision: string
}

/** One read handle over a stored session log (always closed after counting). */
export interface ColdSessionHandle {
  read(): Promise<{ events: SessionEvent[] }>
  close(): Promise<void> | void
}

/** Minimal persistence surface the cold scan needs. */
export interface SessionPersistenceLike {
  /** Lightweight listing: headers + revision tokens, no event logs. */
  list(): Promise<readonly ColdSessionSnapshot[]>
  open(id: SessionId, access: 'read'): Promise<ColdSessionHandle>
}

/**
 * Adapt a host persistence service to {@link SessionPersistenceLike}.
 * Shape-checked only (no I/O): returns undefined when the value is not a
 * usable seam, so callers fall back to the query path. The adapter re-resolves
 * nothing and holds no state — a replaced host service surfaces as ordinary
 * per-call failures, which scans already tolerate.
 */
export function asPersistenceSeam(service: unknown): SessionPersistenceLike | undefined {
  if (service === null || typeof service !== 'object') return undefined
  const { list, open } = service as { list?: unknown; open?: unknown }
  if (typeof list !== 'function' || typeof open !== 'function') return undefined
  // Bind: host services read instance state (this.tracker, …) — an unbound
  // destructured method throws inside list()/open().
  const listFn = (list as () => Promise<unknown>).bind(service)
  const openFn = (open as (id: SessionId, access: 'read') => Promise<unknown>).bind(service)
  return {
    list: async () => {
      const rows = await listFn()
      if (!Array.isArray(rows)) throw new Error('persistence list shape mismatch')
      return rows.map((row) => {
        const record = row as { header?: { id?: unknown; createdAt?: unknown }; revision?: unknown }
        const id = record.header?.id
        if (typeof id !== 'string' && typeof id !== 'number') throw new Error('persistence snapshot shape mismatch')
        const created = record.header?.createdAt
        return {
          header: {
            id: id as SessionId,
            ...(typeof created === 'number' ? { createdAt: created } : {}),
          },
          revision: String(record.revision),
        }
      })
    },
    open: async (id, access) => {
      const raw = await openFn(id, access)
      if (raw === null || typeof raw !== 'object') throw new Error('persistence handle shape mismatch')
      const { read, close } = raw as { read?: unknown; close?: unknown }
      if (typeof read !== 'function' || typeof close !== 'function') throw new Error('persistence handle shape mismatch')
      const readFn = (read as (offset: number, length: undefined) => Promise<unknown>).bind(raw)
      const closeFn = (close as () => Promise<void> | void).bind(raw)
      return {
        read: async () => {
          const out = await readFn(0, undefined)
          const events = (out as { events?: unknown } | null)?.events
          if (!Array.isArray(events)) throw new Error('persistence read shape mismatch')
          return { events: events as SessionEvent[] }
        },
        close: () => closeFn(),
      }
    },
  }
}
