import type { AnalysisPowerMode, EngineTorquePoint } from '../analysis/types'

export const RAW_LOG_HEADER = 'firmware_t_us,wall_time_s,channel,channel_name,seq,raw_value,edge_count'
export const RAW_METADATA_PREFIX = '# cvt-dyno-meta-v1 '

export type RawSessionMetadata = {
  schemaVersion: 1
  startedAt: string
  stoppedAt?: string
  firmwareGitSha?: string | null
  firmwareProtocolVersion?: number | null
  primaryTeeth?: number
  secondaryTeeth?: number
  secondaryInertiaKgM2?: number
  analysisWindowMs?: number
  powerMode?: AnalysisPowerMode
  torqueCurve?: EngineTorquePoint[]
  torqueScale?: number
  torqueOffset?: number
  channels?: boolean[]
  frequencies?: number[]
  captureStopBoundary?: 'viewer-delivery-drain'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRawSessionMetadataValue(value: unknown): RawSessionMetadata | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.startedAt !== 'string') return null
  return value as RawSessionMetadata
}

export function parseRawSessionMetadataJson(text: string): RawSessionMetadata | null {
  try {
    return parseRawSessionMetadataValue(JSON.parse(text))
  } catch {
    return null
  }
}

export function rawMetadataComment(metadata: RawSessionMetadata): string {
  return `${RAW_METADATA_PREFIX}${JSON.stringify(metadata)}`
}

export function parseEmbeddedRawMetadata(text: string): RawSessionMetadata | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(RAW_METADATA_PREFIX)) continue
    return parseRawSessionMetadataJson(trimmed.slice(RAW_METADATA_PREFIX.length))
  }
  return null
}
