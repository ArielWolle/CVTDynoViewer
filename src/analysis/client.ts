import type { AnalysisConfig, AnalysisPacket, AnalysisUpdate } from './types'
import type { AnalysisWorkerInbound, AnalysisWorkerOutbound } from './analysisWorker'

export class AnalysisClient {
  private worker: Worker
  private packetQueue: AnalysisPacket[] = []
  private queueScheduled = false

  constructor(config: AnalysisConfig, onUpdate: (update: AnalysisUpdate) => void) {
    this.worker = new Worker(new URL('./analysisWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<AnalysisWorkerOutbound>) => {
      if (event.data.type === 'update') onUpdate(event.data.update)
    }
    this.post({ type: 'configure', config })
  }

  configure(config: AnalysisConfig) { this.post({ type: 'configure', config }) }
  reset() { this.packetQueue = []; this.post({ type: 'reset' }) }

  push(packet: AnalysisPacket) {
    this.packetQueue.push(packet)
    if (this.queueScheduled) return
    this.queueScheduled = true
    queueMicrotask(() => {
      this.queueScheduled = false
      if (!this.packetQueue.length) return
      const packets = this.packetQueue.sort((left, right) => left.tUs - right.tUs)
      this.packetQueue = []
      this.post({ type: 'packets', packets: [...packets].sort((left, right) => left.tUs - right.tUs) })
    })
  }

  pushMany(packets: AnalysisPacket[]) {
    if (!packets.length) return
    this.post({ type: 'packets', packets })
  }

  terminate() { this.worker.terminate() }
  private post(message: AnalysisWorkerInbound) { this.worker.postMessage(message) }
}
