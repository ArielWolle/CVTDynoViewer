import { enginePowerKwFromRpm } from './engineCurve'
import type { AnalysisConfig, AnalysisFrame, AnalysisPacket, AnalysisSnapshot, RpmObservation } from './types'

const US_PER_MINUTE = 60_000_000
const RPM_TO_RAD_S = (2 * Math.PI) / 60
// Conservative measurement model used in the offline audit: one captured edge timestamp is treated
// as having 1 us (1 sigma) uncertainty. A difference between two edge timestamps therefore has
// sqrt(2) us uncertainty.
const EDGE_TIMESTAMP_SIGMA_US = 1
const DELTA_TIMESTAMP_SIGMA_US = Math.SQRT2 * EDGE_TIMESTAMP_SIGMA_US

type EdgeSample = { tUs: number; edgeCount: number; periodUs: number; epoch: number }
type ScalarSample = { tUs: number; value: number }
type BoolSample = { tUs: number; value: boolean }
type RpmSampleUs = { tUs: number; rpm: number; sigmaRpm: number; epoch: number }

function interpolateScalar(samples: readonly ScalarSample[], tUs: number): number | null {
  if (samples.length === 0 || tUs < samples[0].tUs || tUs > samples[samples.length - 1].tUs) return null
  let low = 0
  let high = samples.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (samples[mid].tUs < tUs) low = mid + 1
    else high = mid
  }
  if (samples[low].tUs === tUs || low === 0) return samples[low].value
  const right = samples[low]
  const left = samples[low - 1]
  const span = right.tUs - left.tUs
  if (span <= 0) return right.value
  return left.value + (right.value - left.value) * ((tUs - left.tUs) / span)
}

function interpolateRpm(samples: readonly RpmSampleUs[], tUs: number): { rpm: number; sigmaRpm: number; epoch: number } | null {
  if (samples.length === 0 || tUs < samples[0].tUs || tUs > samples[samples.length - 1].tUs) return null
  let low = 0
  let high = samples.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (samples[mid].tUs < tUs) low = mid + 1
    else high = mid
  }
  if (samples[low].tUs === tUs || low === 0) return { rpm: samples[low].rpm, sigmaRpm: samples[low].sigmaRpm, epoch: samples[low].epoch }
  const right = samples[low]
  const left = samples[low - 1]
  const span = right.tUs - left.tUs
  if (span <= 0) return { rpm: right.rpm, sigmaRpm: right.sigmaRpm, epoch: right.epoch }
  if (left.epoch !== right.epoch) return null
  const fraction = (tUs - left.tUs) / span
  const rpm = left.rpm + (right.rpm - left.rpm) * fraction
  const sigmaRpm = Math.sqrt((1 - fraction) ** 2 * left.sigmaRpm ** 2 + fraction ** 2 * right.sigmaRpm ** 2)
  return { rpm, sigmaRpm, epoch: left.epoch }
}

function timeAverageRpm(samples: readonly RpmSampleUs[], startUs: number, endUs: number): { rpm: number; sigmaRpm: number } | null {
  if (endUs <= startUs) return null
  const left = interpolateRpm(samples, startUs)
  const right = interpolateRpm(samples, endUs)
  if (!left || !right) return null

  if (left.epoch !== right.epoch) return null
  const points: { tUs: number; rpm: number; sigmaRpm: number; epoch: number }[] = [{ tUs: startUs, ...left }]
  for (const sample of samples) if (sample.tUs > startUs && sample.tUs < endUs) points.push(sample)
  points.push({ tUs: endUs, ...right })
  if (points.some((point) => point.epoch !== left.epoch)) return null

  let integral = 0
  let varianceIntegral = 0
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]
    const b = points[index]
    const dt = b.tUs - a.tUs
    integral += 0.5 * (a.rpm + b.rpm) * dt
    // Conservative propagation for the trapezoidal average: treat adjacent point errors as independent.
    varianceIntegral += (0.5 * dt) ** 2 * (a.sigmaRpm ** 2 + b.sigmaRpm ** 2)
  }
  const width = endUs - startUs
  return { rpm: integral / width, sigmaRpm: Math.sqrt(varianceIntegral) / width }
}

function timeAverageFunction(samples: readonly RpmSampleUs[], startUs: number, endUs: number, fn: (rpm: number) => number): number | null {
  if (endUs <= startUs) return null
  const left = interpolateRpm(samples, startUs)
  const right = interpolateRpm(samples, endUs)
  if (!left || !right) return null

  if (left.epoch !== right.epoch) return null
  const inside = samples.filter((sample) => sample.tUs > startUs && sample.tUs < endUs)
  if (inside.some((sample) => sample.epoch !== left.epoch)) return null
  const points: { tUs: number; value: number }[] = [{ tUs: startUs, value: fn(left.rpm) }]
  for (const sample of inside) points.push({ tUs: sample.tUs, value: fn(sample.rpm) })
  points.push({ tUs: endUs, value: fn(right.rpm) })

  let integral = 0
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]
    const b = points[index]
    integral += 0.5 * (a.value + b.value) * (b.tUs - a.tUs)
  }
  return integral / (endUs - startUs)
}

