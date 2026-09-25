import type { AnalysisPacket } from '../analysis/types'

export const RAW_REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 10] as const
export type RawReplaySpeed = typeof RAW_REPLAY_SPEEDS[number]

export type RawReplayState = {
  loaded: boolean
  playing: boolean
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
  onReset: (firstPacketUs: number, loopCount: number) => void
  onState: (state: RawReplayState) => void
}

const TICK_MS = 8
const STATE_UPDATE_MS = 50
const browserClock: ReplayClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timerId) => window.clearTimeout(timerId),
}

/**
 * Replays raw rows in their recorded FILE/ARRIVAL ORDER. Firmware capture timestamps are
 * channel-local measurements and are deliberately not globally monotonic: a secondary packet
 * drained after a primary packet may have been captured slightly earlier. Therefore tUs cannot
 * itself be used as a globally sortable replay clock.
 *
 * For old/current raw logs there is no independent host-arrival timestamp. We construct a
 * monotonic stream clock from the running maximum capture timestamp encountered in file order.
 * A late packet whose tUs is behind that maximum is delivered immediately at the current stream
 * time, while its original tUs is passed through unchanged to the analysis engine. This preserves
 * both pieces of truth we actually have: row arrival order and physical capture timestamps.
 */
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
  private speed: RawReplaySpeed = 1
  private loop = true
  private loopCount = 0
  private lastStateEmitMs = -Infinity

  constructor(private callbacks: RawReplayCallbacks, private clock: ReplayClock = browserClock) {}

  load(packets: readonly AnalysisPacket[]) {
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
    this.loopCount = 0
    if (this.packets.length) this.callbacks.onReset(this.firstUs, this.loopCount)
    this.emitState(undefined, true)
  }

  clear() {
    this.stopTimer()
    this.packets = []
    this.replayOffsetsMs = []
    this.firstUs = 0
    this.durationMs = 0
    this.cursor = 0
    this.basePositionMs = 0
    this.playing = false
    this.loopCount = 0
    this.emitState(undefined, true)
  }

  play() {
    if (!this.packets.length || this.playing) return
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
    this.stopTimer()
    this.cursor = 0
    this.basePositionMs = 0
    this.playing = false
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

  private schedule(delayMs = TICK_MS) { this.stopTimer(); this.timer = this.clock.setTimer(() => this.pump(), delayMs) }

  private pump() {
    this.timer = null
    if (!this.playing || !this.packets.length) return
    const positionMs = this.currentPositionMs()
    const due: AnalysisPacket[] = []
    while (this.cursor < this.packets.length && this.replayOffsetsMs[this.cursor] <= positionMs) {
      due.push(this.packets[this.cursor++])
    }
    if (due.length) this.callbacks.onBatch(due)

    if (this.cursor >= this.packets.length) {
      this.basePositionMs = this.durationMs
      this.playing = false
      this.emitState(undefined, true)
      if (this.loop) {
        this.loopCount += 1
        this.cursor = 0
        this.basePositionMs = 0
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
    this.callbacks.onState({ loaded, playing: this.playing, speed: this.speed, loop: this.loop, progress, elapsedMs: positionMs, durationMs: this.durationMs, loopCount: this.loopCount })
  }
}
