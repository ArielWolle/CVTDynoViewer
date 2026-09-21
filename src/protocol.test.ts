import { describe, expect, it } from 'vitest'
import { applyChannelUpdate, COMMAND_SYNC, createLiveDerivationState, crc8, csvEscape, decodePacket, deriveSample, encodeCommand, parseSamplesCsv, periodUsToRpm, radPerSecondToRpm, rawLogRow, rpmToRadPerSecond, samplesToCsv, TELEMETRY_SYNC0, TELEMETRY_SYNC1, type ChannelId } from './protocol'

/** Inverse of periodUsToRpm(), for building RPM-channel test fixtures against the raw wire value (period_us) the firmware actually sends, at a given tooth count (default 1 -- matches applyChannelUpdate's own default). */
function rpmToPeriodUs(rpm: number, teethPerRevolution = 1): number {
  return rpm > 0 ? 60_000_000 / (rpm * teethPerRevolution) : 0
}

/** Builds a valid v3 telemetry packet (matching the firmware's framing) for test fixtures. */
function buildV3Packet(channel: number, value: number, tUs: number, seq: number, edgeCount = 0, corruptCrc = false): Uint8Array {
  const packet = new Uint8Array(21)
  packet[0] = TELEMETRY_SYNC0
  packet[1] = TELEMETRY_SYNC1
  packet[2] = channel
  packet[3] = seq
  const view = new DataView(packet.buffer)
  view.setInt32(4, value, true)
  view.setUint32(8, tUs >>> 0, true)
  view.setUint32(12, Math.floor(tUs / 4294967296), true)
  view.setUint32(16, edgeCount, true)
  packet[20] = crc8(packet.slice(2, 20))
  if (corruptCrc) packet[20] ^= 0xff
  return packet
}

