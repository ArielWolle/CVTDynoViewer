export type ChannelId = 0 | 1 | 2 | 3 | 4 | 5

export const channelNames = ['Primary RPM', 'Secondary RPM', 'Shift position', 'Primary torque', 'Secondary torque', 'Full throttle'] as const

// Converts a raw per-tooth inter-edge period (as sent by RPM channels 0/1, see the protocol
// comment below) into RPM, given the wheel's tooth count. teethPerRevolution is purely a
// display/reconstruction setting on this side -- the firmware has no concept of it at all -- so
// changing it here takes effect immediately with no firmware round-trip. periodUs === 0 is the
// firmware's explicit "this channel has stopped" report (see the protocol comment below) and
// correctly returns a real 0 RPM here, not a skipped/ignored value. Negative/non-physical inputs
// (a bad tooth count) also return 0 rather than Infinity/NaN from a division by zero.
export function periodUsToRpm(periodUs: number, teethPerRevolution: number): number {
  if (periodUs < 0 || teethPerRevolution <= 0) return 0
  if (periodUs === 0) return 0
  return 60_000_000 / (periodUs * teethPerRevolution)
}

// --- USB telemetry protocol v3 --------------------------------------------------------------
// Telemetry packet (21 bytes -- widened from 17 in protocol v1, see EXPECTED_PROTOCOL_VERSION
// below). Layout: [0xAA][0x55][channel][seq][int32 value LE][uint64 t_us LE][uint32 edgeCount
// LE][crc8]. The CRC (and fixed length) means a value that happens to contain the sync bytes can
// no longer desync the parser the way the old length-less v1 framing could.
//
// Channels 2-4 (shift/torque) are sent independently per channel on their own firmware-configured
// polling rate -- e.g. torque can run much faster than shift without either one throttling the
// other -- and `value` is the polled sensor reading directly. `edgeCount` is always 0 for these
// (and channel 5) -- there's no physical-edge concept to count.
//
// Channels 0-1 (RPM1/RPM2) are edge-triggered instead of polled: the firmware sends one packet
// per physical tooth as soon as it's detected, with `value` = the raw inter-edge period in
// microseconds since the previous tooth on that channel, NOT an RPM value (see periodUsToRpm()
// below for the conversion this app applies). `value === 0` is the firmware's explicit "this
// channel has stopped" report, pushed once after ~500ms with no real edge -- a real reading meant
// to be applied as RPM === 0 (via periodUsToRpm), not a marker to be ignored. A period is only
// ever computed from two actual edges on the firmware side, so `value` is never 0 for "first edge,
// nothing to diff against yet" the way an earlier version of this protocol used it.
//
// `edgeCount` (RPM channels only) is a monotonically increasing per-channel count of physical
// edges, assigned at ISR capture time on the firmware -- BEFORE the event is queued for
// transmission, unlike `seq` (assigned at transmit time). A gap in `edgeCount` on consecutive RPM
// packets means an edge was lost before it ever reached the ring/USB (e.g. the firmware's ring
// buffer overflowing during a transient host stall) -- distinct from a gap in `seq`, which means a
// packet WAS queued for transmission but never arrived (downstream/USB loss). Previously these two
// failure modes were indistinguishable -- and the ring-overflow case was completely invisible,
// since a dropped edge never got a seq number in the first place, so seq looked perfectly
// continuous either way. See App.tsx's handleValue() for how both are tracked and surfaced
// separately, and rawLogRow()'s edge_count column below for offline analysis.
//
// Transport: the firmware exposes a WebUSB vendor-class interface (see usbTransport.ts), not a
// virtual COM port -- there is no baud rate, and Windows binds it to WinUSB automatically via the
// WebUSB descriptor's MS OS 2.0 registry property, with no separate driver install needed.
//
// Firmware/viewer version check: the firmware reports "Firmware git: <sha>" and "Protocol
// version: <n>" in its command-0x03 config dump (sent automatically right after every connect --
// see connect() in App.tsx). EXPECTED_PROTOCOL_VERSION here must match PROTOCOL_VERSION in the
// firmware's main.cpp exactly; App.tsx warns loudly on a mismatch rather than silently
// misbehaving. Bump this (and the firmware's constant, together, in the same change) whenever a
// change alters wire-level semantics the viewer must know about -- e.g. the change that made RPM's
// `value === 0` mean "stopped" instead of "first edge, nothing to diff against yet" (see the
// comment on channels 0-1 above) is exactly the kind of change this exists to catch immediately
// instead of it taking a live debugging session to track down, as happened once before this
// existed.
export const EXPECTED_PROTOCOL_VERSION = 2
export const TELEMETRY_SYNC0 = 0xaa
export const TELEMETRY_SYNC1 = 0x55
export const TELEMETRY_PACKET_LEN = 21
const TELEMETRY_CRC_SPAN = 18 // bytes [2..19]: channel, seq, value, t_us, edgeCount

