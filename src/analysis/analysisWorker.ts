/// <reference lib="webworker" />
import { AnalysisEngine } from './engine'
import type { AnalysisConfig, AnalysisPacket, AnalysisSnapshot, AnalysisUpdate } from './types'

export type AnalysisWorkerInbound =
  | { type: 'configure'; config: AnalysisConfig }
  | { type: 'reset' }
  | { type: 'packets'; packets: AnalysisPacket[] }
  | { type: 'snapshot'; requestId: number }

export type AnalysisWorkerOutbound =
  | { type: 'update'; update: AnalysisUpdate; requestId?: number }

let engine: AnalysisEngine | null = null
let publishTimer: number | null = null
let publishedFrames = 0
let publishedPrimaryObservations = 0
let publishedSecondaryObservations = 0

function markPublished() {
  if (!engine) return
  const counts = engine.counts()
  publishedFrames = counts.frames
  publishedPrimaryObservations = counts.primaryObservations
  publishedSecondaryObservations = counts.secondaryObservations
}

function publishReplace(requestId?: number) {
  if (!engine) return
  const snapshot = engine.snapshot()
  postMessage({ type: 'update', update: { type: 'replace', snapshot }, requestId } satisfies AnalysisWorkerOutbound)
  markPublished()
}

function publishAppend() {
  if (!engine) return
  const snapshot = engine.snapshotFrom(publishedFrames, publishedPrimaryObservations, publishedSecondaryObservations)
  if (!snapshot.frames.length && !snapshot.primaryObservations.length && !snapshot.secondaryObservations.length) return
  postMessage({ type: 'update', update: { type: 'append', snapshot } } satisfies AnalysisWorkerOutbound)
  markPublished()
}

function schedulePublish() {
  if (publishTimer !== null) return
  publishTimer = self.setTimeout(() => {
    publishTimer = null
    publishAppend()
  }, 33)
}

self.onmessage = (event: MessageEvent<AnalysisWorkerInbound>) => {
  const message = event.data
  if (message.type === 'configure') {
    if (engine) engine.setConfig(message.config)
    else engine = new AnalysisEngine(message.config)
    publishReplace()
  } else if (message.type === 'reset') {
    engine?.reset()
    publishedFrames = publishedPrimaryObservations = publishedSecondaryObservations = 0
    publishReplace()
  } else if (message.type === 'packets') {
    if (!engine) return
    engine.ingestMany(message.packets)
    schedulePublish()
  } else if (message.type === 'snapshot') publishReplace(message.requestId)
}
