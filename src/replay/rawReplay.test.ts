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

  it('does not call a full-run load ready until the analysis acknowledgement resolves', async () => {
    const clock = new FakeClock()
    const delivered: AnalysisPacket[] = []
    const states: Array<{ analyzing: boolean; analysisProgress: number; progress: number }> = []
    let release: () => void = () => { throw new Error('bulk analysis acknowledgement was never registered') }

    const controller = new RawReplayController({
      onBatch: (batch) => delivered.push(...batch),
      onBulkBatch: (batch) => {
        delivered.push(...batch)
        return new Promise<void>((resolve) => { release = resolve })
      },
      onReset: () => undefined,
      onState: (state) => states.push({ analyzing: state.analyzing, analysisProgress: state.analysisProgress, progress: state.progress }),
    }, clock)

    controller.setLoop(false)
    controller.load(packets)
    const loading = controller.showAll()

    expect(states.at(-1)?.analyzing).toBe(true)
    expect(states.at(-1)?.analysisProgress).toBe(0)
    release()
    expect(await loading).toBe(true)
    expect(delivered).toEqual(packets)
    expect(states.at(-1)).toEqual({ analyzing: false, analysisProgress: 1, progress: 1 })
  })

  it('replays from the beginning after a completed full-run preview', async () => {
    const clock = new FakeClock()
    const delivered: AnalysisPacket[] = []
    let resets = 0
    const controller = new RawReplayController({
      onBatch: (batch) => delivered.push(...batch),
      onBulkBatch: async (batch) => { delivered.push(...batch) },
      onDrain: async () => undefined,
      onReset: () => { resets += 1 },
      onState: () => undefined,
    }, clock)

    controller.setLoop(false)
    controller.load(packets)
    await controller.showAll()

    delivered.length = 0
    const resetsBeforePlay = resets
    controller.play()
    clock.advance(0)

    expect(resets).toBe(resetsBeforePlay + 1)
    expect(delivered[0]).toEqual(packets[0])
  })
})
