import { describe, expect, it } from 'vitest'
import { AnalysisStore } from './store'
import type { AnalysisSnapshot, AnalysisUpdate, RpmPoint } from './types'

function emptySnapshot(): AnalysisSnapshot {
  return { primaryRpm: [], secondaryRpm: [], primaryPower: [], secondaryPower: [], ratio: [], efficiency: [], shift: [] }
}

function append(snapshot: Partial<AnalysisSnapshot>): AnalysisUpdate {
  return { type: 'append', snapshot: { ...emptySnapshot(), ...snapshot } }
}

function rpm(time: number, value: number): RpmPoint {
  return { time, rpm: value, sigmaRpm: 0.1 }
}

describe('AnalysisStore', () => {
  it('retains full derived history without rewriting unrelated series', () => {
    const store = new AnalysisStore()
    store.apply(append({ primaryRpm: [rpm(100, 1000), rpm(200, 2000)] }))
    const secondaryBefore = store.secondaryRpm.revision
    const primaryBefore = store.primaryRpm.revision

    store.apply(append({ primaryRpm: [rpm(300, 3000)] }))

    expect(store.snapshot().primaryRpm.map((point) => point.time)).toEqual([100, 200, 300])
    expect(store.primaryRpm.revision).toBe(primaryBefore + 1)
    expect(store.secondaryRpm.revision).toBe(secondaryBefore)
  })

  it('publishes tiny stable status snapshots instead of full analysis arrays', () => {
    const store = new AnalysisStore()
    const before = store.getStatusSnapshot()
    store.apply(append({ primaryRpm: [rpm(100, 1234)] }))
    const after = store.getStatusSnapshot()

    expect(after).not.toBe(before)
    expect(after.totalCount).toBe(1)
    expect(after.current.rpm1).toBe(1234)
    expect(after.latestTime).toBe(100)
    expect('primaryRpm' in after).toBe(false)
  })

  it('keeps the structural snapshot stable across ordinary appends', () => {
    const store = new AnalysisStore()
    const structural = store.getStructuralSnapshot()
    store.apply(append({ primaryRpm: [rpm(100, 1000)] }))
    expect(store.getStructuralSnapshot()).toBe(structural)

    store.reset()
    expect(store.getStructuralSnapshot()).not.toBe(structural)
  })

  it('updates late joins inside an already-visible viewport', () => {
    const store = new AnalysisStore()
    store.apply(append({
      primaryRpm: [rpm(100, 3000), rpm(200, 3100), rpm(300, 3200)],
      secondaryRpm: [rpm(100, 1500), rpm(200, 1550), rpm(300, 1600)],
    }))
    const before = store.viewport(100, 300, 100, 1500)
    expect(before.ratioDots).toEqual([])

    store.apply(append({
      ratio: [{ time: 200, rpm1: 3100, rpm2: 1550, ratio: 2 }],
    }))
    const after = store.viewport(100, 300, 100, 1500)

    expect(after.ratioDots).toHaveLength(1)
    expect(after.ratioDots[0].time).toBe(200)
    expect(after.primaryRpm).toBe(before.primaryRpm)
    expect(after.secondaryRpm).toBe(before.secondaryRpm)
  })

  it('reuses frozen viewport results while unrelated future data arrive', () => {
    const store = new AnalysisStore()
    store.apply(append({
      primaryRpm: [rpm(100, 1000), rpm(200, 2000), rpm(300, 3000)],
    }))
    const before = store.viewport(100, 300, 100, 1500)

    store.apply(append({ primaryRpm: [rpm(400, 4000)] }))
    const after = store.viewport(100, 300, 100, 1500)

    // The series revision changed, but the mutation is strictly to the right of the frozen view.
    // The viewport cache should preserve the exact rendered-array identity.
    expect(after.primaryRpm).toBe(before.primaryRpm)
  })

  it('slides a live viewport forward and matches a fresh rebuild', () => {
    const store = new AnalysisStore()
    const points = Array.from({ length: 41 }, (_, index) => rpm(index * 5, 1000 + index))
    store.apply(append({ primaryRpm: points.slice(0, 31) }))
    store.viewport(50, 150, 0, 1500)

    store.apply(append({ primaryRpm: points.slice(31) }))
    const incremental = store.viewport(100, 200, 0, 1500)

    const rebuilt = new AnalysisStore()
    rebuilt.apply(append({ primaryRpm: points }))
    const fresh = rebuilt.viewport(100, 200, 0, 1500)

    expect(incremental.primaryRpm).toEqual(fresh.primaryRpm)
  })

  it('falls back safely when one series is appended out of timestamp order', () => {
    const store = new AnalysisStore()
    store.apply(append({ primaryRpm: [rpm(100, 1000), rpm(300, 3000)] }))
    store.apply(append({ primaryRpm: [rpm(200, 2000)] }))
    expect(store.snapshot().primaryRpm.map((point) => point.time)).toEqual([100, 200, 300])
  })

  it('replace/reset invalidate old viewport generations', () => {
    const store = new AnalysisStore()
    store.apply(append({ primaryRpm: [rpm(100, 1000)] }))
    const generationBefore = store.getStatusSnapshot().generation

    store.replace({ ...emptySnapshot(), primaryRpm: [rpm(500, 5000)] })
    expect(store.getStatusSnapshot().generation).toBe(generationBefore + 1)
    expect(store.snapshot().primaryRpm.map((point) => point.time)).toEqual([500])

    store.reset()
    expect(store.getStatusSnapshot().generation).toBe(generationBefore + 2)
    expect(store.getStatusSnapshot().totalCount).toBe(0)
  })

  it('returns nearest full-resolution points independently of render downsampling', () => {
    const store = new AnalysisStore()
    const points = Array.from({ length: 2000 }, (_, index) => rpm(index * 5, index))
    store.apply(append({ primaryRpm: points }))
    const view = store.viewport(0, 9_995, 0, 100)
    expect(view.primaryRpm.length).toBeLessThanOrEqual(100)
    expect(store.nearest('primaryRpm', 5_003)?.time).toBe(5_005)
  })
  it('constrains nearest lookups to the visible range and rejects remote gap values', () => {
    const store = new AnalysisStore()
    store.apply(append({ primaryRpm: [rpm(100, 1000), rpm(200, 2000), rpm(1_000, 3000)] }))

    expect(store.nearest('primaryRpm', 250, { minTime: 100, maxTime: 200 })?.time).toBe(200)
    expect(store.nearest('primaryRpm', 600, { minTime: 100, maxTime: 1_000, maxDelta: 100 })).toBeUndefined()
  })

})
