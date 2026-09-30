import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../model/types'
import { parseWorkout } from '../parser/parser'
import { db, exportAll, importAll, normalizeNotes, saveSettings, saveWorkout } from './db'
import { deleteLegacy, exportLegacy, hasLegacyData, LEGACY_DB } from './legacy'

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

  it('normalizes old string notes and drops empty ones', () => {
    expect(normalizeNotes(' felt good ')).toEqual([{ kind: 'general', text: 'felt good' }])
    expect(normalizeNotes('  ')).toBeUndefined()
    expect(normalizeNotes(undefined)).toBeUndefined()
    expect(
      normalizeNotes([
        { kind: 'fuel', text: '2 gels' },
        { kind: 'injury', text: ' ' },
        { kind: 'mystery', text: 'kept as general' },
      ]),
    ).toEqual([
      { kind: 'fuel', text: '2 gels' },
      { kind: 'general', text: 'kept as general' },
    ])
  })

  it('exports the pre-account database as v3 without changing it', async () => {
    await Dexie.delete(LEGACY_DB)
    const v1 = new Dexie(LEGACY_DB)
    v1.version(1).stores({ workouts: 'id, date', weekNotes: 'weekStart', settings: 'id', recordings: 'id', stravaAuth: 'id' })
    await v1.table('workouts').bulkPut([
      { ...base, id: 'a', notes: 'calf tight', createdAt: 1, updatedAt: 1 },
      { ...base, id: 'b', notes: '', createdAt: 1, updatedAt: 1 },
    ])
    await v1.table('settings').put({ id: 'settings', ...DEFAULT_SETTINGS, ftp: 250 })
    await v1.table('stravaAuth').put({ id: 'strava', accessToken: 'secret' })
    v1.close()

    expect(await hasLegacyData()).toBe(true)
    const file = await exportLegacy(new Date('2026-09-30T00:00:00Z'))
    expect(file).toMatchObject({ version: 3, exportedAt: '2026-09-30T00:00:00.000Z', weekNotes: [], recordings: [] })
    expect(file.workouts.find((w) => w.id === 'a')?.notes).toEqual([{ kind: 'general', text: 'calf tight' }])
    expect(file.workouts.find((w) => w.id === 'b')?.notes).toBeUndefined()
    expect(file.settings).toEqual({ ...DEFAULT_SETTINGS, ftp: 250 })
    expect(JSON.stringify(file)).not.toContain('secret')

    const reopened = new Dexie(LEGACY_DB)
    await reopened.open()
    expect(reopened.verno).toBe(1)
    expect((await reopened.table('workouts').get('a')).notes).toBe('calf tight')
    reopened.close()

    await deleteLegacy()
    expect(await hasLegacyData()).toBe(false)
  })

  it('imports v2 exports with string notes and round-trips v3', async () => {
    const settings = { ...DEFAULT_SETTINGS }
    const old = { ...base, id: 'old', notes: 'gel at 40', createdAt: 1, updatedAt: 1 }
    await importAll({ version: 2, exportedAt: '', workouts: [old as never], weekNotes: [], settings, recordings: [] })
    expect((await db.workouts.get('old'))?.notes).toEqual([{ kind: 'general', text: 'gel at 40' }])

    const notes = [{ kind: 'fuel' as const, text: '60 g/h' }, { kind: 'injury' as const, text: 'L achilles' }]
    await saveWorkout({ ...base, id: 'new', notes })
    const file = await exportAll()
    expect(file.version).toBe(3)
    await Promise.all(db.tables.map((t) => t.clear()))
    await importAll(file)
    expect((await db.workouts.get('new'))?.notes).toEqual(notes)
  })
})
