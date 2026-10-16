import { TriangleAlert } from 'lucide-react'
import type { QualitySnapshot } from './dataQuality'

export type RunWarning = {
  id: string
  label: string
  message: string
}

const WARNING_LABELS: Record<string, string> = {
  usb: 'USB connection',
  'raw-log': 'Raw capture',
  'analysis-worker': 'Analysis',
  'replay-file': 'Saved run',
  'replay-metadata': 'Replay setup',
}

/** Keep every independent issue visible. A later USB error cannot hide a CSV setup warning. */
export function buildRunWarnings(
  warningIssues: Readonly<Record<string, string>>,
  quality: QualitySnapshot,
): RunWarning[] {
  const warnings: RunWarning[] = Object.entries(warningIssues).map(([id, message]) => ({
    id, label: WARNING_LABELS[id] ?? 'Viewer', message,
  }))

  if (quality.transmissionPacketsLost > 0) {
    const count = quality.transmissionPacketsLost
    warnings.push({
      id: 'packets',
      label: 'Telemetry loss',
      message: count.toLocaleString() + ' transmitted packet' + (count === 1 ? '' : 's') +
        ' missing. Affected intervals may contain incomplete measurements.',
    })
  }

  const [primaryLost, secondaryLost] = quality.deviceEdgesLost
  const edgeLoss = primaryLost + secondaryLost
  if (edgeLoss > 0) {
    warnings.push({
      id: 'edges',
      label: 'RPM edge loss',
      message: edgeLoss.toLocaleString() + ' accepted RPM edge' + (edgeLoss === 1 ? '' : 's') +
        ' lost before USB (' + primaryLost.toLocaleString() + ' primary, ' +
        secondaryLost.toLocaleString() + ' secondary).',
    })
  }

  const [primarySuspected, secondarySuspected] = quality.suspectedSensorPulses
  const totalSuspected = primarySuspected + secondarySuspected
  if (totalSuspected > 0) {
    warnings.push({
      id: 'sensor',
      label: 'Suspected sensor misses',
      message: totalSuspected.toLocaleString() + ' isolated near-double tooth interval' +
        (totalSuspected === 1 ? '' : 's') + ' (' + primarySuspected.toLocaleString() +
        ' primary, ' + secondarySuspected.toLocaleString() +
        ' secondary). These indicate possible missed sensor pulses or missing teeth, not confirmed packet loss.',
    })
  }
  return warnings
}

/**
 * Important faults are shown immediately and stay visible during scrolling. No closed
 * disclosure that only says "1 other warning". The page-scoped sticky region caps its
 * height only when there are many issues, keeping the charts usable.
 */
export function RunWarnings({ warnings }: { warnings: readonly RunWarning[] }) {
  if (warnings.length === 0) return null
  return <section className="warning-banner" role="region" aria-label="Run warnings">
    <div className="warning-heading">
      <TriangleAlert size={17} aria-hidden="true" />
      <strong>Run warnings</strong>
    </div>
    <ul className="warning-issues">
      {warnings.map((warning) => (
        <li key={warning.id}>
          <span className="warning-issue-label">{warning.label}</span>
          <span className="warning-issue-message">{warning.message}</span>
        </li>
      ))}
    </ul>
  </section>
}