function latestHeld(samples: readonly ScalarSample[], tUs: number): number {
  if (samples.length === 0 || tUs < samples[0].tUs) return 0
  let low = 0
  let high = samples.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (samples[mid].tUs <= tUs) low = mid
    else high = mid - 1
  }
  return samples[low].value
}

function boolAt(samples: readonly BoolSample[], tUs: number): boolean {
  if (samples.length === 0 || tUs < samples[0].tUs) return false
  let low = 0
  let high = samples.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (samples[mid].tUs <= tUs) low = mid
    else high = mid - 1
  }
  return samples[low].value
}

function entireIntervalTrue(samples: readonly BoolSample[], startUs: number, endUs: number): boolean {
  if (!boolAt(samples, startUs)) return false
  for (const sample of samples) if (sample.tUs > startUs && sample.tUs <= endUs && !sample.value) return false
  return true
}

function averageMeasuredPowerKw(
  rpmSamples: readonly RpmSampleUs[],
  torqueSamples: readonly ScalarSample[],
  startUs: number,
  endUs: number,
  torqueScale: number,
  torqueOffset: number,
): number | null {
  if (endUs <= startUs || torqueSamples.length === 0) return null
  const startRpm = interpolateRpm(rpmSamples, startUs)
  const endRpm = interpolateRpm(rpmSamples, endUs)
  if (!startRpm || !endRpm || startRpm.epoch !== endRpm.epoch) return null
  if (rpmSamples.some((sample) => sample.tUs > startUs && sample.tUs < endUs && sample.epoch !== startRpm.epoch)) return null

  const times = new Set<number>([startUs, endUs])
  for (const sample of rpmSamples) if (sample.tUs > startUs && sample.tUs < endUs) times.add(sample.tUs)
  for (const sample of torqueSamples) if (sample.tUs > startUs && sample.tUs < endUs) times.add(sample.tUs)
  const sorted = [...times].sort((a, b) => a - b)

  const powerAt = (tUs: number) => {
    const rpm = interpolateRpm(rpmSamples, tUs)?.rpm
    if (rpm === undefined) return null
    const rawTorque = latestHeld(torqueSamples, tUs)
    const torqueNm = (rawTorque - torqueOffset) * torqueScale
    return torqueNm * (rpm * RPM_TO_RAD_S) / 1000
  }

  let integral = 0
  let previousPower = powerAt(sorted[0])
  if (previousPower === null) return null
  for (let index = 1; index < sorted.length; index += 1) {
    const currentPower = powerAt(sorted[index])
    if (currentPower === null) return null
    integral += 0.5 * (previousPower + currentPower) * (sorted[index] - sorted[index - 1])
    previousPower = currentPower
  }
  return integral / (endUs - startUs)
}

function observationFromTooth(edge: EdgeSample, teeth: number): RpmSampleUs | null {
  if (edge.periodUs <= 0 || teeth <= 0) return null
  const rpm = US_PER_MINUTE / (edge.periodUs * teeth)
  const sigmaRpm = rpm * DELTA_TIMESTAMP_SIGMA_US / edge.periodUs
  return { tUs: edge.tUs, rpm, sigmaRpm, epoch: edge.epoch }
}

function observationFromRevolution(edges: readonly EdgeSample[], index: number, teeth: number): RpmSampleUs | null {
  if (teeth <= 0 || index < teeth) return null
  const current = edges[index]
  const previous = edges[index - teeth]
  // The physical edge counter is the source of truth. Do not bridge a missing physical edge with a
  // plausible-looking RPM estimate; leave a gap instead.
  const edgeDelta = (current.edgeCount - previous.edgeCount) >>> 0
  if (edgeDelta !== teeth || current.epoch !== previous.epoch) return null
  const dtUs = current.tUs - previous.tUs
  if (dtUs <= 0) return null
  const rpm = US_PER_MINUTE / dtUs
  const sigmaRpm = rpm * DELTA_TIMESTAMP_SIGMA_US / dtUs
  return { tUs: 0.5 * (current.tUs + previous.tUs), rpm, sigmaRpm, epoch: current.epoch }
}

