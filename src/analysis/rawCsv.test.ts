import { describe, expect, it } from 'vitest'
import { isRawLogCsv, parseRawLogCsv } from './rawCsv'

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
})
