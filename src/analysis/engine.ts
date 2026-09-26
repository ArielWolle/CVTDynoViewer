import { enginePowerKwFromRpm } from './engineCurve'
import type {
  AnalysisConfig,
  AnalysisCounts,
  AnalysisPacket,
  AnalysisSnapshot,
  EfficiencyPoint,
  PowerPoint,
  RatioPoint,
  RpmObservation,
  RpmObservationMode,
  RpmObservationView,
  RpmPoint,
  ShiftPoint,
} from './types'

const US_PER_MINUTE = 60_000_000
const RPM_TO_RAD_S = (2 * Math.PI) / 60
const EDGE_TIMESTAMP_SIGMA_US = 1
const DELTA_TIMESTAMP_SIGMA_US = Math.SQRT2 * EDGE_TIMESTAMP_SIGMA_US

type EdgeSample = { tUs: number; edgeCount: number; periodUs: number; epoch: number }
type ScalarSample = { tUs: number; value: number }
type RpmSampleUs = { tUs: number; rpm: number; sigmaRpm: number; epoch: number }
type InternalShaft = 0 | 1

type SeriesMaps = {
  rpm: [Map<number, RpmPoint>, Map<number, RpmPoint>]
  power: [Map<number, PowerPoint>, Map<number, PowerPoint>]
  ratio: Map<number, RatioPoint>
  efficiency: Map<number, EfficiencyPoint>
}

function lowerBound<T extends { tUs: number }>(samples: readonly T[], tUs: number): number {
  let low = 0
  let high = samples.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (samples[mid].tUs < tUs) low = mid + 1
    else high = mid
  }
  return low
}

function upperBound<T extends { tUs: number }>(samples: readonly T[], tUs: number): number {
  let low = 0
  let high = samples.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (samples[mid].tUs <= tUs) low = mid + 1
    else high = mid
  }
  return low
}

function interpolateRpm(samples: readonly RpmSampleUs[], tUs: number): RpmSampleUs | null {
  if (!samples.length || tUs < samples[0].tUs || tUs > samples[samples.length - 1].tUs) return null
  const rightIndex = lowerBound(samples, tUs)
  if (rightIndex >= samples.length) return null
  const right = samples[rightIndex]
  if (right.tUs === tUs) return { ...right, tUs }
  if (rightIndex === 0) return null
  const left = samples[rightIndex - 1]
  if (left.epoch !== right.epoch) return null
  const dt = right.tUs - left.tUs
  if (dt <= 0) return null
  const f = (tUs - left.tUs) / dt
  return {
    tUs,
    rpm: left.rpm + (right.rpm - left.rpm) * f,
    sigmaRpm: Math.sqrt((1 - f) ** 2 * left.sigmaRpm ** 2 + f ** 2 * right.sigmaRpm ** 2),
    epoch: left.epoch,
  }
}

function intervalRpmPoints(samples: readonly RpmSampleUs[], startUs: number, endUs: number): RpmSampleUs[] | null {
  if (endUs <= startUs) return null
  const start = interpolateRpm(samples, startUs)
  const end = interpolateRpm(samples, endUs)
  if (!start || !end || start.epoch !== end.epoch) return null
  const firstInside = upperBound(samples, startUs)
  const afterInside = lowerBound(samples, endUs)
  for (let i = firstInside; i < afterInside; i += 1) if (samples[i].epoch !== start.epoch) return null
  return [start, ...samples.slice(firstInside, afterInside), end]
}

function timeAverageFunction(samples: readonly RpmSampleUs[], startUs: number, endUs: number, fn: (rpm: number) => number): number | null {
  const points = intervalRpmPoints(samples, startUs, endUs)
  if (!points) return null
  let integral = 0
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    integral += 0.5 * (fn(a.rpm) + fn(b.rpm)) * (b.tUs - a.tUs)
  }
  return integral / (endUs - startUs)
}

