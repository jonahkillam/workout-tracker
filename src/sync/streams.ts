// Recording streams in Supabase Storage. They're too big for the synced tables (tens to hundreds of KB each), so
// each recording's streams are one gzipped object at {user id}/{recording id}.bin. They're uploaded after
// fetching and downloaded when a device needs them to draw a recording.
import { db } from '../db/db'
import type { Recording, RecordingStreams } from '../model/types'
import { getStreams } from '../strava/api'
import { streamsFromStrava } from '../strava/map'
import { supabase } from '../supabase'

const ARRAYS = {
  t: Uint32Array,
  hr: Uint8Array,
  speed: Float32Array,
  cadence: Uint8Array,
  power: Uint16Array,
  altitude: Float32Array,
  distance: Float32Array,
} as const

type ArrayKey = keyof typeof ARRAYS

interface Header {
  recordingId: string
  resolution?: string
  originalSize?: number
  /** Array name and byte length, in the order their bytes follow the header. */
  arrays: [ArrayKey, number][]
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer())
}

/** Layout: 4-byte header length, JSON header, then each array's bytes; gzipped. */
export async function encodeStreams(s: RecordingStreams): Promise<Uint8Array> {
  const present = (Object.keys(ARRAYS) as ArrayKey[]).filter((k) => s[k])
  const header: Header = {
    recordingId: s.recordingId,
    resolution: s.resolution,
    originalSize: s.originalSize,
    arrays: present.map((k) => [k, s[k]!.byteLength]),
  }
  const head = new TextEncoder().encode(JSON.stringify(header))
  const out = new Uint8Array(4 + head.length + header.arrays.reduce((n, [, len]) => n + len, 0))
  new DataView(out.buffer).setUint32(0, head.length)
  out.set(head, 4)
  let offset = 4 + head.length
  for (const k of present) {
    const a = s[k]!
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offset)
    offset += a.byteLength
  }
  return transform(out, new CompressionStream('gzip'))
}

export async function decodeStreams(gzipped: Uint8Array): Promise<RecordingStreams> {
  const bytes = await transform(gzipped, new DecompressionStream('gzip'))
  const headLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headLength))) as Header
  const s: RecordingStreams = { recordingId: header.recordingId, t: new Uint32Array() }
  if (header.resolution !== undefined) s.resolution = header.resolution
  if (header.originalSize !== undefined) s.originalSize = header.originalSize
  let offset = 4 + headLength
  for (const [k, len] of header.arrays) {
    // slice() copies, so each array gets its own aligned buffer.
    const buffer = bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + len)
    ;(s as unknown as Record<ArrayKey, unknown>)[k] = new ARRAYS[k](buffer)
    offset += len
  }
  return s
}

/** Object storage for streams. Supabase Storage in the app; a Map in tests. */
export interface StreamStore {
  put(path: string, bytes: Uint8Array): Promise<void>
  /** Null when there's no such object. */
  get(path: string): Promise<Uint8Array | null>
  remove(paths: string[]): Promise<void>
}

const BUCKET = 'streams'

export const supabaseStreamStore: StreamStore = {
  async put(path, bytes) {
    const body = new Blob([bytes as BlobPart], { type: 'application/octet-stream' })
    const { error } = await supabase.storage.from(BUCKET).upload(path, body, { upsert: true })
    if (error) throw error
  },
  async get(path) {
    const { data, error } = await supabase.storage.from(BUCKET).download(path)
    if (error) {
      const status = (error as { status?: number; statusCode?: string }).status ?? Number((error as { statusCode?: string }).statusCode)
      if (status === 404 || status === 400 || /not found/i.test(error.message)) return null
      throw error
    }
    return new Uint8Array(await data.arrayBuffer())
  },
  async remove(paths) {
    const { error } = await supabase.storage.from(BUCKET).remove(paths)
    if (error) throw error
  },
}

export const streamPath = (owner: string, recordingId: string) => `${owner}/${recordingId}.bin`

async function owner(): Promise<string | undefined> {
  return (await db.syncMeta.get('sync'))?.owner
}

/** Uploads queued streams. Entries stay queued if an upload fails, for the next sync. */
export async function uploadStreams(store: StreamStore) {
  const who = await owner()
  if (!who) return
  for (const { recordingId, queuedAt } of await db.streamUploads.toArray()) {
    const s = await db.recordingStreams.get(recordingId)
    if (s) await store.put(streamPath(who, recordingId), await encodeStreams(s))
    await db.transaction('rw', db.streamUploads, async () => {
      if ((await db.streamUploads.get(recordingId))?.queuedAt === queuedAt) await db.streamUploads.delete(recordingId)
    })
  }
}

const loading = new Map<string, Promise<void>>()

/**
 * Makes sure the given recordings' streams are stored locally, downloading them from Storage, or from Strava as a
 * fallback (e.g. fetched before streams were uploaded). Recordings whose details haven't been fetched are skipped.
 */
export async function ensureStreams(ids: string[], store: StreamStore) {
  const who = await owner()
  if (!who || !ids.length) return
  const have = new Set((await db.recordingStreams.bulkGet(ids)).flatMap((s) => (s ? [s.recordingId] : [])))
  const recordings = (await db.recordings.bulkGet(ids.filter((id) => !have.has(id)))).filter(
    (r): r is Recording => !!r?.streamsFrom,
  )
  await Promise.all(
    recordings.map((r) => {
      if (!loading.has(r.id)) {
        const done = load(r, who, store)
          .catch(() => undefined) // Offline or not found: try again next time it's shown.
          .finally(() => loading.delete(r.id))
        loading.set(r.id, done)
      }
      return loading.get(r.id)
    }),
  )
}

async function load(r: Recording, who: string, store: StreamStore) {
  const bytes = await store.get(streamPath(who, r.id))
  if (bytes) {
    await db.recordingStreams.put({ ...(await decodeStreams(bytes)), recordingId: r.id })
    return
  }
  if (r.stravaId === undefined) return
  const s = streamsFromStrava(r.id, await getStreams(r.stravaId))
  if (!s) return
  await db.transaction('rw', db.recordingStreams, db.streamUploads, async () => {
    await db.recordingStreams.put(s)
    await db.streamUploads.put({ recordingId: r.id, queuedAt: Date.now() })
  })
}
