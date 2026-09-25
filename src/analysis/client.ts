import type { AnalysisConfig, AnalysisPacket, AnalysisUpdate, RpmObservationMode, RpmObservationView } from './types'
import type { AnalysisWorkerInbound, AnalysisWorkerOutbound } from './analysisWorker'

export class AnalysisClient {
  private worker: Worker
  private packetQueue: AnalysisPacket[] = []
  private queueScheduled = false
  private nextRequestId = 1
  private observationResolvers = new Map<number, (view: RpmObservationView) => void>()

  constructor(config: AnalysisConfig, onUpdate: (update: AnalysisUpdate) => void) {
    this.worker = new Worker(new URL('./analysisWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<AnalysisWorkerOutbound>) => {
      if (event.data.type === 'update') {
        onUpdate(event.data.update)
        return
      }
      const resolve = this.observationResolvers.get(event.data.requestId)
      if (!resolve) return
      this.observationResolvers.delete(event.data.requestId)
      resolve(event.data.view)
    }
    this.post({ type: 'configure', config })
  }

  configure(config: AnalysisConfig) { this.flushQueue(); this.post({ type: 'configure', config }) }
  reset() { this.packetQueue = []; this.queueScheduled = false; this.post({ type: 'reset' }) }

  requestObservations(mode: RpmObservationMode, startMs: number, endMs: number, maxPoints: number): Promise<RpmObservationView> {
    if (mode === 'none' || !(endMs >= startMs) || maxPoints <= 0) return Promise.resolve({ primary: [], secondary: [] })
    this.flushQueue()
    const requestId = this.nextRequestId++
    return new Promise((resolve) => {
      this.observationResolvers.set(requestId, resolve)
      this.post({ type: 'observation-view', mode, startMs, endMs, maxPoints, requestId })
    })
  }

  push(packet: AnalysisPacket) {
    this.packetQueue.push(packet)
    if (this.queueScheduled) return
    this.queueScheduled = true
    queueMicrotask(() => { this.queueScheduled = false; this.flushQueue() })
  }

  pushMany(packets: AnalysisPacket[]) {
    if (!packets.length) return
    this.flushQueue()
    this.post({ type: 'packets', packets })
  }

  terminate() {
    this.worker.terminate()
    for (const resolve of this.observationResolvers.values()) resolve({ primary: [], secondary: [] })
    this.observationResolvers.clear()
  }

  private flushQueue() {
    if (!this.packetQueue.length) return
    const packets = this.packetQueue
    this.packetQueue = []
    this.post({ type: 'packets', packets })
  }

  private post(message: AnalysisWorkerInbound) { this.worker.postMessage(message) }
}
