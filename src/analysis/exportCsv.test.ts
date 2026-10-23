import { describe, expect, it } from 'vitest'
import { analysisSnapshotToCsv, processedAnalysisHeader } from './exportCsv'
import type { AnalysisSnapshot } from './types'

function emptySnapshot(): AnalysisSnapshot {
  return { primaryRpm: [], secondaryRpm: [], primaryPower: [], secondaryPower: [], ratio: [], efficiency: [], shift: [] }
}

describe('processed analysis export', () => {
  it('exports shift-only runs at their actual measurement timestamps', () => {
    const csv = analysisSnapshotToCsv({
      ...emptySnapshot(),
      shift: [{ time: 125, value: 12.5, epoch: 0 }, { time: 250, value: 20, epoch: 0 }],
    })
    const lines = csv.split('\n')
    expect(lines[0]).toBe(processedAnalysisHeader)
    expect(lines).toHaveLength(3)
    expect(lines[1].split(',')[1]).toBe('0.125000')
    expect(lines[1].split(',')[4]).toBe('12.5000')
  })

  it('does not forward-fill shift through a known telemetry discontinuity', () => {
    const csv = analysisSnapshotToCsv({
      ...emptySnapshot(),
      primaryRpm: [
        { time: 100, rpm: 1000, sigmaRpm: 1 },
        { time: 150, rpm: 1100, sigmaRpm: 1 },
        { time: 200, rpm: 1200, sigmaRpm: 1 },
      ],
      shift: [
        { time: 100, value: 10, epoch: 0 },
        { time: 200, value: 20, epoch: 1 },
      ],
    })
    const row150 = csv.split('\n').find((line) => line.split(',')[1] === '0.150000')
    expect(row150?.split(',')[4]).toBe('')
  })
})