export const COMMAND_SYNC = 0xc0
export const COMMAND_PACKET_LEN = 5

/** CRC-8 (poly 0x07, init 0x00) -- must match the firmware's implementation exactly. */
export function crc8(bytes: Uint8Array): number {
  let crc = 0
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index]
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
    }
  }
  return crc
}

export type DecodedPacket = { channel: ChannelId; value: number; tUs: number; seq: number; edgeCount: number }

/**
 * Decodes one current telemetry packet: the fixed 21-byte, CRC-checked framing emitted by the
 * supported WebUSB firmware. Older packet layouts are intentionally rejected; they do not carry
 * the timestamp/sequence/edge-count information required by the current analysis and loss
 * accounting pipeline. Firmware/viewer compatibility is handled explicitly via protocol version.
 */
export function decodePacket(packet: Uint8Array): DecodedPacket | null {
  if (packet.length !== TELEMETRY_PACKET_LEN || packet[0] !== TELEMETRY_SYNC0 || packet[1] !== TELEMETRY_SYNC1) return null
  const channel = packet[2]
  if (channel > 5) return null
  const expectedCrc = crc8(packet.slice(2, 2 + TELEMETRY_CRC_SPAN))
  if (packet[20] !== expectedCrc) return null
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  const value = view.getInt32(4, true)
  const tUsLow = view.getUint32(8, true)
  const tUsHigh = view.getUint32(12, true)
  const tUs = tUsHigh * 4294967296 + tUsLow
  const edgeCount = view.getUint32(16, true)
  return { channel: channel as ChannelId, value, tUs, seq: packet[3], edgeCount }
}

export function encodeCommand(command: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, channel = 0, value = 0): Uint8Array {
  return new Uint8Array([COMMAND_SYNC, command, channel, (value >> 8) & 0xff, value & 0xff])
}

// --- Raw per-channel log -----------------------------------------------------------------------
// The wide CSV above necessarily resamples: every row forward-fills channels that didn't change,
// so if a channel (e.g. torque, in the future) runs much faster than the others, its extra
// samples between wide rows are lost. This raw, long-format log instead writes exactly one line
// per received packet with no resampling, so no data is ever discarded regardless of relative
// channel rates -- intended for archival/re-analysis, not for re-import into the app.
// edge_count is 0 for non-RPM channels (see the protocol comment above) -- always present so the
// column count stays uniform regardless of channel, matching the firmware's own uniform packet
// layout. This is the column that makes device-side (pre-USB) loss detectable in an offline
// analysis: a gap in edge_count for a given channel between consecutive rows means an edge was
// dropped before it ever reached the ring/USB, which a gap (or lack of one) in `seq` cannot reveal
// on its own -- see EXPECTED_PROTOCOL_VERSION's comment above for the full reasoning.
export const rawLogHeader = 'firmware_t_us,wall_time_s,channel,channel_name,seq,raw_value,edge_count'

export function rawLogRow(channel: ChannelId, value: number, tUs: number, wallTimeMs: number, seq: number, edgeCount: number): string {
  return [tUs, (wallTimeMs / 1000).toFixed(6), channel, channelNames[channel], seq, value, edgeCount].map(csvEscape).join(',')
}

export function csvEscape(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