function timeAverageRatio(primary: readonly RpmSampleUs[], secondary: readonly RpmSampleUs[], startUs: number, endUs: number): number | null {
  const pInterval = intervalRpmPoints(primary, startUs, endUs)
  const sInterval = intervalRpmPoints(secondary, startUs, endUs)
  if (!pInterval || !sInterval) return null

  const times = new Set<number>([startUs, endUs])
  for (const point of pInterval) if (point.tUs > startUs && point.tUs < endUs) times.add(point.tUs)
  for (const point of sInterval) if (point.tUs > startUs && point.tUs < endUs) times.add(point.tUs)
  const sorted = [...times].sort((a, b) => a - b)

  const ratioAt = (tUs: number): number | null => {
    const p = interpolateRpm(primary, tUs)
    const s = interpolateRpm(secondary, tUs)
    if (!p || !s || !(s.rpm > 0)) return null
    return p.rpm / s.rpm
  }

  let previous = ratioAt(sorted[0])
  if (previous === null) return null
  let integral = 0
  for (let i = 1; i < sorted.length; i += 1) {
    const current = ratioAt(sorted[i])
    if (current === null) return null
    integral += 0.5 * (previous + current) * (sorted[i] - sorted[i - 1])
    previous = current
  }
  return integral / (endUs - startUs)
}

function latestHeld(samples: readonly ScalarSample[], tUs: number): number | null {
  const index = upperBound(samples, tUs) - 1
  return index >= 0 ? samples[index].value : null
}

function averageMeasuredPowerKw(
  rpmSamples: readonly RpmSampleUs[],
  torqueSamples: readonly ScalarSample[],
  startUs: number,
  endUs: number,
  torqueScale: number,
  torqueOffset: number,
): number | null {
  if (endUs <= startUs || !torqueSamples.length || torqueSamples[torqueSamples.length - 1].tUs < endUs) return null
  const rpmPoints = intervalRpmPoints(rpmSamples, startUs, endUs)
  if (!rpmPoints || latestHeld(torqueSamples, startUs) === null) return null

  const times = new Set<number>([startUs, endUs])
  for (const point of rpmPoints) if (point.tUs > startUs && point.tUs < endUs) times.add(point.tUs)
  const torqueStart = upperBound(torqueSamples, startUs)
  const torqueEnd = upperBound(torqueSamples, endUs)
  for (let i = torqueStart; i < torqueEnd; i += 1) times.add(torqueSamples[i].tUs)
  const sorted = [...times].sort((a, b) => a - b)

  const powerAt = (tUs: number): number | null => {
    const rpm = interpolateRpm(rpmSamples, tUs)?.rpm
    const rawTorque = latestHeld(torqueSamples, tUs)
    if (rpm === undefined || rawTorque === null) return null
    const torqueNm = (rawTorque - torqueOffset) * torqueScale
    return torqueNm * rpm * RPM_TO_RAD_S / 1000
  }

  let integral = 0
  let previous = powerAt(sorted[0])
  if (previous === null) return null
  for (let i = 1; i < sorted.length; i += 1) {
    const current = powerAt(sorted[i])
    if (current === null) return null
    integral += 0.5 * (previous + current) * (sorted[i] - sorted[i - 1])
    previous = current
  }
  return integral / (endUs - startUs)
}

function toothObservation(edge: EdgeSample, teeth: number): RpmSampleUs | null {
  if (edge.periodUs <= 0 || teeth <= 0) return null
  const rpm = US_PER_MINUTE / (edge.periodUs * teeth)
  return { tUs: edge.tUs, rpm, sigmaRpm: rpm * DELTA_TIMESTAMP_SIGMA_US / edge.periodUs, epoch: edge.epoch }
}

function revolutionObservation(edges: readonly EdgeSample[], index: number, teeth: number): RpmSampleUs | null {
  if (teeth <= 0 || index < teeth) return null
  const current = edges[index]
  const previous = edges[index - teeth]
  if (current.epoch !== previous.epoch) return null
  if ((((current.edgeCount >>> 0) - (previous.edgeCount >>> 0)) >>> 0) !== teeth) return null
  const dtUs = current.tUs - previous.tUs
  if (dtUs <= 0) return null
  const rpm = US_PER_MINUTE / dtUs
  return {
    tUs: 0.5 * (current.tUs + previous.tUs),
    rpm,
    sigmaRpm: rpm * DELTA_TIMESTAMP_SIGMA_US / dtUs,
    epoch: current.epoch,
  }
}

