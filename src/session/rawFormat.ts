import type { AnalysisPowerMode, EngineTorquePoint } from '../analysis/types'

export const RAW_LOG_HEADER = 'firmware_t_us,wall_time_s,channel,channel_name,seq,raw_value,edge_count'
export const RAW_METADATA_PREFIX = '# cvt-dyno-meta-v1 '
export const RAW_END_PREFIX = '# cvt-dyno-end-v1 '

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

type RawSessionEnd = {
  schemaVersion: 1
  stoppedAt: string
  captureStopBoundary?: 'viewer-delivery-drain'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function parseStartMetadata(text: string): RawSessionMetadata | null {
  const value = parseJsonObject(text)
  if (!value || value.schemaVersion !== 1 || typeof value.startedAt !== 'string') return null
  return value as RawSessionMetadata
}

function parseEndMetadata(text: string): RawSessionEnd | null {
  const value = parseJsonObject(text)
  if (!value || value.schemaVersion !== 1 || typeof value.stoppedAt !== 'string') return null
  return value as RawSessionEnd
}

export function rawMetadataComment(metadata: RawSessionMetadata): string {
  // The header is immutable start-of-run context. End-only fields are deliberately excluded so
  // the file never claims a clean stop until that clean stop has actually happened.
  const { stoppedAt: _stoppedAt, ...startMetadata } = metadata
  return `${RAW_METADATA_PREFIX}${JSON.stringify(startMetadata)}`
}

export function rawEndComment(metadata: RawSessionMetadata & { stoppedAt: string }): string {
  const end: RawSessionEnd = {
    schemaVersion: 1,
    stoppedAt: metadata.stoppedAt,
    ...(metadata.captureStopBoundary ? { captureStopBoundary: metadata.captureStopBoundary } : {}),
  }
  return `${RAW_END_PREFIX}${JSON.stringify(end)}`
}

export function parseEmbeddedRawMetadata(text: string): RawSessionMetadata | null {
  let start: RawSessionMetadata | null = null
  let end: RawSessionEnd | null = null

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith(RAW_METADATA_PREFIX)) {
      start = parseStartMetadata(trimmed.slice(RAW_METADATA_PREFIX.length))
    } else if (trimmed.startsWith(RAW_END_PREFIX)) {
      end = parseEndMetadata(trimmed.slice(RAW_END_PREFIX.length))
    }
  }

  if (!start) return null
  if (!end) return start

  // The footer only augments clean-stop information. It cannot overwrite the setup that existed
  // when capture began.
  return {
    ...start,
    stoppedAt: end.stoppedAt,
    ...(end.captureStopBoundary ? { captureStopBoundary: end.captureStopBoundary } : {}),
  }
}
