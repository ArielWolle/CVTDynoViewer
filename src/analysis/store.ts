import { downsampleForChart } from '../downsample'
import type {
  AnalysisSnapshot,
  AnalysisUpdate,
  EfficiencyPoint,
  PowerPoint,
  RatioPoint,
  RpmPoint,
  ShiftPoint,
} from './types'

export type AnalysisSeriesKey = keyof AnalysisSnapshot
export type WithSeconds<T> = T & { seconds: number }
export type PowerRow = { time: number; seconds: number; power1?: number; power2?: number }
export type NearestOptions = { minTime?: number; maxTime?: number; maxDelta?: number }

export type CurrentAnalysisMetrics = {
  rpm1: number
  rpm2: number
  shift: number
  power1: number
  power2: number
  efficiency: number
}

export type AnalysisStoreStatus = {
  revision: number
  generation: number
  firstTime: number
  latestTime: number
  totalCount: number
  counts: Record<AnalysisSeriesKey, number>
  current: CurrentAnalysisMetrics
}

export type AnalysisViewportView = {
  primaryRpm: WithSeconds<RpmPoint>[]
  secondaryRpm: WithSeconds<RpmPoint>[]
  shift: WithSeconds<ShiftPoint>[]
  ratioDots: WithSeconds<RatioPoint>[]
  ratioTime: WithSeconds<RatioPoint>[]
  efficiencyDots: WithSeconds<EfficiencyPoint>[]
  efficiencyTime: WithSeconds<EfficiencyPoint>[]
  power: PowerRow[]
}

type TimePoint = { time: number }
type SeriesPoint = RpmPoint | PowerPoint | RatioPoint | EfficiencyPoint | ShiftPoint

const SERIES_KEYS: AnalysisSeriesKey[] = [
  'primaryRpm',
  'secondaryRpm',
  'primaryPower',
  'secondaryPower',
  'ratio',
  'efficiency',
  'shift',
]

const DEFAULT_CHUNK_SIZE = 1024

function lowerBoundTime<T extends TimePoint>(values: readonly T[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid].time < target) low = mid + 1
    else high = mid
  }
  return low
}

function upperBoundTime<T extends TimePoint>(values: readonly T[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid].time <= target) low = mid + 1
    else high = mid
  }
  return low
}

type MutationInfo = {
  revision: number
  minTime: number
  maxTime: number
  appendOnlyAtEnd: boolean
}

class ChunkedTimeSeries<T extends TimePoint> {
  private chunks: T[][] = []
  private _length = 0
  private _revision = 0
  private _mutation: MutationInfo = {
    revision: 0,
    minTime: Infinity,
    maxTime: -Infinity,
    appendOnlyAtEnd: true,
  }

  constructor(private readonly chunkSize = DEFAULT_CHUNK_SIZE) {}

  get length() { return this._length }
  get revision() { return this._revision }
  get mutation() { return this._mutation }

  first(): T | undefined {
    return this.chunks[0]?.[0]
  }

  last(): T | undefined {
    const chunk = this.chunks[this.chunks.length - 1]
    return chunk?.[chunk.length - 1]
  }


  replace(values: readonly T[]) {
    this.chunks = []
    this._length = 0
    if (values.length) this.appendToChunks(values)
    this.bumpMutation(
      values[0]?.time ?? Infinity,
      values[values.length - 1]?.time ?? -Infinity,
      false,
    )
  }