function externalObservation(sample: RpmSampleUs): RpmObservation {
  return { time: sample.tUs / 1000, rpm: sample.rpm, sigmaRpm: sample.sigmaRpm }
}

function lowerBoundSampleTime(values: readonly RpmSampleUs[], targetUs: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid].tUs < targetUs) low = mid + 1
    else high = mid
  }
  return low
}

function upperBoundSampleTime(values: readonly RpmSampleUs[], targetUs: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid].tUs <= targetUs) low = mid + 1
    else high = mid
  }
  return low
}

function sliceRpmSamples(values: readonly RpmSampleUs[], startUs: number, endUs: number): readonly RpmSampleUs[] {
  if (!values.length || endUs < startUs) return []
  return values.slice(lowerBoundSampleTime(values, startUs), upperBoundSampleTime(values, endUs))
}

function downsampleObservationSamples(values: readonly RpmSampleUs[], maxPoints: number): RpmSampleUs[] {
  if (values.length <= maxPoints) return [...values]
  if (maxPoints <= 1) return [values[0]]
  const result: RpmSampleUs[] = []
  const scale = (values.length - 1) / (maxPoints - 1)
  for (let index = 0; index < maxPoints; index += 1) result.push(values[Math.round(index * scale)])
  return result
}

function emptySnapshot(): AnalysisSnapshot {
  return { primaryRpm: [], secondaryRpm: [], primaryPower: [], secondaryPower: [], ratio: [], efficiency: [], shift: [] }
}

export class AnalysisEngine {
  private config: AnalysisConfig
  private packetHistory: AnalysisPacket[] = []
  private edges: [EdgeSample[], EdgeSample[]] = [[], []]
  private revolutionObservations: [RpmSampleUs[], RpmSampleUs[]] = [[], []]
  private toothObservations: [RpmSampleUs[], RpmSampleUs[]] = [[], []]
  private torqueSamples: [ScalarSample[], ScalarSample[]] = [[], []]
  private shiftPoints: ShiftPoint[] = []
  private shiftEpoch = 0
  private lastShiftSeq: number | null = null
  private rpmEpochBreakPending: [boolean, boolean] = [false, false]
  private nextGridUs: [number | null, number | null] = [null, null]
  private pendingTorquePower: [Set<number>, Set<number>] = [new Set(), new Set()]

  private primaryRpm: RpmPoint[] = []
  private secondaryRpm: RpmPoint[] = []
  private primaryPower: PowerPoint[] = []
  private secondaryPower: PowerPoint[] = []
  private ratio: RatioPoint[] = []
  private efficiency: EfficiencyPoint[] = []
  private maps: SeriesMaps = {
    rpm: [new Map(), new Map()],
    power: [new Map(), new Map()],
    ratio: new Map(),
    efficiency: new Map(),
  }

  constructor(config: AnalysisConfig) {
    this.config = this.copyConfig(config)
  }

  reset() {
    this.packetHistory = []
    this.resetDerived()
  }

  setConfig(config: AnalysisConfig) {
    this.config = this.copyConfig(config)
    const history = this.packetHistory
    this.resetDerived()
    for (const packet of history) this.process(packet)
  }

  ingest(packet: AnalysisPacket) {
    if (!Number.isFinite(packet.tUs) || packet.tUs <= 0) return
    this.packetHistory.push(packet)
    this.process(packet)
  }

  ingestMany(packets: readonly AnalysisPacket[]) {
    for (const packet of packets) this.ingest(packet)
  }

  snapshot(): AnalysisSnapshot {
    return this.snapshotFrom(this.zeroCounts())
  }

  counts(): AnalysisCounts {
    return {
      primaryRpm: this.primaryRpm.length,
      secondaryRpm: this.secondaryRpm.length,
      primaryPower: this.primaryPower.length,
      secondaryPower: this.secondaryPower.length,
      ratio: this.ratio.length,
      efficiency: this.efficiency.length,
      shift: this.shiftPoints.length,
    }
  }