describe('firmware protocol', () => {
  it('decodes v3 telemetry packets with a firmware timestamp, sequence number, and edge counter', () => {
    const packet = buildV3Packet(3, 5678, 123456789012, 42, 9)
    expect(decodePacket(packet)).toEqual({ channel: 3, value: 5678, tUs: 123456789012, seq: 42, edgeCount: 9 })
  })

  it('rejects a v3 packet with a corrupted CRC instead of misdecoding it', () => {
    const packet = buildV3Packet(3, 5678, 1000, 1, 0, true)
    expect(decodePacket(packet)).toBeNull()
  })

  it('rejects a v3-looking packet with an out-of-range channel', () => {
    const packet = buildV3Packet(9, 1, 1000, 0)
    expect(decodePacket(packet)).toBeNull()
  })

  it('decodes channel 5 (full throttle), sent on change rather than on a schedule', () => {
    const packet = buildV3Packet(5, 1, 5000, 0)
    expect(decodePacket(packet)).toEqual({ channel: 5, value: 1, tUs: 5000, seq: 0, edgeCount: 0 })
  })

  it('still decodes the older 8-byte v1 packets (no CRC/timestamp/edge counter) for pre-upgrade firmware', () => {
    expect(decodePacket(new Uint8Array([0xaa, 0xbb, 3, 0, 0x2e, 0x16, 0, 0]))).toEqual({ channel: 3, value: 5678, tUs: 0, seq: 0, edgeCount: 0 })
    expect(decodePacket(new Uint8Array([0xbb, 0xaa, 3, 0, 0x2e, 0x16, 0, 0]))).toEqual({ channel: 3, value: 5678, tUs: 0, seq: 0, edgeCount: 0 })
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

  it('converts a raw per-tooth period to RPM using the given tooth count', () => {
    // 16 teeth, 1000 RPM -> one tooth every 60e6 / (1000 * 16) = 3750us
    expect(periodUsToRpm(3750, 16)).toBeCloseTo(1000, 6)
    // periodUs === 0 is the firmware's explicit "stopped" report -- a real reading, correctly
    // converting to a real 0 RPM (not skipped, not Infinity/NaN).
    expect(periodUsToRpm(0, 16)).toBe(0)
    // Other non-physical inputs (a negative period, or a bad tooth count) must not produce
    // Infinity/NaN either.
    expect(periodUsToRpm(-5, 16)).toBe(0)
    expect(periodUsToRpm(3750, 0)).toBe(0)
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
      { time: 0, rpm1: 1000, rpm2: 900, shift: 10, torq1: 50, torq2: 40, power1: 5, power2: 4, efficiency: 80, fullThrottle: false },
      { time: 100, rpm1: 1100, rpm2: 950, shift: 12, torq1: 55, torq2: 42, power1: 6, power2: 4.5, efficiency: 75, fullThrottle: true },
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
    expect(parsed[0].fullThrottle).toBe(false)
    expect(parsed[1].fullThrottle).toBe(true)
  })

  it('defaults full_throttle to false when reading an older CSV that predates the column', () => {
    const csv = 'timestamp_s,primary_angular_velocity_rad_s,secondary_angular_velocity_rad_s,shift_position_percent,primary_torque_nm,secondary_torque_nm,primary_power_w,secondary_power_w,efficiency_percent\n0.000,100,90,10,5,4,500,400,80'
    const parsed = parseSamplesCsv(csv)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].fullThrottle).toBe(false)
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
    const first = applyChannelUpdate(state, 0 as ChannelId, rpmToPeriodUs(3000), 0, 1, 0, 'torque')
    expect(first).toMatchObject({ rpm1: 3000, rpm2: 0, shift: 0, torq1: 0, torq2: 0 })
    // A later, unrelated channel (shift) update should still carry the earlier rpm1 value forward.
    const second = applyChannelUpdate(state, 2 as ChannelId, 55, 10, 1, 0, 'torque')
    expect(second).toMatchObject({ rpm1: 3000, shift: 55 })
  })

  it('treats a raw period_us of 0 (the firmware\u2019s explicit "stopped" report) as a real RPM === 0 reading, applied like any other update', () => {
    const state = createLiveDerivationState()
    const primed = applyChannelUpdate(state, 0 as ChannelId, rpmToPeriodUs(3000), 0, 1, 0, 'torque')
    expect(primed.rpm1).toBe(3000)
    // The firmware only ever sends periodUs === 0 to explicitly report a channel has stopped (see
    // RpmCounter::pollStale() in the firmware) -- this must actually zero out rpm1, not hold the
    // last nonzero reading forever.
    const afterStop = applyChannelUpdate(state, 0 as ChannelId, 0, 10, 1, 0, 'torque')
    expect(afterStop.rpm1).toBe(0)
  })

  it('in inertia mode, only recomputes secondary power when rpm2 itself updates, holding the last value on other channels', () => {
    const state = createLiveDerivationState()
    // The very first rpm2 sample has no prior baseline to differentiate against (matching
    // `deriveSample`'s own convention), so it establishes a baseline at rest with zero power.
    applyChannelUpdate(state, 1 as ChannelId, 0, 0, 1, 0, 'inertia', 0.3134)
    // rpm2 then accelerates to 1800 over the next 100ms -- a real acceleration event.
    const rpm2Update = applyChannelUpdate(state, 1 as ChannelId, rpmToPeriodUs(1800), 100, 1, 0, 'inertia', 0.3134)
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
    const secondRpm2Update = applyChannelUpdate(state, 1 as ChannelId, rpmToPeriodUs(1800), 200, 1, 0, 'inertia', 0.3134)
    expect(secondRpm2Update.power2).toBeCloseTo(0, 5)
  })

  it('does not spike secondary power when a burst of rpm2 samples land a fraction of a millisecond apart (no firmware timestamp)', () => {
    const state = createLiveDerivationState()
    applyChannelUpdate(state, 1 as ChannelId, rpmToPeriodUs(1000), 0, 1, 0, 'inertia', 0.3134)
    // Three "distinct" rpm2 samples arrive within a sub-millisecond burst, as can happen when a
    // browser read() call returns several buffered packets that get processed in one synchronous
    // loop and timestamped with receive time (e.g. older firmware with no capture timestamp).
    // Differentiating naively against each tiny sub-millisecond gap would produce a
    // multi-megawatt spike from an ordinary RPM step.
    const burst1 = applyChannelUpdate(state, 1 as ChannelId, rpmToPeriodUs(1010), 0.1, 1, 0, 'inertia', 0.3134)
    const burst2 = applyChannelUpdate(state, 1 as ChannelId, rpmToPeriodUs(1020), 0.15, 1, 0, 'inertia', 0.3134)
    expect(burst1.power2).toBeLessThan(1) // still ~0: held from the baseline, not recomputed against a ~0ms gap
    expect(burst2.power2).toBeLessThan(1)
    expect(burst1.rpm2).toBeCloseTo(1010, 6) // the *value* still updates/forward-fills normally (round-tripped through period_us, not bit-exact)
    expect(burst2.rpm2).toBeCloseTo(1020, 6)

    // The next update after a real interval measures the combined change (1000 -> 1030) over the
    // combined elapsed time (0 -> 50ms) -- i.e. the burst's skipped baseline updates didn't lose
    // or corrupt the eventual acceleration measurement.
    const afterBurst = applyChannelUpdate(state, 1 as ChannelId, rpmToPeriodUs(1030), 50, 1, 0, 'inertia', 0.3134)
    expect(afterBurst.power2).toBeGreaterThan(0)
  })

  it('holds the full-throttle state across other channels\u2019 updates until it actually changes', () => {
    const state = createLiveDerivationState()
    const initial = applyChannelUpdate(state, 0 as ChannelId, rpmToPeriodUs(3000), 0, 1, 0, 'torque')
    expect(initial.fullThrottle).toBe(false)
    const asserted = applyChannelUpdate(state, 5 as ChannelId, 1, 10, 1, 0, 'torque')
    expect(asserted.fullThrottle).toBe(true)
    // An unrelated channel update afterward should keep reporting full throttle as still true --
    // it only changes on its own channel 5 packets, never forward-filled-away by other channels.
    const unrelated = applyChannelUpdate(state, 3 as ChannelId, 55, 20, 1, 0, 'torque')
    expect(unrelated.fullThrottle).toBe(true)
    const released = applyChannelUpdate(state, 5 as ChannelId, 0, 30, 1, 0, 'torque')
    expect(released.fullThrottle).toBe(false)
  })

  it('formats a lossless raw per-channel log row with firmware time, wall time, sequence, and edge count', () => {
    const row = rawLogRow(1 as ChannelId, 4200, 123456789, 1500.25, 7, 99)
    expect(row).toBe('123456789,1.500250,1,Secondary RPM,7,4200,99')
  })
})