  append(values: readonly T[]): boolean {
    if (!values.length) return false

    const previousLast = this.last()
    const firstNew = values[0]
    const lastNew = values[values.length - 1]
    const internallyOrdered = values.every((point, index) => index === 0 || values[index - 1].time <= point.time)
    const canFastAppend = internallyOrdered && (!previousLast || firstNew.time > previousLast.time)

    if (canFastAppend) {
      this.appendToChunks(values)
      this.bumpMutation(firstNew.time, lastNew.time, true)
      return true
    }

    // This should be rare (the analysis worker emits each individual series in time order), but
    // keep the store correct if a future producer supplies a late point. Last value wins on an
    // exact timestamp collision, matching a keyed-series update rather than duplicating a sample.
    const merged = [...this.toArray(), ...values].sort((a, b) => a.time - b.time)
    const deduped: T[] = []
    for (const point of merged) {
      const previous = deduped[deduped.length - 1]
      if (previous && previous.time === point.time) deduped[deduped.length - 1] = point
      else deduped.push(point)
    }
    this.chunks = []
    this._length = 0
    this.appendToChunks(deduped)
    this.bumpMutation(
      Math.min(previousLast?.time ?? Infinity, firstNew.time),
      Math.max(previousLast?.time ?? -Infinity, lastNew.time),
      false,
    )
    return true
  }

  slice(start: number, end: number): T[] {
    if (!this._length || end < start) return []

    const firstChunk = this.findFirstChunkWhoseLastIsAtLeast(start)
    if (firstChunk >= this.chunks.length) return []

    const result: T[] = []
    for (let chunkIndex = firstChunk; chunkIndex < this.chunks.length; chunkIndex += 1) {
      const chunk = this.chunks[chunkIndex]
      if (!chunk.length) continue
      if (chunk[0].time > end) break
      const from = lowerBoundTime(chunk, start)
      const to = upperBoundTime(chunk, end)
      for (let index = from; index < to; index += 1) result.push(chunk[index])
      if (chunk[chunk.length - 1].time > end) break
    }
    return result
  }

  nearest(target: number, options: NearestOptions = {}): T | undefined {
    if (!this._length) return undefined
    const minTime = options.minTime ?? -Infinity
    const maxTime = options.maxTime ?? Infinity
    const maxDelta = options.maxDelta ?? Infinity
    if (maxTime < minTime || maxDelta < 0) return undefined

    const searchTarget = Math.min(maxTime, Math.max(minTime, target))
    const chunkIndex = Math.min(
      this.findFirstChunkWhoseLastIsAtLeast(searchTarget),
      this.chunks.length - 1,
    )
    let best: T | undefined
    let bestDelta = Infinity
    for (let candidateChunk = Math.max(0, chunkIndex - 1); candidateChunk <= Math.min(this.chunks.length - 1, chunkIndex + 1); candidateChunk += 1) {
      const chunk = this.chunks[candidateChunk]
      const index = lowerBoundTime(chunk, searchTarget)
      for (const candidateIndex of [index - 1, index]) {
        if (candidateIndex < 0 || candidateIndex >= chunk.length) continue
        const point = chunk[candidateIndex]
        if (point.time < minTime || point.time > maxTime) continue
        const delta = Math.abs(point.time - target)
        if (delta <= maxDelta && delta < bestDelta) {
          best = point
          bestDelta = delta
        }
      }
    }
    return best
  }

  toArray(): T[] {
    const result = new Array<T>(this._length)
    let cursor = 0
    for (const chunk of this.chunks) {
      for (const point of chunk) result[cursor++] = point
    }
    return result
  }

  private appendToChunks(values: readonly T[]) {
    for (const point of values) {
      let chunk = this.chunks[this.chunks.length - 1]
      if (!chunk || chunk.length >= this.chunkSize) {
        chunk = []
        this.chunks.push(chunk)
      }
      chunk.push(point)
      this._length += 1
    }
  }

  private bumpMutation(minTime: number, maxTime: number, appendOnlyAtEnd: boolean) {
    this._revision += 1
    this._mutation = {
      revision: this._revision,
      minTime,
      maxTime,
      appendOnlyAtEnd,
    }
  }

  private findFirstChunkWhoseLastIsAtLeast(target: number): number {
    let low = 0
    let high = this.chunks.length
    while (low < high) {
      const mid = (low + high) >> 1
      const chunk = this.chunks[mid]
      const last = chunk[chunk.length - 1]
      if (!last || last.time < target) low = mid + 1
      else high = mid
    }
    return low
  }
}

