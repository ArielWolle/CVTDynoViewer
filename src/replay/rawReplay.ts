import type { AnalysisPacket } from '../analysis/types'

export const RAW_REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 10] as const
export type RawReplaySpeed = typeof RAW_REPLAY_SPEEDS[number]

export type RawReplayState = {
  loaded: boolean
  playing: boolean
  analyzing: boolean
  analysisProgress: number
  speed: RawReplaySpeed
  loop: boolean
  progress: number
  elapsedMs: number
  durationMs: number
  loopCount: number
}

type ReplayClock = {
  now: () => number
  setTimer: (callback: () => void, delayMs: number) => number
  clearTimer: (timerId: number) => void
}

type RawReplayCallbacks = {
  onBatch: (packets: AnalysisPacket[]) => void
  onBulkBatch?: (packets: AnalysisPacket[]) => Promise<void>
  onDrain?: () => Promise<void>
  onReset: (firstPacketUs: number, loopCount: number) => void
  onState: (state: RawReplayState) => void
}

const TICK_MS = 8
const STATE_UPDATE_MS = 50
const BULK_BATCH_SIZE = 10_000
const browserClock: ReplayClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timerId) => window.clearTimeout(timerId),
}

export class RawReplayController {
  private packets: AnalysisPacket[] = []
  private replayOffsetsMs: number[] = []
  private firstUs = 0
  private durationMs = 0
  private cursor = 0
  private basePositionMs = 0
  private playStartedMs = 0
  private timer: number | null = null
  private playing = false
  private analyzing = false
  private analysisProgress = 0
  private speed: RawReplaySpeed = 1
  private loop = true
  private loopCount = 0
  private lastStateEmitMs = -Infinity
  private operationId = 0

  constructor(private callbacks: RawReplayCallbacks, private clock: ReplayClock = browserClock) {}

  load(packets: readonly AnalysisPacket[]) {
    this.operationId += 1
    this.stopTimer()
    this.packets = [...packets]
    this.firstUs = this.packets[0]?.tUs ?? 0
    this.replayOffsetsMs = []
    let runningMaxUs = this.firstUs
    for (const packet of this.packets) {
      runningMaxUs = Math.max(runningMaxUs, packet.tUs)
      this.replayOffsetsMs.push(Math.max(0, (runningMaxUs - this.firstUs) / 1000))
    }
    this.durationMs = this.replayOffsetsMs.at(-1) ?? 0
    this.cursor = 0
    this.basePositionMs = 0
    this.playStartedMs = this.clock.now()
    this.playing = false
    this.analyzing = false
    this.analysisProgress = 0
    this.loopCount = 0
    if (this.packets.length) this.callbacks.onReset(this.firstUs, this.loopCount)
    this.emitState(undefined, true)
  }

  async showAll(): Promise<boolean> {
    if (!this.packets.length || this.analyzing) return false
    const operation = ++this.operationId
    this.stopTimer()
    this.cursor = 0
    this.basePositionMs = 0
    this.playing = false
    this.analyzing = true
    this.analysisProgress = 0
    this.loopCount = 0
    this.callbacks.onReset(this.firstUs, this.loopCount)
    this.emitState(0, true)

    try {
      for (let start = 0; start < this.packets.length; start += BULK_BATCH_SIZE) {
        if (operation !== this.operationId) return false
        const end = Math.min(this.packets.length, start + BULK_BATCH_SIZE)
        const batch = this.packets.slice(start, end)
        if (this.callbacks.onBulkBatch) await this.callbacks.onBulkBatch(batch)
        else this.callbacks.onBatch(batch)
        if (operation !== this.operationId) return false
        this.cursor = end
        this.analysisProgress = end / this.packets.length
        this.basePositionMs = this.replayOffsetsMs[Math.max(0, end - 1)] ?? 0
        this.emitState(this.basePositionMs, true)
      }

      if (operation !== this.operationId) return false
      this.cursor = this.packets.length
      this.basePositionMs = this.durationMs
      this.playStartedMs = this.clock.now()
      this.analysisProgress = 1
      this.analyzing = false
      this.emitState(this.durationMs, true)
      return true
    } catch (error) {
      if (operation === this.operationId) {
        this.analyzing = false
        this.emitState(this.basePositionMs, true)
      }
      throw error
    }
  }