  snapshotFrom(counts: AnalysisCounts): AnalysisSnapshot {
    return {
      primaryRpm: this.primaryRpm.slice(counts.primaryRpm),
      secondaryRpm: this.secondaryRpm.slice(counts.secondaryRpm),
      primaryPower: this.primaryPower.slice(counts.primaryPower),
      secondaryPower: this.secondaryPower.slice(counts.secondaryPower),
      ratio: this.ratio.slice(counts.ratio),
      efficiency: this.efficiency.slice(counts.efficiency),
      shift: this.shiftPoints.slice(counts.shift),
    }
  }

  observationView(mode: RpmObservationMode, startMs: number, endMs: number, maxPoints: number): RpmObservationView {
    if (mode === 'none' || !(endMs >= startMs) || maxPoints <= 0) return { primary: [], secondary: [] }
    const observations = mode === 'tooth' ? this.toothObservations : this.revolutionObservations
    const startUs = startMs * 1000
    const endUs = endMs * 1000
    const slice = (values: readonly RpmSampleUs[]) => {
      const visible = sliceRpmSamples(values, startUs, endUs)
      return downsampleObservationSamples(visible, maxPoints).map(externalObservation)
    }
    return { primary: slice(observations[0]), secondary: slice(observations[1]) }
  }

  private process(packet: AnalysisPacket) {
    if (packet.channel === 0 || packet.channel === 1) this.ingestRpm(packet.channel, packet)
    else if (packet.channel === 2) this.ingestShift(packet)
    else if (packet.channel === 3) this.ingestTorque(0, packet)
    else if (packet.channel === 4) this.ingestTorque(1, packet)
    // Channel 5 is intentionally preserved in the raw stream but has no analysis role at present.
  }

  private ingestRpm(channel: InternalShaft, packet: AnalysisPacket) {
    if (packet.value <= 0) {
      // Protocol value === 0 is the firmware's explicit "shaft stopped" measurement.
      if (packet.value === 0) this.storeStoppedRpm(channel, packet.tUs)
      this.rpmEpochBreakPending[channel] = true
      this.nextGridUs[channel] = null
      return
    }
    const edges = this.edges[channel]
    const previous = edges[edges.length - 1]
    const contiguous = previous && !this.rpmEpochBreakPending[channel]
      && ((((packet.edgeCount >>> 0) - (previous.edgeCount >>> 0)) >>> 0) === 1)
      && packet.tUs > previous.tUs
    const epoch = previous ? (contiguous ? previous.epoch : previous.epoch + 1) : 0
    if (previous && !contiguous) this.nextGridUs[channel] = null
    const edge: EdgeSample = { tUs: packet.tUs, edgeCount: packet.edgeCount >>> 0, periodUs: packet.value, epoch }
    this.rpmEpochBreakPending[channel] = false
    edges.push(edge)

    const teeth = channel === 0 ? this.config.primaryTeeth : this.config.secondaryTeeth
    const tooth = toothObservation(edge, teeth)
    if (tooth) this.toothObservations[channel].push(tooth)
    const revolution = revolutionObservation(edges, edges.length - 1, teeth)
    if (revolution) {
      this.revolutionObservations[channel].push(revolution)
      this.advanceShaft(channel)
    }
  }

  private ingestShift(packet: AnalysisPacket) {
    if (this.lastShiftSeq !== null && (((packet.seq - this.lastShiftSeq - 1) & 0xff) !== 0)) this.shiftEpoch += 1
    this.lastShiftSeq = packet.seq
    this.shiftPoints.push({ time: packet.tUs / 1000, value: packet.value, epoch: this.shiftEpoch })
  }

  private ingestTorque(channel: InternalShaft, packet: AnalysisPacket) {
    this.torqueSamples[channel].push({ tUs: packet.tUs, value: packet.value })
    if (this.config.powerMode !== 'torque') return
    this.retryPendingTorquePower(channel)
  }

