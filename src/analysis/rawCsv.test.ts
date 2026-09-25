import { describe, expect, it } from 'vitest'
import { isRawLogCsv, parseRawLogCsv } from './rawCsv'

describe('parseRawLogCsv', () => {
  it('rejects a processed/wide CSV as a raw run', () => {
    const wide = 'timestamp_s,primary_angular_velocity_rad_s,secondary_angular_velocity_rad_s\n0,10,9'
    expect(isRawLogCsv(wide)).toBe(false)
    expect(parseRawLogCsv(wide)).toEqual([])
  })
  it('reads the raw source-of-truth format including edge_count', () => {
    const csv = [
      'firmware_t_us,wall_time_s,channel,channel_name,seq,raw_value,edge_count',
      '1000,1.0,0,Primary RPM,7,1250,41',
      '1100,1.1,5,Full throttle,2,1,0',
    ].join('\n')
    expect(parseRawLogCsv(csv)).toEqual([
      { tUs: 1000, channel: 0, seq: 7, value: 1250, edgeCount: 41 },
      { tUs: 1100, channel: 5, seq: 2, value: 1, edgeCount: 0 },
    ])
  })
})