type MappedCache<T extends TimePoint> = {
  seriesRevision: number
  start: number
  end: number
  origin: number
  full: WithSeconds<T>[]
  rendered: WithSeconds<T>[]
}

function mapSeconds<T extends TimePoint>(point: T, origin: number): WithSeconds<T> {
  return { ...point, seconds: (point.time - origin) / 1000 }
}

class ViewportSeriesCache<T extends TimePoint> {
  private cache: MappedCache<T> | null = null

  reset() {
    this.cache = null
  }

  get(
    series: ChunkedTimeSeries<T>,
    start: number,
    end: number,
    origin: number,
    maxPoints: number,
  ): MappedCache<T> {
    const previous = this.cache
    if (
      previous
      && previous.seriesRevision === series.revision
      && previous.start === start
      && previous.end === end
      && previous.origin === origin
    ) return previous

    const mutation = series.mutation

    // A frozen/static viewport should be completely inert when a series only appends points to the
    // right of it. Advance the cache's observed revision without allocating a replacement array.
    if (
      previous
      && previous.origin === origin
      && previous.start === start
      && previous.end === end
      && mutation.appendOnlyAtEnd
      && mutation.revision !== previous.seriesRevision
      && mutation.minTime > end
    ) {
      previous.seriesRevision = series.revision
      return previous
    }

    const canSlideForward = Boolean(
      previous
      && previous.origin === origin
      && start >= previous.start
      && end >= previous.end
      && mutation.appendOnlyAtEnd
      && (
        mutation.revision === previous.seriesRevision
        || mutation.minTime > previous.end
      )
    )

    let full: WithSeconds<T>[]
    if (canSlideForward && previous) {
      const keepFrom = lowerBoundTime(previous.full, start)
      const kept = previous.full.slice(keepFrom)
      const appendStart = Math.max(previous.end, start)
      const newlyVisible = series
        .slice(appendStart, end)
        .filter((point) => point.time > previous.end)
        .map((point) => mapSeconds(point, origin))
      full = newlyVisible.length ? [...kept, ...newlyVisible] : kept
    } else {
      full = series.slice(start, end).map((point) => mapSeconds(point, origin))
    }

    const rendered = downsampleForChart(full, maxPoints)
    this.cache = {
      seriesRevision: series.revision,
      start,
      end,
      origin,
      full,
      rendered,
    }
    return this.cache
  }
}

type PowerCache = {
  primaryRevision: number
  secondaryRevision: number
  start: number
  end: number
  origin: number
  rendered: PowerRow[]
}

function mergePowerRows(
  primary: readonly PowerPoint[],
  secondary: readonly PowerPoint[],
  origin: number,
): PowerRow[] {
  const rows: PowerRow[] = []
  let i = 0
  let j = 0
  while (i < primary.length || j < secondary.length) {
    const p = primary[i]
    const s = secondary[j]
    if (p && (!s || p.time < s.time)) {
      rows.push({ time: p.time, seconds: (p.time - origin) / 1000, power1: p.powerKw })
      i += 1
    } else if (s && (!p || s.time < p.time)) {
      rows.push({ time: s.time, seconds: (s.time - origin) / 1000, power2: s.powerKw })
      j += 1
    } else if (p && s) {
      rows.push({
        time: p.time,
        seconds: (p.time - origin) / 1000,
        power1: p.powerKw,
        power2: s.powerKw,
      })
      i += 1
      j += 1
    }
  }
  return rows
}

class AnalysisViewportCache {
  private primaryRpm = new ViewportSeriesCache<RpmPoint>()
  private secondaryRpm = new ViewportSeriesCache<RpmPoint>()
  private shift = new ViewportSeriesCache<ShiftPoint>()
  private ratio = new ViewportSeriesCache<RatioPoint>()
  private efficiency = new ViewportSeriesCache<EfficiencyPoint>()
  private powerCache: PowerCache | null = null
  private lastKey = ''
  private lastView: AnalysisViewportView | null = null

