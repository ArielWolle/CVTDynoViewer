/// <reference lib="webworker" />
import { AnalysisEngine } from './engine'
import type { AnalysisConfig, AnalysisCounts, AnalysisPacket, AnalysisUpdate, RpmObservationMode } from './types'

export type AnalysisWorkerInbound =
  | { type: 'configure'; config: AnalysisConfig }
  | { type: 'observation-mode'; mode: RpmObservationMode }
  | { type: 'reset' }
  | { type: 'packets'; packets: AnalysisPacket[] }
  | { type: 'snapshot'; requestId: number }

export type AnalysisWorkerOutbound =
  | { type: 'update'; update: AnalysisUpdate; requestId?: number }

let engine: AnalysisEngine | null = null
let observationMode: RpmObservationMode = 'revolution'
let publishTimer: number | null = null
let published: AnalysisCounts = zeroCounts()

function zeroCounts(): AnalysisCounts {
  return { primaryRpm: 0, secondaryRpm: 0, primaryPower: 0, secondaryPower: 0, ratio: 0, efficiency: 0, shift: 0, primaryObservations: 0, secondaryObservations: 0 }
}

function markPublished() { if (engine) published = engine.counts(observationMode) }

function publishReplace(requestId?: number) {
  if (!engine) return
  postMessage({ type: 'update', update: { type: 'replace', snapshot: engine.snapshot(observationMode) }, requestId } satisfies AnalysisWorkerOutbound)
  markPublished()
}

function publishAppend() {
  if (!engine) return
  const snapshot = engine.snapshotFrom(published, observationMode)
  if (!Object.values(snapshot).some((series) => series.length)) return
  postMessage({ type: 'update', update: { type: 'append', snapshot } } satisfies AnalysisWorkerOutbound)
  markPublished()
}

function publishObservationsReplace() {
  if (!engine) return
  const observations = engine.observationSnapshot(observationMode)
  postMessage({ type: 'update', update: { type: 'observations-replace', ...observations } } satisfies AnalysisWorkerOutbound)
  const counts = engine.counts(observationMode)
  published.primaryObservations = counts.primaryObservations
  published.secondaryObservations = counts.secondaryObservations
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
  } else if (message.type === 'observation-mode') {
    if (observationMode === message.mode) return
    observationMode = message.mode
    publishObservationsReplace()
  } else if (message.type === 'reset') {
    engine?.reset()
    published = zeroCounts()
    publishReplace()
  } else if (message.type === 'packets') {
    if (!engine) return
    engine.ingestMany(message.packets)
    schedulePublish()
  } else if (message.type === 'snapshot') publishReplace(message.requestId)
}
