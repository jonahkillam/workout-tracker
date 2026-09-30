import type { Block, SpeedUnit, Step } from './types'

/** Index path into a block tree: [2, 0] is the first child of the third block. */
export type Path = number[]

export function getAt(blocks: Block[], path: Path): Block {
  const [i, ...rest] = path
  const b = blocks[i]
  if (!rest.length) return b
  if (b.type !== 'repeat') throw new Error('Path descends into a step')
  return getAt(b.children, rest)
}

function mapList(blocks: Block[], path: Path, fn: (list: Block[], index: number) => Block[]): Block[] {
  const [i, ...rest] = path
  if (!rest.length) return fn(blocks, i)
  return blocks.map((b, j) => {
    if (j !== i) return b
    if (b.type !== 'repeat') throw new Error('Path descends into a step')
    return { ...b, children: mapList(b.children, rest, fn) }
  })
}

export function replaceAt(blocks: Block[], path: Path, block: Block): Block[] {
  return mapList(blocks, path, (list, i) => list.map((b, j) => (j === i ? block : b)))
}

export function removeAt(blocks: Block[], path: Path): Block[] {
  return mapList(blocks, path, (list, i) => list.filter((_, j) => j !== i))
}

/** Inserts `block` so that it ends up at `path`. */
export function insertAt(blocks: Block[], path: Path, block: Block): Block[] {
  return mapList(blocks, path, (list, i) => [...list.slice(0, i), block, ...list.slice(i)])
}

export function moveBy(blocks: Block[], path: Path, delta: -1 | 1): Block[] {
  return mapList(blocks, path, (list, i) => {
    const j = i + delta
    if (j < 0 || j >= list.length) return list
    const copy = [...list]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  })
}

export function newStep(kind: Step['kind'] = 'steady', duration = 300): Step {
  return { type: 'step', kind, duration, targets: {} }
}

/**
 * Every step occurrence in order, with repeats expanded.
 *
 * A repeat marked `skipLastRest` (`-r`) drops its own final recovery: in its
 * last repetition, a trailing non-work step is left out. If the repeat ends
 * with a nested repeat instead, the drop passes to that repeat's last
 * repetition. So `3x(10x40/20, 5m easy) -r` loses only the last 5m, while
 * `3x(10x40/20 -r, 5m easy)` loses the last 20s of every set.
 */
export function expand(blocks: Block[], limit = 50_000): Step[] {
  const out: Step[] = []
  const visitList = (list: Block[], dropTail: boolean) => {
    list.forEach((b, i) => {
      if (out.length >= limit) return
      const tail = dropTail && i === list.length - 1
      if (b.type === 'step') {
        if (!(tail && b.kind !== 'work')) out.push(b)
        return
      }
      for (let n = 0; n < b.count; n++) {
        const final = n === b.count - 1
        visitList(b.children, final && (tail || !!b.skipLastRest))
      }
    })
  }
  visitList(blocks, false)
  return out
}

/** How many times each step object occurs once repeats are expanded. */
export function occurrences(blocks: Block[]): Map<Step, number> {
  const counts = new Map<Step, number>()
  for (const s of expand(blocks)) counts.set(s, (counts.get(s) ?? 0) + 1)
  return counts
}

/** Marks every speed target to be written as km/h or as pace. */
export function withSpeedUnit(blocks: Block[], unit: SpeedUnit): Block[] {
  return blocks.map((b) => {
    if (b.type === 'repeat') return { ...b, children: withSpeedUnit(b.children, unit) }
    if (!b.targets.speed) return b
    const { asPace: _, ...targets } = b.targets
    return { ...b, targets: unit === 'pace' ? { ...targets, asPace: true } : targets }
  })
}
