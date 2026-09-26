import type { AnalysisSnapshot, ShiftPoint } from './types'

export const PROCESSED_ANALYSIS_SCHEMA_VERSION = 2
export const processedAnalysisHeader = 'schema_version,timestamp_s,primary_rpm,secondary_rpm,shift_position_percent,primary_power_kw,secondary_power_kw,efficiency_percent,shift_ratio'

function heldShift(shift: readonly ShiftPoint[], time: number): number | null {
  if (!shift.length || time < shift[0].time) return null
  let low = 0
  let high = shift.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (shift[mid].time <= time) low = mid
    else high = mid - 1
  }

  const current = shift[low]
  const next = shift[low + 1]
  if (
    next
    && current.epoch !== undefined
    && next.epoch !== undefined
    && current.epoch !== next.epoch
    && time > current.time
    && time < next.time
  ) return null
  return current.value
}

export function analysisSnapshotToCsv(snapshot: AnalysisSnapshot): string {
  const times = new Set<number>()
  for (const series of [snapshot.primaryRpm, snapshot.secondaryRpm, snapshot.primaryPower, snapshot.secondaryPower, snapshot.ratio, snapshot.efficiency, snapshot.shift]) {
    for (const point of series) times.add(point.time)
  }
  const rpm1 = new Map(snapshot.primaryRpm.map((point) => [point.time, point.rpm]))
  const rpm2 = new Map(snapshot.secondaryRpm.map((point) => [point.time, point.rpm]))
  const p1 = new Map(snapshot.primaryPower.map((point) => [point.time, point.powerKw]))
  const p2 = new Map(snapshot.secondaryPower.map((point) => [point.time, point.powerKw]))
  const ratio = new Map(snapshot.ratio.map((point) => [point.time, point.ratio]))
  const efficiency = new Map(snapshot.efficiency.map((point) => [point.time, point.efficiencyPct]))

  const cell = (value: number | null | undefined, digits: number) => Number.isFinite(value) ? (value as number).toFixed(digits) : ''
  const rows = [...times].sort((a, b) => a - b).map((time) => [
    PROCESSED_ANALYSIS_SCHEMA_VERSION,
    (time / 1000).toFixed(6),
    cell(rpm1.get(time), 3),
    cell(rpm2.get(time), 3),
    cell(heldShift(snapshot.shift, time), 4),
    cell(p1.get(time), 5),
    cell(p2.get(time), 5),
    cell(efficiency.get(time), 4),
    cell(ratio.get(time), 6),
  ].join(','))
  return [processedAnalysisHeader, ...rows].join('\n')
}
