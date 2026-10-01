import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../model/types'
import { parseWorkout } from '../parser/parser'
import { db, exportAll, importAll, normalizeNotes, saveSettings, saveWorkout } from './db'

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('saveSettings', () => {
  it('fills missing thresholds and leaves rows with nothing missing unwritten', async () => {
    const blocks = parseWorkout('20m').blocks
    const full = await saveWorkout({
      date: '2026-09-29', sport: 'run', rawText: '20m', blocks,
      profile: { ...DEFAULT_SETTINGS, thresholdSpeed: 15, ftp: 250, lthr: 170, maxHr: 190 },
    })
    const partial = await saveWorkout({ date: '2026-09-29', sport: 'run', rawText: '20m', blocks, profile: { ...DEFAULT_SETTINGS } })

    const written: string[] = []
    const onUpdating = function (_mods: object, key: string) {
      written.push(key)
    }
    db.workouts.hook('updating', onUpdating)
    try {
      await saveSettings({ ...DEFAULT_SETTINGS, thresholdSpeed: 14 })
    } finally {
      db.workouts.hook('updating').unsubscribe(onUpdating)
    }

    expect(written).toEqual([partial.id])
    expect((await db.workouts.get(partial.id))?.profile?.thresholdSpeed).toBe(14)
    expect((await db.workouts.get(full.id))?.profile?.thresholdSpeed).toBe(15)
  })
})

describe('notes', () => {
  const blocks = parseWorkout('20m').blocks
  const base = { date: '2026-09-29', sport: 'run' as const, rawText: '20m', blocks, profile: { ...DEFAULT_SETTINGS } }

  it('trims notes and drops empty ones', () => {
    expect(normalizeNotes([])).toBeUndefined()
    expect(
      normalizeNotes([
        { kind: 'fuel', text: ' 2 gels ' },
        { kind: 'injury', text: ' ' },
      ]),
    ).toEqual([{ kind: 'fuel', text: '2 gels' }])
  })

  it('round-trips an export', async () => {
    const notes = [{ kind: 'fuel' as const, text: '60 g/h' }, { kind: 'injury' as const, text: 'L achilles' }]
    await saveWorkout({ ...base, id: 'new', notes })
    const file = await exportAll()
    expect(file.version).toBe(3)
    await Promise.all(db.tables.map((t) => t.clear()))
    await importAll(file)
    expect((await db.workouts.get('new'))?.notes).toEqual(notes)
  })

  it('rejects other export versions', async () => {
    const file = { ...(await exportAll()), version: 2 }
    await expect(importAll(file as never)).rejects.toThrow('Unsupported export version 2')
  })
})
