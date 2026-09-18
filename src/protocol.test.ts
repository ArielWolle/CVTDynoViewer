import { describe, expect, it } from 'vitest'
import { applyChannelUpdate, COMMAND_SYNC, createLiveDerivationState, crc8, csvEscape, decodePacket, deriveSample, encodeCommand, parseSamplesCsv, radPerSecondToRpm, rawLogRow, rpmToRadPerSecond, samplesToCsv, TELEMETRY_SYNC0, TELEMETRY_SYNC1, type ChannelId } from './protocol'

/** Builds a valid v2 telemetry packet (matching the firmware's framing) for test fixtures. */
function buildV2Packet(channel: number, value: number, tUs: number, seq: number, corruptCrc = false): Uint8Array {
  const packet = new Uint8Array(17)
  packet[0] = TELEMETRY_SYNC0
  packet[1] = TELEMETRY_SYNC1
  packet[2] = channel
  packet[3] = seq
  const view = new DataView(packet.buffer)
  view.setInt32(4, value, true)
  view.setUint32(8, tUs >>> 0, true)
  view.setUint32(12, Math.floor(tUs / 4294967296), true)
  packet[16] = crc8(packet.slice(2, 16))
  if (corruptCrc) packet[16] ^= 0xff
  return packet
}

describe('firmware protocol', () => {
  it('decodes v2 telemetry packets with a firmware timestamp and sequence number', () => {
    const packet = buildV2Packet(3, 5678, 123456789012, 42)
    expect(decodePacket(packet)).toEqual({ channel: 3, value: 5678, tUs: 123456789012, seq: 42 })
  })

  it('rejects a v2 packet with a corrupted CRC instead of misdecoding it', () => {
    const packet = buildV2Packet(3, 5678, 1000, 1, true)
    expect(decodePacket(packet)).toBeNull()
  })

  it('rejects a v2-looking packet with an out-of-range channel', () => {
    const packet = buildV2Packet(9, 1, 1000, 0)
    expect(decodePacket(packet)).toBeNull()
  })

  it('still decodes the older 8-byte v1 packets (no CRC/timestamp) for pre-upgrade firmware', () => {
    expect(decodePacket(new Uint8Array([0xaa, 0xbb, 3, 0, 0x2e, 0x16, 0, 0]))).toEqual({ channel: 3, value: 5678, tUs: 0, seq: 0 })
    expect(decodePacket(new Uint8Array([0xbb, 0xaa, 3, 0, 0x2e, 0x16, 0, 0]))).toEqual({ channel: 3, value: 5678, tUs: 0, seq: 0 })
  })

  it('encodes commands with a leading sync byte and big-endian value', () => {
    const command = [...encodeCommand(2, 4, 500)]
    expect(command[0]).toBe(COMMAND_SYNC)
    expect(command.slice(1)).toEqual([2, 4, 1, 244])
  })

  it('derives power and efficiency from torque and rpm', () => {
    const sample = deriveSample({ time: 0, rpm1: 9549, rpm2: 4774.5, shift: 0, torq1: 100, torq2: 50 }, 1, 0)
    expect(sample.power1).toBeCloseTo(100)
    expect(sample.efficiency).toBeCloseTo(25)
  })

  it('escapes CSV values and emits an SI-unit header', () => {
    expect(csvEscape('pull, A')).toBe('"pull, A"')
    const header = samplesToCsv([]).split('\n')[0]
    expect(header).toContain('timestamp_s')
    expect(header).toContain('primary_angular_velocity_rad_s')
    expect(header).toContain('primary_torque_nm')
    expect(header).toContain('primary_power_w')
  })

  it('converts between RPM and rad/s', () => {
    expect(rpmToRadPerSecond(60)).toBeCloseTo(2 * Math.PI)
    expect(radPerSecondToRpm(2 * Math.PI)).toBeCloseTo(60)
  })

  it('derives inertia-mode power from shaft acceleration and an engine torque curve', () => {
    const sample = deriveSample({ time: 1000, rpm1: 1800, rpm2: 1800, shift: 0, torq1: 0, torq2: 0 }, 1, 0, 'inertia', { time: 0, rpm1: 1000, rpm2: 0 })
    expect(sample.power1).toBeGreaterThan(4)
    expect(sample.power2).toBeGreaterThan(0)
    expect(sample.efficiency).toBeGreaterThan(0)
  })

  it('honors a custom RPM vs torque curve in inertia mode', () => {
    const flatCurve = [{ rpm: 0, torque: 0 }, { rpm: 5000, torque: 40 }]
    const sample = deriveSample({ time: 0, rpm1: 5000, rpm2: 0, shift: 0, torq1: 0, torq2: 0 }, 1, 0, 'inertia', undefined, 0.3, flatCurve)
    const defaultSample = deriveSample({ time: 0, rpm1: 5000, rpm2: 0, shift: 0, torq1: 0, torq2: 0 }, 1, 0, 'inertia')
    expect(sample.power1).toBeGreaterThan(defaultSample.power1)
  })

  it('round-trips samples through the SI-unit CSV format', () => {
    const torqueScale = 0.01
    const torqueOffset = 5
    const csv = samplesToCsv([
      { time: 0, rpm1: 1000, rpm2: 900, shift: 10, torq1: 50, torq2: 40, power1: 5, power2: 4, efficiency: 80 },
      { time: 100, rpm1: 1100, rpm2: 950, shift: 12, torq1: 55, torq2: 42, power1: 6, power2: 4.5, efficiency: 75 },
    ], torqueScale, torqueOffset)
    expect(csv).toContain('primary_torque_nm')
    const parsed = parseSamplesCsv(csv, torqueScale, torqueOffset)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].time).toBeCloseTo(0, 1)
    expect(parsed[0].rpm1).toBeCloseTo(1000, 1)
    expect(parsed[0].rpm2).toBeCloseTo(900, 1)
    expect(parsed[0].torq1).toBeCloseTo(50, 1)
    expect(parsed[0].power1).toBeCloseTo(5, 2)
    expect(parsed[1].time).toBeCloseTo(100, 1)
    expect(parsed[1].rpm1).toBeCloseTo(1100, 1)
    expect(parsed[1].rpm2).toBeCloseTo(950, 1)
  })

  it('returns an empty array for CSV text missing required columns', () => {
    expect(parseSamplesCsv('a,b\n1,2')).toEqual([])
    expect(parseSamplesCsv('')).toEqual([])
  })

  it('tolerates a stray character prefixed onto the header row', () => {
    const csv = 'Ctimestamp_ms,primary_rpm,secondary_rpm,shift_position,primary_torque,secondary_torque,primary_power_kw,secondary_power_kw,efficiency_percent\n1000,2000,1800,10,50,40,5.000,4.000,80.00'
    const parsed = parseSamplesCsv(csv)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ time: 1000, rpm1: 2000, rpm2: 1800 })
  })
})

