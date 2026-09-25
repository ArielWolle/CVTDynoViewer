import { describe, expect, it } from 'vitest'
import { applyAnalysisUpdate, createEmptyAnalysisSnapshot } from './uiStore'

describe('analysis UI store', () => {
  it('appends a late join without rewriting an existing primary series', () => {
    const initial = createEmptyAnalysisSnapshot()
    const primary = { type: 'append' as const, snapshot: { ...createEmptyAnalysisSnapshot(), primaryRpm: [{ time: 100, rpm: 3000, sigmaRpm: 0.1 }] } }
    const joined = { type: 'append' as const, snapshot: { ...createEmptyAnalysisSnapshot(), ratio: [{ time: 100, rpm1: 3000, rpm2: 1500, ratio: 2 }] } }
    const afterPrimary = applyAnalysisUpdate(initial, primary, 300_000)
    const afterJoin = applyAnalysisUpdate(afterPrimary, joined, 300_000)
    expect(afterJoin.primaryRpm).toEqual(afterPrimary.primaryRpm)
    expect(afterJoin.ratio).toHaveLength(1)
  })
})
