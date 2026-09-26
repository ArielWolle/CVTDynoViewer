import type { AnalysisConfig, AnalysisPacket, AnalysisUpdate, RpmObservationMode, RpmObservationView } from './types'
import type { AnalysisWorkerInbound, AnalysisWorkerOutbound } from './analysisWorker'

type RequestWaiter = { resolve: () => void; reject: (error: Error) => void }

function configKey(config: AnalysisConfig): string {
  return JSON.stringify(config)
}

export class AnalysisClient {
  private worker: Worker
  private packetQueue: AnalysisPacket[] = []
  private queueScheduled = false
  private nextRequestId = 1
  private observationResolvers = new Map<number, (view: RpmObservationView) => void>()
  private requestWaiters = new Map<number, RequestWaiter>()
  private lastConfigKey: string
  private failed: Error | null = null

  constructor(config: AnalysisConfig, onUpdate: (update: AnalysisUpdate) => void, onError?: (message: string) => void) {
    this.worker = new Worker(new URL('./analysisWorker.ts', import.meta.url), { type: 'module' })
    this.lastConfigKey = configKey(config)
    this.worker.onmessage = (event: MessageEvent<AnalysisWorkerOutbound>) => {
      if (event.data.type === 'update') {
        onUpdate(event.data.update)
        return
      }
      if (event.data.type === 'observation-view') {
        const resolve = this.observationResolvers.get(event.data.requestId)
        if (!resolve) return
        this.observationResolvers.delete(event.data.requestId)
        resolve(event.data.view)
        return
      }
      const waiter = this.requestWaiters.get(event.data.requestId)
      if (!waiter) return
      this.requestWaiters.delete(event.data.requestId)
      waiter.resolve()
    }
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Analysis worker failed')
      this.failed = error
      onError?.(error.message)
      for (const resolve of this.observationResolvers.values()) resolve({ primary: [], secondary: [] })
      this.observationResolvers.clear()
      this.failPending(error)
    }
    this.post({ type: 'configure', config })
  }

  configure(config: AnalysisConfig) {
    this.flushQueue()
    const key = configKey(config)
    if (key === this.lastConfigKey) return
    this.lastConfigKey = key
    this.post({ type: 'configure', config })
  }

  configureAndWait(config: AnalysisConfig): Promise<void> {
    this.flushQueue()
    const key = configKey(config)
    if (key === this.lastConfigKey) return this.failed ? Promise.reject(this.failed) : Promise.resolve()
    this.lastConfigKey = key
    return this.request((requestId) => ({ type: 'configure', config, requestId }))
  }

  reset() {
    this.packetQueue = []
    this.queueScheduled = false
    this.post({ type: 'reset' })
  }

  requestObservations(mode: RpmObservationMode, startMs: number, endMs: number, maxPoints: number): Promise<RpmObservationView> {
    if (mode === 'none' || !(endMs >= startMs) || maxPoints <= 0 || this.failed) return Promise.resolve({ primary: [], secondary: [] })
    this.flushQueue()
    const requestId = this.nextRequestId++
    return new Promise((resolve) => {
      this.observationResolvers.set(requestId, resolve)
      this.post({ type: 'observation-view', mode, startMs, endMs, maxPoints, requestId })
    })
  }

  push(packet: AnalysisPacket) {
    if (this.failed) return
    this.packetQueue.push(packet)
    if (this.queueScheduled) return
    this.queueScheduled = true
    queueMicrotask(() => { this.queueScheduled = false; this.flushQueue() })
  }

  pushMany(packets: AnalysisPacket[]) {
    if (!packets.length || this.failed) return
    this.flushQueue()
    this.post({ type: 'packets', packets })
  }

  pushManyAndWait(packets: AnalysisPacket[]): Promise<void> {
    if (!packets.length) return Promise.resolve()
    this.flushQueue()
    return this.request((requestId) => ({ type: 'process-batch', packets, requestId }))
  }

  barrier(): Promise<void> {
    this.flushQueue()
    return this.request((requestId) => ({ type: 'barrier', requestId }))
  }

  terminate() {
    const error = new Error('Analysis worker terminated')
    this.worker.terminate()
    for (const resolve of this.observationResolvers.values()) resolve({ primary: [], secondary: [] })
    this.observationResolvers.clear()
    this.failPending(error)
  }

  private request(build: (requestId: number) => AnalysisWorkerInbound): Promise<void> {
    if (this.failed) return Promise.reject(this.failed)
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      this.requestWaiters.set(requestId, { resolve, reject })
      this.post(build(requestId))
    })
  }

  private failPending(error: Error) {
    for (const waiter of this.requestWaiters.values()) waiter.reject(error)
    this.requestWaiters.clear()
  }

  private flushQueue() {
    if (!this.packetQueue.length || this.failed) return
    const packets = this.packetQueue
    this.packetQueue = []
    this.post({ type: 'packets', packets })
  }

  private post(message: AnalysisWorkerInbound) {
    if (!this.failed) this.worker.postMessage(message)
  }
}
