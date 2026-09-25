import { describe, expect, it } from 'vitest'
import { RawReplayController } from './rawReplay'
import type { AnalysisPacket } from '../analysis/types'

class FakeClock {
  nowMs = 0
  nextId = 1
  timers = new Map<number, { at: number; callback: () => void }>()
  now = () => this.nowMs
  setTimer = (callback: () => void, delayMs: number) => { const id = this.nextId++; this.timers.set(id, { at: this.nowMs + delayMs, callback }); return id }
  clearTimer = (id: number) => { this.timers.delete(id) }
  advance(ms: number) {
    const target = this.nowMs + ms
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.nowMs = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
    }
    this.nowMs = target
  }
}

// Arrival/file order is intentionally NOT globally sorted by firmware capture time.
// This mirrors the real dual-channel raw logs: a packet drained later can carry an older
// capture timestamp than the packet immediately before it.
const packets: AnalysisPacket[] = [
  { channel: 0, value: 1000, tUs: 1_000_000, seq: 1, edgeCount: 1 },
  { channel: 1, value: 1000, tUs: 1_020_000, seq: 1, edgeCount: 1 },
  { channel: 0, value: 1000, tUs: 1_010_000, seq: 2, edgeCount: 2 },
]

describe('RawReplayController', () => {
  it('preserves recorded arrival order when cross-channel capture timestamps go backward', () => {
    const clock = new FakeClock()
    const delivered: AnalysisPacket[] = []
    const controller = new RawReplayController({ onBatch: (batch) => delivered.push(...batch), onReset: () => undefined, onState: () => undefined }, clock)
    controller.setLoop(false)
    controller.load(packets)
    controller.play()
    clock.advance(25)
    expect(delivered).toEqual(packets)
  })

  it('changes wall-clock replay speed without changing packet timestamps or row order', () => {
    const clock = new FakeClock()
    const delivered: AnalysisPacket[] = []
    const controller = new RawReplayController({ onBatch: (batch) => delivered.push(...batch), onReset: () => undefined, onState: () => undefined }, clock)
    controller.setLoop(false)
    controller.setSpeed(2)
    controller.load(packets)
    controller.play()
    // Stream-time offsets are 0 ms, 20 ms, 20 ms (running-max capture clock).
    // At 2x they are nominally due by 10 ms; the replay controller deliberately batches on an 8 ms timer tick, so the batch is observed by 16 ms.
    clock.advance(17)
    expect(delivered).toEqual(packets)
    expect(delivered.map((packet) => packet.tUs)).toEqual([1_000_000, 1_020_000, 1_010_000])
  })
})
