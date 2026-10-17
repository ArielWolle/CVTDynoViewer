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
      !Number.isFinite(before.rpm) || !Number.isFinite(after.rpm)) continue
    // It must be a KNOWN quality discontinuity. Epoch changes caused by stops,
    // a channel disable, or a data reset are not invitations to invent motion.
    if (!events.some((event) => event.endMs >= before.time && event.startMs <= after.time)) continue
    result.push({ before, after })
  }
  return result
}