  private advanceShaft(channel: InternalShaft) {
    const observations = this.revolutionObservations[channel]
    if (!observations.length) return
    const windowUs = this.windowUs()
    if (!(windowUs > 0)) return

    if (this.nextGridUs[channel] === null) {
      // After a stop/epoch break, observations[0] may be minutes old. Seed from the newest valid
      // observation so a 5 ms grid never walks the entire stopped interval just to reject it.
      this.nextGridUs[channel] = Math.ceil(observations[observations.length - 1].tUs / windowUs) * windowUs
    }
    const latestUs = observations[observations.length - 1].tUs
    while (this.nextGridUs[channel] !== null && this.nextGridUs[channel]! <= latestUs) {
      const endUs: number = this.nextGridUs[channel]!
      const rpm = interpolateRpm(observations, endUs)
      if (rpm) this.storeRpm(channel, endUs, rpm)
      this.tryFinalizePower(channel, endUs)
      this.nextGridUs[channel] = endUs + windowUs
    }
  }

  private storeRpm(channel: InternalShaft, endUs: number, sample: RpmSampleUs) {
    if (this.maps.rpm[channel].has(endUs)) return
    const point: RpmPoint = { time: endUs / 1000, rpm: sample.rpm, sigmaRpm: sample.sigmaRpm, epoch: sample.epoch }
    this.maps.rpm[channel].set(endUs, point)
    ;(channel === 0 ? this.primaryRpm : this.secondaryRpm).push(point)
    this.tryRatio(endUs)
  }

  private storeStoppedRpm(channel: InternalShaft, tUs: number) {
    if (this.maps.rpm[channel].has(tUs)) return
    const epoch = this.revolutionObservations[channel].at(-1)?.epoch ?? this.edges[channel].at(-1)?.epoch ?? 0
    const point: RpmPoint = { time: tUs / 1000, rpm: 0, sigmaRpm: 0, epoch }
    this.maps.rpm[channel].set(tUs, point)
    ;(channel === 0 ? this.primaryRpm : this.secondaryRpm).push(point)
    this.tryRatio(tUs)

    // P = tau * omega is zero at an explicit stationary endpoint in either supported power mode.
    if (!this.maps.power[channel].has(tUs)) {
      const power: PowerPoint = { time: tUs / 1000, powerKw: 0 }
      this.maps.power[channel].set(tUs, power)
      ;(channel === 0 ? this.primaryPower : this.secondaryPower).push(power)
      this.tryEfficiency(tUs)
    }
  }

  private tryFinalizePower(channel: InternalShaft, endUs: number) {
    if (this.maps.power[channel].has(endUs)) return
    const startUs = endUs - this.windowUs()
    const rpmSamples = this.revolutionObservations[channel]
    let powerKw: number | null = null

    if (this.config.powerMode === 'inertia') {
      if (channel === 0) {
        powerKw = timeAverageFunction(rpmSamples, startUs, endUs, (rpm) => enginePowerKwFromRpm(rpm, this.config.torqueCurve))
      } else {
        const start = interpolateRpm(rpmSamples, startUs)
        const end = interpolateRpm(rpmSamples, endUs)
        if (start && end && start.epoch === end.epoch) {
          const dtSeconds = (endUs - startUs) / 1_000_000
          const w0 = start.rpm * RPM_TO_RAD_S
          const w1 = end.rpm * RPM_TO_RAD_S
          powerKw = this.config.secondaryInertiaKgM2 * (w1 * w1 - w0 * w0) / (2 * dtSeconds) / 1000
        }
      }
    } else {
      const torque = this.torqueSamples[channel]
      if (!torque.length || torque[torque.length - 1].tUs < endUs) {
        this.pendingTorquePower[channel].add(endUs)
        return
      }
      powerKw = averageMeasuredPowerKw(rpmSamples, torque, startUs, endUs, this.config.torqueScale, this.config.torqueOffset)
    }

    if (powerKw === null || !Number.isFinite(powerKw)) return
    const point: PowerPoint = { time: endUs / 1000, powerKw }
    this.maps.power[channel].set(endUs, point)
    ;(channel === 0 ? this.primaryPower : this.secondaryPower).push(point)
    this.pendingTorquePower[channel].delete(endUs)
    this.tryEfficiency(endUs)
  }

