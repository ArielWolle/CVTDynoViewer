import type { AnalysisSnapshot, AnalysisUpdate, EfficiencyPoint, PowerPoint, RatioPoint, RpmPoint, ShiftPoint } from './types'

export function createEmptyAnalysisSnapshot(): AnalysisSnapshot {
  return { primaryRpm: [], secondaryRpm: [], primaryPower: [], secondaryPower: [], ratio: [], efficiency: [], shift: [] }
}

export const EMPTY_ANALYSIS_SNAPSHOT: AnalysisSnapshot = createEmptyAnalysisSnapshot()

const timeOf = (point: { time: number }) => point.time

function lowerBoundTime<T extends { time: number }>(values: readonly T[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid].time < target) low = mid + 1
    else high = mid
  }
  return low
}

function appendRetained<T extends { time: number }>(history: readonly T[], next: readonly T[], cutoff: number): T[] {
  const historyStart = lowerBoundTime(history, cutoff)
  const nextStart = lowerBoundTime(next, cutoff)
  if (historyStart === 0 && nextStart >= next.length) return [...history]
  return [...history.slice(historyStart), ...next.slice(nextStart)]
}

function allSeries(snapshot: AnalysisSnapshot): readonly (readonly { time: number }[])[] {
  return [snapshot.primaryRpm, snapshot.secondaryRpm, snapshot.primaryPower, snapshot.secondaryPower, snapshot.ratio, snapshot.efficiency, snapshot.shift]
}

export function latestAnalysisTime(snapshot: AnalysisSnapshot): number {
  let latest = 0
  for (const values of allSeries(snapshot)) if (values.length) latest = Math.max(latest, values[values.length - 1].time)
  return latest
}

export function firstAnalysisTime(snapshot: AnalysisSnapshot): number {
  let first = Infinity
  for (const values of allSeries(snapshot)) if (values.length) first = Math.min(first, values[0].time)
  return Number.isFinite(first) ? first : 0
}

export function applyAnalysisUpdate(current: AnalysisSnapshot, update: AnalysisUpdate, retentionMs: number): AnalysisSnapshot {
  if (update.type === 'replace') return trimSnapshot(update.snapshot, retentionMs)

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
  }
}

export function trimSnapshot(snapshot: AnalysisSnapshot, retentionMs: number): AnalysisSnapshot {
  const latest = latestAnalysisTime(snapshot)
  if (!(latest > 0)) return snapshot
  const cutoff = latest - retentionMs
  const trim = <T extends { time: number }>(values: readonly T[]) => values.slice(lowerBoundTime(values, cutoff))
  return {
    primaryRpm: trim(snapshot.primaryRpm),
    secondaryRpm: trim(snapshot.secondaryRpm),
    primaryPower: trim(snapshot.primaryPower),
    secondaryPower: trim(snapshot.secondaryPower),
    ratio: trim(snapshot.ratio),
    efficiency: trim(snapshot.efficiency),
    shift: trim(snapshot.shift),
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
