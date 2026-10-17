import type { AnalysisPacket, AnalysisChannelId } from '../analysis/types'

export type QualityEventKind = 'transmission-loss' | 'device-edge-loss' | 'suspected-missed-pulse'
export type QualityEvent = {
  id: number
  kind: QualityEventKind
  channel: AnalysisChannelId
  startMs: number
  endMs: number
  count: number
}

export type QualitySnapshot = {
  revision: number
  events: readonly QualityEvent[]
  transmissionPacketsLost: number
  deviceEdgesLost: readonly [number, number]
  suspectedSensorPulses: readonly [number, number]
}

const BASELINE_SIZE = 7
const MIN_BASELINE_SAMPLES = 5
const NEAR_DOUBLE_MIN = 1.7
const NEAR_DOUBLE_MAX = 2.3
const RETURN_TO_BASELINE_MIN = 0.75
const RETURN_TO_BASELINE_MAX = 1.25

type PendingLongPeriod = {
  startMs: number
  endMs: number
  baselineUs: number
  periodUs: number
}

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2
}

// Tracks what is OBSERVABLE at the receiver, preserving distinctions between:
// - missing transmitted packets (per-channel sequence jump)
// - accepted RP2040 edges lost before USB (physical edge-count jump beyond sequence loss)
// - a plausible *unobserved* sensor pulse (isolated ~2x inter-edge period and recovery)
//
// The final category is deliberately 'suspected'. It is NOT proof that a physical tooth is
// missing, and neither firmware nor viewer silently inserts synthetic pulses or changes RPM.
export class DataQualityMonitor {
  private lastSeq: (number | null)[] = Array(6).fill(null)
  private lastTimeMs: (number | null)[] = Array(6).fill(null)
  private lastEdgeCount: [number | null, number | null] = [null, null]
  private periodHistory: [number[], number[]] = [[], []]
  private pendingLongPeriod: [PendingLongPeriod | null, PendingLongPeriod | null] = [null, null]
  private qualityEvents: QualityEvent[] = []
  private revision = 0
  private nextEventId = 1
  private packetLoss = 0
  private edgeLoss: [number, number] = [0, 0]
  private suspectPulses: [number, number] = [0, 0]
  private cached: QualitySnapshot | null = null

  reset(): void {
    this.lastSeq.fill(null)
    this.lastTimeMs.fill(null)
    this.lastEdgeCount = [null, null]
    this.periodHistory = [[], []]
    this.pendingLongPeriod = [null, null]
    this.qualityEvents = []
    this.packetLoss = 0
    this.edgeLoss = [0, 0]
    this.suspectPulses = [0, 0]
    this.revision++
    this.cached = null
    this.nextEventId = 1
  }

  // Called when a channel is intentionally switched off/on, so withheld telemetry is
  // not misclassified as transmission loss or a missing sensor edge when it resumes.
  resetChannel(channel: AnalysisChannelId): void {
    this.lastSeq[channel] = null
    this.lastTimeMs[channel] = null
    if (channel === 0 || channel === 1) this.clearRpmBaseline(channel)
  }

