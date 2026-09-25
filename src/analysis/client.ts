import type { AnalysisConfig, AnalysisPacket, AnalysisUpdate, RpmObservationMode } from './types'
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

  configure(config: AnalysisConfig) { this.flushQueue(); this.post({ type: 'configure', config }) }
  setObservationMode(mode: RpmObservationMode) { this.post({ type: 'observation-mode', mode }) }
  reset() { this.packetQueue = []; this.queueScheduled = false; this.post({ type: 'reset' }) }

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

  terminate() { this.worker.terminate() }

  private flushQueue() {
    if (!this.packetQueue.length) return
    const packets = this.packetQueue
    this.packetQueue = []
    this.post({ type: 'packets', packets })
  }

  private post(message: AnalysisWorkerInbound) { this.worker.postMessage(message) }
}