  reset() {
    this.primaryRpm.reset()
    this.secondaryRpm.reset()
    this.shift.reset()
    this.ratio.reset()
    this.efficiency.reset()
    this.powerCache = null
    this.lastKey = ''
    this.lastView = null
  }

  view(store: AnalysisStore, start: number, end: number, origin: number, maxPoints: number): AnalysisViewportView {
    const key = `${store.statusRevision()}|${start}|${end}|${origin}|${maxPoints}`
    if (this.lastView && key === this.lastKey) return this.lastView

    const primaryRpm = this.primaryRpm.get(store.primaryRpm, start, end, origin, maxPoints).rendered
    const secondaryRpm = this.secondaryRpm.get(store.secondaryRpm, start, end, origin, maxPoints).rendered
    const shift = this.shift.get(store.shift, start, end, origin, maxPoints).rendered
    const ratioView = this.ratio.get(store.ratio, start, end, origin, maxPoints)
    const efficiencyView = this.efficiency.get(store.efficiency, start, end, origin, maxPoints)

    const power = this.power(store, start, end, origin, maxPoints)
    const view: AnalysisViewportView = {
      primaryRpm,
      secondaryRpm,
      shift,
      ratioDots: ratioView.full,
      ratioTime: ratioView.rendered,
      efficiencyDots: efficiencyView.full,
      efficiencyTime: efficiencyView.rendered,
      power,
    }
    this.lastKey = key
    this.lastView = view
    return view
  }

  private power(store: AnalysisStore, start: number, end: number, origin: number, maxPoints: number): PowerRow[] {
    const cached = this.powerCache
    if (
      cached
      && cached.primaryRevision === store.primaryPower.revision
      && cached.secondaryRevision === store.secondaryPower.revision
      && cached.start === start
      && cached.end === end
      && cached.origin === origin
    ) return cached.rendered

    const rows = mergePowerRows(
      store.primaryPower.slice(start, end),
      store.secondaryPower.slice(start, end),
      origin,
    )
    const rendered = downsampleForChart(rows, maxPoints)
    this.powerCache = {
      primaryRevision: store.primaryPower.revision,
      secondaryRevision: store.secondaryPower.revision,
      start,
      end,
      origin,
      rendered,
    }
    return rendered
  }
}


export class AnalysisStore {
  readonly primaryRpm = new ChunkedTimeSeries<RpmPoint>()
  readonly secondaryRpm = new ChunkedTimeSeries<RpmPoint>()
  readonly primaryPower = new ChunkedTimeSeries<PowerPoint>()
  readonly secondaryPower = new ChunkedTimeSeries<PowerPoint>()
  readonly ratio = new ChunkedTimeSeries<RatioPoint>()
  readonly efficiency = new ChunkedTimeSeries<EfficiencyPoint>()
  readonly shift = new ChunkedTimeSeries<ShiftPoint>()

  private revision = 0
  private generation = 0
  private listeners = new Set<() => void>()
  private viewportCache = new AnalysisViewportCache()
  private status = this.buildStatus()
  private structuralStatus = this.status

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getStatusSnapshot = () => this.status
  readonly getStructuralSnapshot = () => this.structuralStatus

  statusRevision() {
    return this.revision
  }

  apply(update: AnalysisUpdate) {
    if (update.type === 'replace') {
      this.replace(update.snapshot)
      return
    }

    let changed = false
    changed = this.primaryRpm.append(update.snapshot.primaryRpm) || changed
    changed = this.secondaryRpm.append(update.snapshot.secondaryRpm) || changed
    changed = this.primaryPower.append(update.snapshot.primaryPower) || changed
    changed = this.secondaryPower.append(update.snapshot.secondaryPower) || changed
    changed = this.ratio.append(update.snapshot.ratio) || changed
    changed = this.efficiency.append(update.snapshot.efficiency) || changed
    changed = this.shift.append(update.snapshot.shift) || changed
    if (changed) this.publish(false)
  }