  clear() {
    this.operationId += 1
    this.stopTimer()
    this.packets = []
    this.replayOffsetsMs = []
    this.firstUs = 0
    this.durationMs = 0
    this.cursor = 0
    this.basePositionMs = 0
    this.playing = false
    this.analyzing = false
    this.analysisProgress = 0
    this.loopCount = 0
    this.emitState(undefined, true)
  }

  play() {
    if (!this.packets.length || this.playing || this.analyzing) return
    this.operationId += 1
    if (this.basePositionMs >= this.durationMs && this.cursor >= this.packets.length) this.restart(false)
    this.playStartedMs = this.clock.now()
    this.playing = true
    this.emitState(undefined, true)
    this.schedule(0)
  }

  pause() {
    if (!this.playing) return
    this.basePositionMs = this.currentPositionMs()
    this.playing = false
    this.stopTimer()
    this.emitState(undefined, true)
  }

  restart(keepPlaying = this.playing) {
    this.operationId += 1
    this.stopTimer()
    this.cursor = 0
    this.basePositionMs = 0
    this.playing = false
    this.analyzing = false
    this.analysisProgress = 0
    this.loopCount = 0
    if (this.packets.length) this.callbacks.onReset(this.firstUs, this.loopCount)
    this.emitState(undefined, true)
    if (keepPlaying) this.play()
  }

  setSpeed(speed: RawReplaySpeed) {
    if (this.speed === speed) return
    if (this.playing) {
      this.basePositionMs = this.currentPositionMs()
      this.playStartedMs = this.clock.now()
    }
    this.speed = speed
    this.emitState(undefined, true)
  }

  setLoop(loop: boolean) { this.loop = loop; this.emitState(undefined, true) }

  private currentPositionMs() {
    if (!this.playing) return this.basePositionMs
    return Math.min(this.durationMs, this.basePositionMs + Math.max(0, (this.clock.now() - this.playStartedMs) * this.speed))
  }

  private schedule(delayMs = TICK_MS) {
    this.stopTimer()
    const operation = this.operationId
    this.timer = this.clock.setTimer(() => { void this.pump(operation) }, delayMs)
  }

  private async pump(operation: number) {
    this.timer = null
    if (!this.playing || !this.packets.length || operation !== this.operationId) return
    const positionMs = this.currentPositionMs()
    const due: AnalysisPacket[] = []
    while (this.cursor < this.packets.length && this.replayOffsetsMs[this.cursor] <= positionMs) {
      due.push(this.packets[this.cursor++])
    }
    if (due.length) this.callbacks.onBatch(due)

    if (this.cursor >= this.packets.length) {
      try {
        await this.callbacks.onDrain?.()
      } catch {
        if (operation === this.operationId) {
          this.playing = false
          this.emitState(this.currentPositionMs(), true)
        }
        return
      }
      if (operation !== this.operationId) return
      this.basePositionMs = this.durationMs
      this.playing = false
      this.analysisProgress = 1
      this.emitState(undefined, true)
      if (this.loop) {
        this.loopCount += 1
        this.cursor = 0
        this.basePositionMs = 0
        this.analysisProgress = 0
        this.callbacks.onReset(this.firstUs, this.loopCount)
        this.playStartedMs = this.clock.now()
        this.playing = true
        this.emitState(undefined, true)
        this.schedule(TICK_MS)
      }
      return
    }
    this.emitState(positionMs)
    this.schedule(TICK_MS)
  }

  private stopTimer() { if (this.timer !== null) this.clock.clearTimer(this.timer); this.timer = null }

  private emitState(positionMs = this.currentPositionMs(), force = false) {
    const now = this.clock.now()
    if (!force && now - this.lastStateEmitMs < STATE_UPDATE_MS) return
    this.lastStateEmitMs = now
    const loaded = this.packets.length > 0
    const progress = !loaded ? 0 : this.durationMs > 0 ? Math.min(1, Math.max(0, positionMs / this.durationMs)) : 1
    this.callbacks.onState({
      loaded,
      playing: this.playing,
      analyzing: this.analyzing,
      analysisProgress: this.analysisProgress,
      speed: this.speed,
      loop: this.loop,
      progress,
      elapsedMs: positionMs,
      durationMs: this.durationMs,
      loopCount: this.loopCount,
    })
  }
}
