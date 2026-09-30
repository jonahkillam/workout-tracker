// An in-memory stand-in for the Supabase sync functions, with the same rules as supabase/migrations: last write
// wins on client_ts, deletes are tombstones, every write takes the next rev. For tests.
import type { Change, Remote, RemoteRow } from './engine'

export class FakeRemote implements Remote {
  rows = new Map<string, RemoteRow & { client_ts: number }>()
  rev = 0

  async push(changes: Change[]) {
    const rejected: { table: string; key: string }[] = []
    for (const c of changes) {
      const id = `${c.table}/${c.key}`
      const current = this.rows.get(id)
      if (current && current.client_ts > c.client_ts) {
        rejected.push({ table: c.table, key: c.key })
        continue
      }
      const doc = c.deleted ? null : JSON.parse(JSON.stringify(c.doc))
      this.rows.set(id, { table: c.table, key: c.key, doc, deleted: c.deleted, client_ts: c.client_ts, rev: ++this.rev })
    }
    return rejected
  }

  async pull(since: number, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.rev > since)
      .sort((a, b) => a.rev - b.rev)
      .slice(0, limit)
      .map((r) => ({ table: r.table, key: r.key, doc: r.doc, deleted: r.deleted, rev: r.rev }))
  }

  async fetch(table: string, keys: string[]) {
    return keys.flatMap((key) => {
      const r = this.rows.get(`${table}/${key}`)
      return r ? [{ table: r.table, key: r.key, doc: r.doc, deleted: r.deleted, rev: r.rev }] : []
    })
  }

  /** Writes a row as if another device had pushed it. */
  put(table: string, key: string, doc: RemoteRow['doc'], client_ts: number) {
    this.rows.set(`${table}/${key}`, { table, key, doc, deleted: !doc, client_ts, rev: ++this.rev })
  }

  get(table: string, key: string) {
    return this.rows.get(`${table}/${key}`)
  }
}
