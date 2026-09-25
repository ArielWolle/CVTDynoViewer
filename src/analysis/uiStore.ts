import type { AnalysisSnapshot, AnalysisUpdate, EfficiencyPoint, PowerPoint, RatioPoint, RpmPoint, ShiftPoint } from './types'

export function createEmptyAnalysisSnapshot(): AnalysisSnapshot {
  return { primaryRpm: [], secondaryRpm: [], primaryPower: [], secondaryPower: [], ratio: [], efficiency: [], shift: [], primaryObservations: [], secondaryObservations: [] }
}

export const EMPTY_ANALYSIS_SNAPSHOT: AnalysisSnapshot = createEmptyAnalysisSnapshot()

const timeOf = (point: { time: number }) => point.time

function appendRetained<T extends { time: number }>(history: readonly T[], next: readonly T[], cutoff: number): T[] {
  if (!next.length) return history.filter((point) => timeOf(point) >= cutoff)
  return [...history.filter((point) => timeOf(point) >= cutoff), ...next.filter((point) => timeOf(point) >= cutoff)]
}

export function latestAnalysisTime(snapshot: AnalysisSnapshot): number {
  const series: readonly { time: number }[][] = [
    snapshot.primaryRpm, snapshot.secondaryRpm, snapshot.primaryPower, snapshot.secondaryPower,
    snapshot.ratio, snapshot.efficiency, snapshot.shift, snapshot.primaryObservations, snapshot.secondaryObservations,
  ]
  let latest = 0
  for (const values of series) if (values.length) latest = Math.max(latest, values[values.length - 1].time)
  return latest
}

export function firstAnalysisTime(snapshot: AnalysisSnapshot): number {
  const series: readonly { time: number }[][] = [
    snapshot.primaryRpm, snapshot.secondaryRpm, snapshot.primaryPower, snapshot.secondaryPower,
    snapshot.ratio, snapshot.efficiency, snapshot.shift, snapshot.primaryObservations, snapshot.secondaryObservations,
  ]
  let first = Infinity
  for (const values of series) if (values.length) first = Math.min(first, values[0].time)
  return Number.isFinite(first) ? first : 0
}

export function applyAnalysisUpdate(current: AnalysisSnapshot, update: AnalysisUpdate, retentionMs: number): AnalysisSnapshot {
  if (update.type === 'replace') return trimSnapshot(update.snapshot, retentionMs)
  if (update.type === 'observations-replace') {
    const latest = latestAnalysisTime(current)
    const cutoff = latest > 0 ? latest - retentionMs : -Infinity
    return {
      ...current,
      primaryObservations: update.primaryObservations.filter((point) => point.time >= cutoff),
      secondaryObservations: update.secondaryObservations.filter((point) => point.time >= cutoff),
    }
  }

  const latest = Math.max(latestAnalysisTime(current), latestAnalysisTime(update.snapshot))
  const cutoff = latest > 0 ? latest - retentionMs : -Infinity
  return {
    primaryRpm: appendRetained(current.primaryRpm, update.snapshot.primaryRpm, cutoff),
    secondaryRpm: appendRetained(current.secondaryRpm, update.snapshot.secondaryRpm, cutoff),
    primaryPower: appendRetained(current.primaryPower, update.snapshot.primaryPower, cutoff),
    secondaryPower: appendRetained(current.secondaryPower, update.snapshot.secondaryPower, cutoff),
    ratio: appendRetained(current.ratio, update.snapshot.ratio, cutoff),
    efficiency: appendRetained(current.efficiency, update.snapshot.efficiency, cutoff),
    shift: appendRetained(current.shift, update.snapshot.shift, cutoff),
    primaryObservations: appendRetained(current.primaryObservations, update.snapshot.primaryObservations, cutoff),
    secondaryObservations: appendRetained(current.secondaryObservations, update.snapshot.secondaryObservations, cutoff),
  }
}

export function trimSnapshot(snapshot: AnalysisSnapshot, retentionMs: number): AnalysisSnapshot {
  const latest = latestAnalysisTime(snapshot)
  if (!(latest > 0)) return snapshot
  const cutoff = latest - retentionMs
  return {
    primaryRpm: snapshot.primaryRpm.filter((point) => point.time >= cutoff),
    secondaryRpm: snapshot.secondaryRpm.filter((point) => point.time >= cutoff),
    primaryPower: snapshot.primaryPower.filter((point) => point.time >= cutoff),
    secondaryPower: snapshot.secondaryPower.filter((point) => point.time >= cutoff),
    ratio: snapshot.ratio.filter((point) => point.time >= cutoff),
    efficiency: snapshot.efficiency.filter((point) => point.time >= cutoff),
    shift: snapshot.shift.filter((point) => point.time >= cutoff),
    primaryObservations: snapshot.primaryObservations.filter((point) => point.time >= cutoff),
    secondaryObservations: snapshot.secondaryObservations.filter((point) => point.time >= cutoff),
  }
}

function last<T>(values: readonly T[]): T | undefined { return values[values.length - 1] }

export type CurrentAnalysisMetrics = {
  rpm1: number
  rpm2: number
  shift: number
  power1: number
  power2: number
  efficiency: number
}

export function currentAnalysisMetrics(snapshot: AnalysisSnapshot): CurrentAnalysisMetrics {
  return {
    rpm1: last<RpmPoint>(snapshot.primaryRpm)?.rpm ?? Number.NaN,
    rpm2: last<RpmPoint>(snapshot.secondaryRpm)?.rpm ?? Number.NaN,
    shift: last<ShiftPoint>(snapshot.shift)?.value ?? Number.NaN,
    power1: last<PowerPoint>(snapshot.primaryPower)?.powerKw ?? Number.NaN,
    power2: last<PowerPoint>(snapshot.secondaryPower)?.powerKw ?? Number.NaN,
    efficiency: last<EfficiencyPoint>(snapshot.efficiency)?.efficiencyPct ?? Number.NaN,
  }
}

export function analysisPointCount(snapshot: AnalysisSnapshot): number {
  return snapshot.primaryRpm.length + snapshot.secondaryRpm.length + snapshot.primaryPower.length + snapshot.secondaryPower.length + snapshot.ratio.length + snapshot.efficiency.length + snapshot.shift.length
}

export function findNearestTime<T extends { time: number }>(values: readonly T[], target: number): T | undefined {
  if (!values.length) return undefined
  let low = 0
  let high = values.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid].time < target) low = mid + 1
    else high = mid
  }
  if (low > 0 && Math.abs(values[low - 1].time - target) <= Math.abs(values[low].time - target)) return values[low - 1]
  return values[low]
}

export type { EfficiencyPoint, PowerPoint, RatioPoint, RpmPoint, ShiftPoint }
