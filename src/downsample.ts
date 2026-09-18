/**
 * Reduces `data` to at most `maxPoints` entries for chart rendering only -- the underlying sample
 * buffer, raw/wide logs, and moving-average math in protocol.ts all still see every single sample
 * regardless of what this returns. This exists because RPM channels now stream one packet per
 * physical tooth (see the firmware's edge-triggered RpmCounter) instead of a fixed ~20 Hz poll, so
 * a multi-minute session can accumulate far more wide-format rows than a chart library can render
 * smoothly -- Recharts (like most SVG chart libraries) draws every point in its `data` array with
 * no built-in decimation, so an unbounded point count is what caused real lag/jank once RPM
 * started arriving at up to ~1-2 kHz instead of 20 Hz.
 *
 * Splits the input into `Math.floor(maxPoints / 2)` equal-sized index buckets and keeps each
 * bucket's first and last entry. This is a cheap O(n) pass, and -- unlike naive every-Nth-point
 * stride sampling -- it can never flatten a fast transition (e.g. a throttle blip) into a smooth
 * line just because the sampled stride happened to skip past it entirely, since every bucket's
 * boundary values are always kept. The tradeoff: a spike that occurs strictly *inside* a bucket
 * (touching neither its first nor last point) can still be missed. Full-fidelity data remains
 * available in the raw per-channel CSV log (see rawLogRow in protocol.ts) for exactly that reason
 * -- this function only governs what gets drawn on screen, never what gets logged or analyzed.
 */
export function downsampleForChart<T>(data: readonly T[], maxPoints: number): T[] {
  if (maxPoints < 2 || data.length <= maxPoints) return [...data]

  const bucketCount = Math.floor(maxPoints / 2)
  const bucketSize = data.length / bucketCount
  const result: T[] = []

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * bucketSize)
    const end = Math.min(data.length - 1, Math.floor((bucket + 1) * bucketSize) - 1)
    if (start > end) continue // guards a pathological/empty bucket; shouldn't occur since bucketSize >= 1 here
    result.push(data[start])
    if (end > start) result.push(data[end])
  }

  // Adjacent buckets can't mathematically produce the exact same index here (their ranges are
  // computed from strictly increasing bucket boundaries), but guard defensively against any
  // accidental consecutive duplicate (by reference, since these are the original array's elements,
  // not copies) rather than relying on that invariant never being violated by a future edit.
  return result.filter((point, index) => index === 0 || point !== result[index - 1])
}
