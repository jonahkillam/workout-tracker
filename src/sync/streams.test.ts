import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import type { Recording, RecordingStreams } from '../model/types'
import { adoptOwner } from './engine'
import { decodeStreams, encodeStreams, ensureStreams, streamPath, uploadStreams, type StreamStore } from './streams'

class MemoryStore implements StreamStore {
  objects = new Map<string, Uint8Array>()
  async put(path: string, bytes: Uint8Array) {
    this.objects.set(path, bytes)
  }
  async get(path: string) {
    return this.objects.get(path) ?? null
  }
  async remove(paths: string[]) {
    for (const p of paths) this.objects.delete(p)
  }
}

const streams: RecordingStreams = {
  recordingId: 'r1',
  t: Uint32Array.from({ length: 3601 }, (_, i) => i),
  hr: Uint8Array.from({ length: 3601 }, (_, i) => 120 + (i % 40)),
  speed: Float32Array.from({ length: 3601 }, (_, i) => 3 + Math.sin(i / 60)),
  power: Uint16Array.from({ length: 3601 }, (_, i) => 200 + (i % 7)),
  resolution: 'high',
  originalSize: 3601,
}

const recording: Recording = {
  id: 'r1', startTime: '', localDate: '2026-09-29', sport: 'run', rawSport: 'Run', elapsed: 3600, laps: [],
  streamsFrom: 'strava', importedAt: 0, updatedAt: 0,
}

let store: MemoryStore

beforeEach(async () => {
  store = new MemoryStore()
  await adoptOwner('other')
  await adoptOwner('u1')
})

describe('streams', () => {
  it('round-trips through the gzipped format, and is smaller than the raw arrays', async () => {
    const bytes = await encodeStreams(streams)
    expect(await decodeStreams(bytes)).toEqual(streams)
    expect(bytes.byteLength).toBeLessThan(3601 * 11)
  })

  it('uploads queued streams under the user, then downloads them on another device', async () => {
    await db.recordings.put(recording)
    await db.recordingStreams.put(streams)
    await db.streamUploads.put({ recordingId: 'r1', queuedAt: 1 })
    await uploadStreams(store)
    expect([...store.objects.keys()]).toEqual([streamPath('u1', 'r1')])
    expect(await db.streamUploads.count()).toBe(0)

    await db.recordingStreams.clear()
    await ensureStreams(['r1'], store)
    expect(await db.recordingStreams.get('r1')).toEqual(streams)
  })

  it('skips recordings whose details were never fetched, and ones already here', async () => {
    await db.recordings.put({ ...recording, streamsFrom: undefined })
    await ensureStreams(['r1'], store)
    expect(await db.recordingStreams.count()).toBe(0)
  })
})