function externalObservation(sample: RpmSampleUs): RpmObservation {
  return { time: sample.tUs / 1000, rpm: sample.rpm, sigmaRpm: sample.sigmaRpm }
}

export class AnalysisEngine {
  private config: AnalysisConfig
  private edges: [EdgeSample[], EdgeSample[]] = [[], []]
  private revolutionObservations: [RpmSampleUs[], RpmSampleUs[]] = [[], []]
  private toothObservations: [RpmSampleUs[], RpmSampleUs[]] = [[], []]
  private shiftSamples: ScalarSample[] = []
  private torque1Samples: ScalarSample[] = []
  private torque2Samples: ScalarSample[] = []
  private wotSamples: BoolSample[] = []
  private frames: AnalysisFrame[] = []
  private rpmEpochBreakPending: [boolean, boolean] = [false, false]
  private nextFrameEndUs: number | null = null

  constructor(config: AnalysisConfig) {
    this.config = { ...config, torqueCurve: [...config.torqueCurve] }
  }

  reset() {
    this.edges = [[], []]
    this.revolutionObservations = [[], []]
    this.toothObservations = [[], []]
    this.shiftSamples = []
    this.torque1Samples = []
    this.torque2Samples = []
    this.wotSamples = []
    this.frames = []
    this.rpmEpochBreakPending = [false, false]
    this.nextFrameEndUs = null
  }

  setConfig(config: AnalysisConfig) {
    const teethChanged = config.primaryTeeth !== this.config.primaryTeeth || config.secondaryTeeth !== this.config.secondaryTeeth
    this.config = { ...config, torqueCurve: [...config.torqueCurve] }
    if (teethChanged) this.rebuildObservations()
    this.rebuildFrames()
  }

  ingest(packet: AnalysisPacket) {
    if (!Number.isFinite(packet.tUs) || packet.tUs <= 0) return
    if (packet.channel === 0 || packet.channel === 1) this.ingestRpm(packet.channel, packet)
    else if (packet.channel === 2) this.shiftSamples.push({ tUs: packet.tUs, value: packet.value })
    else if (packet.channel === 3) this.torque1Samples.push({ tUs: packet.tUs, value: packet.value })
    else if (packet.channel === 4) this.torque2Samples.push({ tUs: packet.tUs, value: packet.value })
    else if (packet.channel === 5) this.wotSamples.push({ tUs: packet.tUs, value: packet.value !== 0 })
    this.extendFrames()
  }

  ingestMany(packets: readonly AnalysisPacket[]) {
    for (const packet of packets) this.ingest(packet)
  }

  snapshot(): AnalysisSnapshot { return this.snapshotFrom(0, 0, 0) }

  counts() {
    const observations = this.config.observationMode === 'tooth' ? this.toothObservations : this.revolutionObservations
    return { frames: this.frames.length, primaryObservations: observations[0].length, secondaryObservations: observations[1].length }
  }

  snapshotFrom(frameIndex: number, primaryObservationIndex: number, secondaryObservationIndex: number): AnalysisSnapshot {
    const observations = this.config.observationMode === 'tooth' ? this.toothObservations : this.revolutionObservations
    return {
      frames: this.frames.slice(frameIndex),
      primaryObservations: observations[0].slice(primaryObservationIndex).map(externalObservation),
      secondaryObservations: observations[1].slice(secondaryObservationIndex).map(externalObservation),
    }
  }

  private ingestRpm(channel: 0 | 1, packet: AnalysisPacket) {
    // value === 0 is the firmware's explicit stale/stopped report, not a physical edge. It should
    // not enter the edge sequence used for RPM reconstruction.
    if (packet.value <= 0) { this.rpmEpochBreakPending[channel] = true; return }
    const list = this.edges[channel]
    const previous = list[list.length - 1]
    const contiguous = previous && !this.rpmEpochBreakPending[channel] && (((packet.edgeCount >>> 0) - previous.edgeCount) >>> 0) === 1
    const epoch = previous ? (contiguous ? previous.epoch : previous.epoch + 1) : 0
    const edge: EdgeSample = { tUs: packet.tUs, edgeCount: packet.edgeCount >>> 0, periodUs: packet.value, epoch }
    this.rpmEpochBreakPending[channel] = false
    list.push(edge)
    const teeth = channel === 0 ? this.config.primaryTeeth : this.config.secondaryTeeth
    const tooth = observationFromTooth(edge, teeth)
    if (tooth) this.toothObservations[channel].push(tooth)
    const revolution = observationFromRevolution(list, list.length - 1, teeth)
    if (revolution) this.revolutionObservations[channel].push(revolution)
  }