  // True only when this packet confirms that the preceding RPM packet was
  // an isolated near-double tooth period (one-edge lookahead for safe analysis).
  ingest(packet: AnalysisPacket): boolean {
    if (!(packet.tUs > 0) || !Number.isFinite(packet.tUs)) return false
    const ch = packet.channel
    const nowMs = packet.tUs / 1000
    const previousSeq = this.lastSeq[ch]
    const previousTime = this.lastTimeMs[ch]
    let seqGap = 0
    if (previousSeq !== null) seqGap = (packet.seq - previousSeq - 1) & 0xff
    this.lastSeq[ch] = packet.seq
    this.lastTimeMs[ch] = nowMs
    if (seqGap > 0) {
      this.packetLoss += seqGap
      this.addEvent('transmission-loss', ch, previousTime ?? nowMs, nowMs, seqGap)
    }

    if (ch !== 0 && ch !== 1) return false

    if (packet.value === 0) {
      // A firmware 'stopped' frame is not a tooth and does not advance edgeCount.
      // Fresh RPM after the stop has a new measurement epoch.
      this.clearRpmBaseline(ch)
      return false
    }
    if (!(packet.value > 0)) {
      this.clearRpmBaseline(ch)
      return false
    }

    const previousEdge = this.lastEdgeCount[ch]
    const edgeCount = packet.edgeCount >>> 0
    let edgeGap = 0
    if (previousEdge !== null) edgeGap = ((edgeCount - previousEdge - 1) >>> 0)
    this.lastEdgeCount[ch] = edgeCount
    const deviceOnlyLoss = Math.max(0, edgeGap - seqGap)
    if (deviceOnlyLoss > 0) {
      this.edgeLoss[ch] += deviceOnlyLoss
      this.addEvent('device-edge-loss', ch, previousTime ?? nowMs, nowMs, deviceOnlyLoss)
    }

    // Packet/edge loss makes an apparent period ratio ambiguous. Likewise, after a
    // stop, channel re-enable, timestamp regression or non-contiguous edge, don't
    // infer a missed physical pulse from an interval that has known collection issues.
    if (seqGap > 0 || edgeGap > 0 || (previousTime !== null && nowMs <= previousTime)) {
      this.periodHistory[ch] = []
      this.pendingLongPeriod[ch] = null
      return false
    }

    const candidate = this.pendingLongPeriod[ch]
    if (candidate) {
      this.pendingLongPeriod[ch] = null
      const ratio = packet.value / candidate.baselineUs
      if (ratio >= RETURN_TO_BASELINE_MIN && ratio <= RETURN_TO_BASELINE_MAX) {
        this.suspectPulses[ch]++
        this.addEvent('suspected-missed-pulse', ch, candidate.startMs, candidate.endMs, 1)
        this.rememberPeriod(ch, packet.value)
        return true
      }
      // A sustained RPM transition is NOT an isolated missing tooth. Relearn the
      // baseline instead of repeatedly comparing against the old speed.
      this.periodHistory[ch] = [candidate.periodUs]
      this.rememberPeriod(ch, packet.value)
      return false
    }

    const history = this.periodHistory[ch]
    if (history.length >= MIN_BASELINE_SAMPLES && previousTime !== null) {
      const typicalUs = median(history)
      const ratio = packet.value / typicalUs
      if (ratio >= NEAR_DOUBLE_MIN && ratio <= NEAR_DOUBLE_MAX) {
        // One further pulse must recover toward the preceding local cadence. This
        // avoids falsely identifying ordinary step-like deceleration as a missing tooth.
        this.pendingLongPeriod[ch] = {
          startMs: previousTime,
          endMs: nowMs,
          baselineUs: typicalUs,
          periodUs: packet.value,
        }
        return false
      }
    }
    this.rememberPeriod(ch, packet.value)
    return false
  }

  snapshot(): QualitySnapshot {
    if (this.cached) return this.cached
    // A source may interleave channels with slightly different capture timestamps.
    // Sorting only when issues change keeps viewport queries deterministic.
    const events = [...this.qualityEvents].sort((a, b) => a.startMs - b.startMs || a.id - b.id)
    this.cached = {
      revision: this.revision,
      events,
      transmissionPacketsLost: this.packetLoss,
      deviceEdgesLost: [...this.edgeLoss] as [number, number],
      suspectedSensorPulses: [...this.suspectPulses] as [number, number],
    }
    return this.cached
  }

  private clearRpmBaseline(channel: 0 | 1): void {
    this.lastEdgeCount[channel] = null
    this.periodHistory[channel] = []
    this.pendingLongPeriod[channel] = null
  }

  private rememberPeriod(channel: 0 | 1, periodUs: number): void {
    const history = this.periodHistory[channel]
    history.push(periodUs)
    if (history.length > BASELINE_SIZE) history.shift()
  }

  private addEvent(kind: QualityEventKind, channel: AnalysisChannelId, firstMs: number, lastMs: number, count: number): void {
    this.qualityEvents.push({
      id: this.nextEventId++, kind, channel, startMs: Math.min(firstMs, lastMs),
      endMs: Math.max(firstMs, lastMs), count,
    })
    this.revision++
    this.cached = null
  }
}

export const EMPTY_QUALITY_SNAPSHOT: QualitySnapshot = {
  revision: 0,
  events: [],
  transmissionPacketsLost: 0,
  deviceEdgesLost: [0, 0],
  suspectedSensorPulses: [0, 0],
}

export function qualityEventLabel(event: QualityEvent): string {
  const name = ['Primary RPM', 'Secondary RPM', 'Shift position', 'Primary torque', 'Secondary torque', 'Full throttle'][event.channel]
  if (event.kind === 'transmission-loss') return name + ': ' + event.count + ' missing transmitted packet(s)'
  if (event.kind === 'device-edge-loss') return name + ': ' + event.count + ' edge(s) lost in device buffering'
  return name + ': suspected missed sensor pulse (isolated ~2× tooth period)'
}

// Only annotate charts that actually depend on the affected channel. No x-axis on the
// relationship plots, so events are mapped onto the time-series charts and timeline strip.
export function affectsChart(event: QualityEvent, chart: string, powerMode: 'inertia' | 'torque'): boolean {
  if (chart === 'rpm1') return event.channel === 0
  if (chart === 'rpm2') return event.channel === 1
  if (chart === 'shift') return event.channel === 2
  if (chart === 'power' || chart === 'efficiency') {
    return event.channel === 0 || event.channel === 1 ||
      (powerMode === 'torque' && (event.channel === 3 || event.channel === 4))
  }
  if (chart === 'shiftRatio') return event.channel === 0 || event.channel === 1
  return false
}
