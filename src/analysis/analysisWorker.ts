/// <reference lib="webworker" />
import { AnalysisEngine } from './engine'
import type { AnalysisConfig, AnalysisCounts, AnalysisPacket, AnalysisUpdate, RpmObservationMode, RpmObservationView } from './types'

export type AnalysisWorkerInbound =
  | { type: 'configure'; config: AnalysisConfig }
  | { type: 'reset' }
  | { type: 'packets'; packets: AnalysisPacket[] }
  | { type: 'snapshot'; requestId: number }
  | { type: 'observation-view'; mode: RpmObservationMode; startMs: number; endMs: number; maxPoints: number; requestId: number }

export type AnalysisWorkerOutbound =
  | { type: 'update'; update: AnalysisUpdate; requestId?: number }
  | { type: 'observation-view'; view: RpmObservationView; requestId: number }

let engine: AnalysisEngine | null = null
let publishTimer: number | null = null
let published: AnalysisCounts = zeroCounts()

function zeroCounts(): AnalysisCounts {
  return { primaryRpm: 0, secondaryRpm: 0, primaryPower: 0, secondaryPower: 0, ratio: 0, efficiency: 0, shift: 0 }
}

function markPublished() { if (engine) published = engine.counts() }

function publishReplace(requestId?: number) {
  if (!engine) return
  postMessage({ type: 'update', update: { type: 'replace', snapshot: engine.snapshot() }, requestId } satisfies AnalysisWorkerOutbound)
  markPublished()
}

function publishAppend() {
  if (!engine) return
  const snapshot = engine.snapshotFrom(published)
  if (!Object.values(snapshot).some((series) => series.length)) return
  postMessage({ type: 'update', update: { type: 'append', snapshot } } satisfies AnalysisWorkerOutbound)
  markPublished()
}

function schedulePublish() {
  if (publishTimer !== null) return
  publishTimer = self.setTimeout(() => { publishTimer = null; publishAppend() }, 33)
}

self.onmessage = (event: MessageEvent<AnalysisWorkerInbound>) => {
  const message = event.data
  if (message.type === 'configure') {
    if (engine) engine.setConfig(message.config)
    else engine = new AnalysisEngine(message.config)
    publishReplace()
  } else if (message.type === 'reset') {
    engine?.reset()
    published = zeroCounts()
    publishReplace()
  } else if (message.type === 'packets') {
    if (!engine) return
    engine.ingestMany(message.packets)
    schedulePublish()
  } else if (message.type === 'snapshot') {
    publishReplace(message.requestId)
  } else if (message.type === 'observation-view') {
    const view = engine?.observationView(message.mode, message.startMs, message.endMs, message.maxPoints) ?? { primary: [], secondary: [] }
    postMessage({ type: 'observation-view', view, requestId: message.requestId } satisfies AnalysisWorkerOutbound)
  }
}