describe('event-driven live capture', () => {
  it('forward-fills channels that have not updated yet into every emitted row', () => {
    const state = createLiveDerivationState()
    const first = applyChannelUpdate(state, 0 as ChannelId, 3000, 0, 1, 0, 'torque')
    expect(first).toMatchObject({ rpm1: 3000, rpm2: 0, shift: 0, torq1: 0, torq2: 0 })
    // A later, unrelated channel (shift) update should still carry the earlier rpm1 value forward.
    const second = applyChannelUpdate(state, 2 as ChannelId, 55, 10, 1, 0, 'torque')
    expect(second).toMatchObject({ rpm1: 3000, shift: 55 })
  })

  it('in inertia mode, only recomputes secondary power when rpm2 itself updates, holding the last value on other channels', () => {
    const state = createLiveDerivationState()
    // The very first rpm2 sample has no prior baseline to differentiate against (matching
    // `deriveSample`'s own convention), so it establishes a baseline at rest with zero power.
    applyChannelUpdate(state, 1 as ChannelId, 0, 0, 1, 0, 'inertia', 0.3134)
    // rpm2 then accelerates to 1800 over the next 100ms -- a real acceleration event.
    const rpm2Update = applyChannelUpdate(state, 1 as ChannelId, 1800, 100, 1, 0, 'inertia', 0.3134)
    expect(rpm2Update.power2).toBeGreaterThan(0)
    const powerAfterRpm2Update = rpm2Update.power2

    // A torque packet arrives 5ms later without rpm2 changing. Naively differentiating rpm2
    // against the immediately-preceding row here (rpm2 unchanged, tiny dt) would wrongly compute
    // zero acceleration and zero out secondary power; it should instead hold the last computed
    // value forward like any other forward-filled field.
    const torqueUpdate = applyChannelUpdate(state, 3 as ChannelId, 42, 105, 1, 0, 'inertia', 0.3134)
    expect(torqueUpdate.power2).toBeCloseTo(powerAfterRpm2Update)

    // A second, later rpm2 update (no further acceleration) should compute a fresh dt against the
    // *previous rpm2 sample* (100ms) rather than the intervening torque row (105ms).
    const secondRpm2Update = applyChannelUpdate(state, 1 as ChannelId, 1800, 200, 1, 0, 'inertia', 0.3134)
    expect(secondRpm2Update.power2).toBeCloseTo(0, 5)
  })

  it('does not spike secondary power when a burst of rpm2 samples land a fraction of a millisecond apart (no firmware timestamp)', () => {
    const state = createLiveDerivationState()
    applyChannelUpdate(state, 1 as ChannelId, 1000, 0, 1, 0, 'inertia', 0.3134)
    // Three "distinct" rpm2 samples arrive within a sub-millisecond burst, as can happen when a
    // browser read() call returns several buffered packets that get processed in one synchronous
    // loop and timestamped with receive time (e.g. older firmware with no capture timestamp).
    // Differentiating naively against each tiny sub-millisecond gap would produce a
    // multi-megawatt spike from an ordinary RPM step.
    const burst1 = applyChannelUpdate(state, 1 as ChannelId, 1010, 0.1, 1, 0, 'inertia', 0.3134)
    const burst2 = applyChannelUpdate(state, 1 as ChannelId, 1020, 0.15, 1, 0, 'inertia', 0.3134)
    expect(burst1.power2).toBeLessThan(1) // still ~0: held from the baseline, not recomputed against a ~0ms gap
    expect(burst2.power2).toBeLessThan(1)
    expect(burst1.rpm2).toBe(1010) // the *value* still updates/forward-fills normally
    expect(burst2.rpm2).toBe(1020)

    // The next update after a real interval measures the combined change (1000 -> 1030) over the
    // combined elapsed time (0 -> 50ms) -- i.e. the burst's skipped baseline updates didn't lose
    // or corrupt the eventual acceleration measurement.
    const afterBurst = applyChannelUpdate(state, 1 as ChannelId, 1030, 50, 1, 0, 'inertia', 0.3134)
    expect(afterBurst.power2).toBeGreaterThan(0)
  })

  it('formats a lossless raw per-channel log row with firmware time, wall time, and sequence', () => {
    const row = rawLogRow(1 as ChannelId, 4200, 123456789, 1500.25, 7)
    expect(row).toBe('123456789,1.500250,1,Secondary RPM,7,4200')
  })
})