  private retryPendingTorquePower(channel: InternalShaft) {
    const torque = this.torqueSamples[channel]
    const rpm = this.revolutionObservations[channel]
    if (!torque.length || !rpm.length) return
    const maxReady = Math.min(torque[torque.length - 1].tUs, rpm[rpm.length - 1].tUs)
    for (const endUs of [...this.pendingTorquePower[channel]]) {
      if (endUs > maxReady) continue
      this.tryFinalizePower(channel, endUs)
      // Once both input streams have progressed past an interval it can never become newly valid.
      if (!this.maps.power[channel].has(endUs)) this.pendingTorquePower[channel].delete(endUs)
    }
  }

  private tryRatio(endUs: number) {
    if (this.maps.ratio.has(endUs)) return
    const primary = this.maps.rpm[0].get(endUs)
    const secondary = this.maps.rpm[1].get(endUs)
    if (!primary || !secondary || secondary.rpm === 0) return
    const point: RatioPoint = { time: endUs / 1000, rpm1: primary.rpm, rpm2: secondary.rpm, ratio: primary.rpm / secondary.rpm }
    this.maps.ratio.set(endUs, point)
    this.ratio.push(point)
    // Efficiency may already exist in an unusual torque arrival ordering; enrich it only by creating
    // the point when both power inputs exist, never by rewriting older RPM/power series.
    this.tryEfficiency(endUs)
  }

  private tryEfficiency(endUs: number) {
    if (this.maps.efficiency.has(endUs)) return
    const primary = this.maps.power[0].get(endUs)
    const secondary = this.maps.power[1].get(endUs)
    if (!primary || !secondary) return
    if (!(primary.powerKw > 0) || !(secondary.powerKw >= 0)) return

    // Pair interval efficiency with the average speed ratio over the exact same physical interval.
    // ratio-vs-time remains a synchronized point ratio at endUs; this interval ratio is specifically
    // for the efficiency-vs-ratio relationship.
    const startUs = endUs - this.windowUs()
    const ratio = timeAverageRatio(this.revolutionObservations[0], this.revolutionObservations[1], startUs, endUs)
    if (ratio === null) return

    const efficiencyPct = 100 * secondary.powerKw / primary.powerKw
    if (!Number.isFinite(efficiencyPct)) return
    const point: EfficiencyPoint = {
      time: endUs / 1000,
      power1Kw: primary.powerKw,
      power2Kw: secondary.powerKw,
      efficiencyPct,
      ratio,
    }
    this.maps.efficiency.set(endUs, point)
    this.efficiency.push(point)
  }

  private windowUs() { return this.config.windowMs * 1000 }

  private copyConfig(config: AnalysisConfig): AnalysisConfig {
    return { ...config, torqueCurve: [...config.torqueCurve] }
  }

  private zeroCounts(): AnalysisCounts {
    return { primaryRpm: 0, secondaryRpm: 0, primaryPower: 0, secondaryPower: 0, ratio: 0, efficiency: 0, shift: 0 }
  }

  private resetDerived() {
    this.edges = [[], []]
    this.revolutionObservations = [[], []]
    this.toothObservations = [[], []]
    this.torqueSamples = [[], []]
    this.shiftPoints = []
    this.shiftEpoch = 0
    this.lastShiftSeq = null
    this.rpmEpochBreakPending = [false, false]
    this.nextGridUs = [null, null]
    this.pendingTorquePower = [new Set(), new Set()]
    this.primaryRpm = []
    this.secondaryRpm = []
    this.primaryPower = []
    this.secondaryPower = []
    this.ratio = []
    this.efficiency = []
    this.maps = { rpm: [new Map(), new Map()], power: [new Map(), new Map()], ratio: new Map(), efficiency: new Map() }
  }
}

export { emptySnapshot }
