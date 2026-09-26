import { describe, expect, it } from 'vitest'
import { parseRawSessionMetadataJson, rawMetadataComment, parseEmbeddedRawMetadata } from './rawFormat'

describe('raw session metadata', () => {
  it('round-trips the recorded setup through the raw CSV comment format', () => {
    const metadata = { schemaVersion: 1 as const, startedAt: '2026-09-25T12:00:00Z', primaryTeeth: 18, secondaryTeeth: 12, analysisWindowMs: 5 }
    const comment = rawMetadataComment(metadata)
    expect(parseEmbeddedRawMetadata(`${comment}\nheader\n`)?.primaryTeeth).toBe(18)
  })

  it('rejects unrelated or malformed companion JSON', () => {
    expect(parseRawSessionMetadataJson('{"schemaVersion":2,"startedAt":"x"}')).toBeNull()
    expect(parseRawSessionMetadataJson('not json')).toBeNull()
  })
})