  reset() {
    this.primaryRpm.replace([])
    this.secondaryRpm.replace([])
    this.primaryPower.replace([])
    this.secondaryPower.replace([])
    this.ratio.replace([])
    this.efficiency.replace([])
    this.shift.replace([])
    this.viewportCache.reset()
    this.publish(true)
  }

  replace(snapshot: AnalysisSnapshot) {
    this.primaryRpm.replace(snapshot.primaryRpm)
    this.secondaryRpm.replace(snapshot.secondaryRpm)
    this.primaryPower.replace(snapshot.primaryPower)
    this.secondaryPower.replace(snapshot.secondaryPower)
    this.ratio.replace(snapshot.ratio)
    this.efficiency.replace(snapshot.efficiency)
    this.shift.replace(snapshot.shift)
    this.viewportCache.reset()
    this.publish(true)
  }

  snapshot(): AnalysisSnapshot {
    return {
      primaryRpm: this.primaryRpm.toArray(),
      secondaryRpm: this.secondaryRpm.toArray(),
      primaryPower: this.primaryPower.toArray(),
      secondaryPower: this.secondaryPower.toArray(),
      ratio: this.ratio.toArray(),
      efficiency: this.efficiency.toArray(),
      shift: this.shift.toArray(),
    }
  }

  viewport(start: number, end: number, origin: number, maxPoints: number): AnalysisViewportView {
    return this.viewportCache.view(this, start, end, origin, maxPoints)
  }

  latestTime(): number {
    return this.status.latestTime
  }

  firstTime(): number {
    return this.status.firstTime
  }

  nearest<K extends AnalysisSeriesKey>(key: K, time: number, options: NearestOptions = {}): AnalysisSnapshot[K][number] | undefined {
    return this.series(key).nearest(time, options) as AnalysisSnapshot[K][number] | undefined
  }


  private series(key: AnalysisSeriesKey): ChunkedTimeSeries<SeriesPoint> {
    return this[key] as unknown as ChunkedTimeSeries<SeriesPoint>
  }

  private publish(structural: boolean) {
    this.revision += 1
    if (structural) this.generation += 1
    this.status = this.buildStatus()
    if (structural) this.structuralStatus = this.status
    for (const listener of this.listeners) listener()
  }

  private buildStatus(): AnalysisStoreStatus {
    const firstCandidates = SERIES_KEYS
      .map((key) => this.series(key).first()?.time)
      .filter((value): value is number => value !== undefined)
    const latestCandidates = SERIES_KEYS
      .map((key) => this.series(key).last()?.time)
      .filter((value): value is number => value !== undefined)

    const counts = {
      primaryRpm: this.primaryRpm.length,
      secondaryRpm: this.secondaryRpm.length,
      primaryPower: this.primaryPower.length,
      secondaryPower: this.secondaryPower.length,
      ratio: this.ratio.length,
      efficiency: this.efficiency.length,
      shift: this.shift.length,
    }

    return {
      revision: this.revision,
      generation: this.generation,
      firstTime: firstCandidates.length ? Math.min(...firstCandidates) : 0,
      latestTime: latestCandidates.length ? Math.max(...latestCandidates) : 0,
      totalCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
      counts,
      current: (() => {
        const primaryPower = this.primaryPower.last()
        const secondaryPower = this.secondaryPower.last()
        const efficiency = this.efficiency.last()
        const efficiencyCurrent = efficiency && primaryPower && secondaryPower
          && efficiency.time === primaryPower.time && efficiency.time === secondaryPower.time
          ? efficiency.efficiencyPct
          : Number.NaN
        return {
          rpm1: this.primaryRpm.last()?.rpm ?? Number.NaN,
          rpm2: this.secondaryRpm.last()?.rpm ?? Number.NaN,
          shift: this.shift.last()?.value ?? Number.NaN,
          power1: primaryPower?.powerKw ?? Number.NaN,
          power2: secondaryPower?.powerKw ?? Number.NaN,
          efficiency: efficiencyCurrent,
        }
      })(),
    }
  }
}

export function createEmptyAnalysisStore() {
  return new AnalysisStore()
}
