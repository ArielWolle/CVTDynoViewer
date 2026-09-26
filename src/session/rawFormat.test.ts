import { describe, expect, it } from 'vitest'
import { parseEmbeddedRawMetadata, rawEndComment, rawMetadataComment, type RawSessionMetadata } from './rawFormat'

describe('raw session metadata', () => {
  it('round-trips start setup and clean-stop metadata inside one raw CSV', () => {
    const start: RawSessionMetadata = {
      schemaVersion: 1,
      startedAt: '2026-09-25T12:00:00Z',
      primaryTeeth: 18,
      secondaryTeeth: 12,
      analysisWindowMs: 5,
      captureStopBoundary: 'viewer-delivery-drain',
    }
    const end = { ...start, stoppedAt: '2026-09-25T12:01:30Z' } as RawSessionMetadata & { stoppedAt: string }
    const text = `${rawMetadataComment(start)}
firmware_t_us,wall_time_s,channel,channel_name,seq,raw_value,edge_count
1000,1,0,Primary RPM,1,1250,10
${rawEndComment(end)}
`
    const parsed = parseEmbeddedRawMetadata(text)
    expect(parsed?.primaryTeeth).toBe(18)
    expect(parsed?.analysisWindowMs).toBe(5)
    expect(parsed?.startedAt).toBe(start.startedAt)
    expect(parsed?.stoppedAt).toBe(end.stoppedAt)
    expect(parsed?.captureStopBoundary).toBe('viewer-delivery-drain')
  })

  it('keeps an interrupted run usable when no clean-stop footer exists', () => {
    const start: RawSessionMetadata = {
      schemaVersion: 1,
      startedAt: '2026-09-25T12:00:00Z',
      primaryTeeth: 18,
    }
    const parsed = parseEmbeddedRawMetadata(`${rawMetadataComment(start)}
firmware_t_us,wall_time_s,channel,channel_name,seq,raw_value,edge_count
1000,1,0,Primary RPM,1,1250,10
`)
    expect(parsed?.primaryTeeth).toBe(18)
    expect(parsed?.stoppedAt).toBeUndefined()
  })

  it('does not let clean-stop metadata overwrite start-of-run setup', () => {
    const start: RawSessionMetadata = {
      schemaVersion: 1,
      startedAt: '2026-09-25T12:00:00Z',
      primaryTeeth: 18,
      secondaryInertiaKgM2: 0.3134,
    }
    const end = { ...start, primaryTeeth: 99, secondaryInertiaKgM2: 99, stoppedAt: '2026-09-25T12:02:00Z' } as RawSessionMetadata & { stoppedAt: string }
    const parsed = parseEmbeddedRawMetadata(`${rawMetadataComment(start)}
header
${rawEndComment(end)}
`)
    expect(parsed?.primaryTeeth).toBe(18)
    expect(parsed?.secondaryInertiaKgM2).toBe(0.3134)
  })
})