  private rebuildObservations() {
    this.revolutionObservations = [[], []]
    this.toothObservations = [[], []]
    for (const channel of [0, 1] as const) {
      const teeth = channel === 0 ? this.config.primaryTeeth : this.config.secondaryTeeth
      const list = this.edges[channel]
      for (let index = 0; index < list.length; index += 1) {
        const tooth = observationFromTooth(list[index], teeth)
        if (tooth) this.toothObservations[channel].push(tooth)
        const revolution = observationFromRevolution(list, index, teeth)
        if (revolution) this.revolutionObservations[channel].push(revolution)
      }
    }
  }

  private rebuildFrames() {
    this.frames = []
    this.nextFrameEndUs = null
    this.extendFrames()
  }

  private extendFrames() {
    const primary = this.revolutionObservations[0]
    const secondary = this.revolutionObservations[1]
    // Each shaft is independently useful. Do not hold primary RPM hostage to a disconnected
    // secondary (or vice versa); only coupled quantities such as ratio/efficiency require both.
    const available = [primary, secondary].filter((samples) => samples.length >= 2)
    if (!available.length) return

    const windowUs = this.config.windowMs * 1000
    if (!(windowUs > 0)) return
    const firstObservationUs = Math.min(...available.map((samples) => samples[0].tUs))
    const lastUs = Math.max(...available.map((samples) => samples[samples.length - 1].tUs))
    const firstUs = firstObservationUs + windowUs
    if (this.nextFrameEndUs === null) this.nextFrameEndUs = Math.ceil(firstUs / windowUs) * windowUs

    while (this.nextFrameEndUs <= lastUs) {
      const frame = this.makeFrame(this.nextFrameEndUs)
      if (frame) this.frames.push(frame)
      this.nextFrameEndUs += windowUs
    }
  }

  private makeFrame(endUs: number): AnalysisFrame | null {
    const windowUs = this.config.windowMs * 1000
    const startUs = endUs - windowUs
    const primary = this.revolutionObservations[0]
    const secondary = this.revolutionObservations[1]
    const rpm1 = timeAverageRpm(primary, startUs, endUs)
    const rpm2 = timeAverageRpm(secondary, startUs, endUs)
    if (!rpm1 && !rpm2) return null

    const secondaryStart = rpm2 ? interpolateRpm(secondary, startUs) : null
    const secondaryEnd = rpm2 ? interpolateRpm(secondary, endUs) : null
    const fullThrottle = entireIntervalTrue(this.wotSamples, startUs, endUs)

    let power1 = Number.NaN
    let power2 = Number.NaN

    if (this.config.powerMode === 'inertia') {
      if (rpm1) power1 = timeAverageFunction(primary, startUs, endUs, (rpm) => enginePowerKwFromRpm(rpm, this.config.torqueCurve)) ?? Number.NaN
      if (secondaryStart && secondaryEnd) {
        const omegaStart = secondaryStart.rpm * RPM_TO_RAD_S
        const omegaEnd = secondaryEnd.rpm * RPM_TO_RAD_S
        power2 = this.config.secondaryInertiaKgM2 * (omegaEnd * omegaEnd - omegaStart * omegaStart) / (2 * (windowUs / 1_000_000)) / 1000
      }
    } else {
      if (rpm1) power1 = averageMeasuredPowerKw(primary, this.torque1Samples, startUs, endUs, this.config.torqueScale, this.config.torqueOffset) ?? Number.NaN
      if (rpm2) power2 = averageMeasuredPowerKw(secondary, this.torque2Samples, startUs, endUs, this.config.torqueScale, this.config.torqueOffset) ?? Number.NaN
    }

    const rpm1Value = rpm1?.rpm ?? Number.NaN
    const rpm2Value = rpm2?.rpm ?? Number.NaN
    const efficiencyValid = this.config.powerMode === 'torque' || fullThrottle
    const efficiency = efficiencyValid && Number.isFinite(power1) && Number.isFinite(power2) && power1 > 0 && power2 > 0
      ? 100 * power2 / power1
      : Number.NaN
    const shiftRatio = Number.isFinite(rpm1Value) && Number.isFinite(rpm2Value) && rpm2Value > 0
      ? rpm1Value / rpm2Value
      : Number.NaN

    return {
      time: endUs / 1000,
      rpm1: rpm1Value,
      rpm2: rpm2Value,
      rpm1Sigma: rpm1?.sigmaRpm ?? Number.NaN,
      rpm2Sigma: rpm2?.sigmaRpm ?? Number.NaN,
      shift: latestHeld(this.shiftSamples, endUs),
      torq1: latestHeld(this.torque1Samples, endUs),
      torq2: latestHeld(this.torque2Samples, endUs),
      power1,
      power2,
      efficiency,
      shiftRatio,
      fullThrottle,
    }
  }
}
