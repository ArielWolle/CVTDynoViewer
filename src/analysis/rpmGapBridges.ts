import type { QualityEvent } from '../quality/dataQuality'

// Only visual bridges between existing, independently valid output points.
// No synthetic RPM samples are generated, stored, exported, or used in physics.
export type RpmBridgePoint = { time: number; rpm: number; epoch?: number }
export type RpmGapBridge<T extends RpmBridgePoint> = { before: T; after: T }

export function selectShortRpmQualityBridges<T extends RpmBridgePoint>(
  points: readonly T[],
  events: readonly QualityEvent[],
  analysisWindowMs: number,
): RpmGapBridge<T>[] {
  // Enough for one locally rejected revolution plus a skipped analysis grid
  // interval, but never bridge an extended stop or an unrelated long outage.
  const maxBridgeMs = Math.max(500, Math.min(1500, 3 * analysisWindowMs))
  const result: RpmGapBridge<T>[] = []
  if (!events.length) return result
  for (let i = 1; i < points.length; i += 1) {
    const before = points[i - 1]
    const after = points[i]
    const span = after.time - before.time
    if (!(span > 0) || span > maxBridgeMs ||
      before.epoch === undefined || after.epoch === undefined ||
      before.epoch === after.epoch ||
      !(before.rpm > 0) || !(after.rpm > 0)) continue
    // Only bridge ONE locally isolated, known data-quality incident. A dense
    // cluster of missing pulses is not a trustworthy interval to interpolate.
    // The explicit stopped-zero endpoint must never be visually interpolated.
    let affectedIntervals = 0
    for (const event of events) {
      if (event.endMs < before.time || event.startMs > after.time) continue
      affectedIntervals += 1
      if (affectedIntervals > 1) break
    }
    if (affectedIntervals !== 1) continue
    result.push({ before, after })
  }
  return result
}
