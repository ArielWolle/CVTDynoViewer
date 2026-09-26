import { describe, expect, it } from 'vitest'
import { isRawLogCsv, parseRawLog, parseRawLogCsv } from './rawCsv'
import { RAW_END_PREFIX, RAW_METADATA_PREFIX } from '../session/rawFormat'

describe('raw CSV parsing', () => {
  it('accepts only the canonical raw schema', () => {
    const raw = 'firmware_t_us,wall_time_s,channel,channel_name,seq,raw_value,edge_count\n1000,1,0,Primary RPM,1,1250,10'
    expect(isRawLogCsv(raw)).toBe(true)
    expect(parseRawLogCsv(raw)).toHaveLength(1)
    const wide = 'timestamp_s,primary_rpm,secondary_rpm\n0,1000,900'
    expect(isRawLogCsv(wide)).toBe(false)
    expect(parseRawLogCsv(wide)).toEqual([])
  })

  it('preserves host/file arrival order instead of globally sorting timestamps', () => {
    const raw = 'firmware_t_us,wall_time_s,channel,channel_name,seq,raw_value,edge_count\n2000,1,0,Primary RPM,1,1250,10\n1000,1,1,Secondary RPM,1,1500,20'
    expect(parseRawLogCsv(raw).map((packet) => packet.tUs)).toEqual([2000, 1000])
  })

  it('parses one self-contained raw file with start and end metadata comments', () => {
    const start = JSON.stringify({ schemaVersion: 1, startedAt: '2026-09-25T12:00:00Z', primaryTeeth: 18, secondaryTeeth: 18, analysisWindowMs: 5 })
    const end = JSON.stringify({ schemaVersion: 1, stoppedAt: '2026-09-25T12:02:00Z', captureStopBoundary: 'viewer-delivery-drain' })
    const raw = `${RAW_METADATA_PREFIX}${start}
firmware_t_us,wall_time_s,channel,channel_name,seq,raw_value,edge_count
1000,1,0,Primary RPM,1,1250,10
${RAW_END_PREFIX}${end}
`
    const parsed = parseRawLog(raw)
    expect(parsed.packets).toHaveLength(1)
    expect(parsed.metadata?.primaryTeeth).toBe(18)
    expect(parsed.metadata?.analysisWindowMs).toBe(5)
    expect(parsed.metadata?.stoppedAt).toBe('2026-09-25T12:02:00Z')
    expect(parsed.metadata?.captureStopBoundary).toBe('viewer-delivery-drain')
  })

  it('still loads older raw CSVs that have no embedded metadata', () => {
    const raw = 'firmware_t_us,wall_time_s,channel,channel_name,seq,raw_value,edge_count\n1000,1,0,Primary RPM,1,1250,10'
    const parsed = parseRawLog(raw)
    expect(parsed.packets).toHaveLength(1)
    expect(parsed.metadata).toBeNull()
  })
})
