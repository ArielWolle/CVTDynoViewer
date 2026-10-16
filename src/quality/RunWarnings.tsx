import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, TriangleAlert } from 'lucide-react'
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
 * A minimized warning must say something useful, not merely "1 other warning".
 * The first single issue is shown verbatim; multiple issues expose their actual categories.
 */
export function compactWarningSummary(warnings: readonly RunWarning[]): string {
  if (warnings.length === 0) return ''
  if (warnings.length === 1) return warnings[0].label + ': ' + warnings[0].message
  const visible = warnings.slice(0, 3).map((warning) => warning.label).join(' · ')
  return warnings.length > 3 ? visible + ' · +' + (warnings.length - 3) + ' more' : visible
}

/** A new category or a changed count/message should be noticeable even while minimized. */
export function hasNewWarningInformation(
  previous: readonly RunWarning[],
  current: readonly RunWarning[],
): boolean {
  const previousById = new Map(previous.map((warning) => [warning.id, warning.message]))
  return current.some((warning) => previousById.get(warning.id) !== warning.message)
}

/**
 * Expanded by default, then user-controlled. Minimize never removes the warning indicator.
 * New issues update its count and "Updated" hint but do not forcibly reopen a panel
 * that the operator has deliberately minimized while watching live dyno measurements.
 */
export function RunWarnings({ warnings }: { warnings: readonly RunWarning[] }) {
  const [expanded, setExpanded] = useState(true)
  const [hasUpdates, setHasUpdates] = useState(false)
  const previousWarningsRef = useRef<readonly RunWarning[]>([])
  const detailsId = useId()

  useEffect(() => {
    const previous = previousWarningsRef.current
    if (warnings.length === 0) {
      // A cleared session starts with the next warning fully visible again.
      previousWarningsRef.current = []
      setExpanded(true)
      setHasUpdates(false)
      return
    }
    if (!expanded && hasNewWarningInformation(previous, warnings)) setHasUpdates(true)
    previousWarningsRef.current = warnings
  }, [warnings, expanded])

  if (warnings.length === 0) return null

  const toggle = () => {
    setExpanded((currentlyExpanded) => !currentlyExpanded)
    setHasUpdates(false)
  }

  return <section className={'warning-banner ' + (expanded ? 'is-expanded' : 'is-collapsed')}
    role="region" aria-label="Run warnings">
    <button type="button" className="warning-toggle" onClick={toggle}
      aria-expanded={expanded} aria-controls={detailsId}
      aria-label={expanded ? 'Minimize run warnings' : 'Show all run warnings'}>
      <TriangleAlert size={17} aria-hidden="true" />
      <strong>Run warnings</strong>
      <span className="warning-count">
        {warnings.length} {warnings.length === 1 ? 'issue' : 'issues'}
      </span>
      {!expanded && <span className="warning-compact-summary">{compactWarningSummary(warnings)}</span>}
      {!expanded && hasUpdates && <span className="warning-updated">Updated</span>}
      <span className="warning-toggle-label">{expanded ? 'Minimize' : 'Show details'}</span>
      {expanded
        ? <ChevronUp size={16} aria-hidden="true" />
        : <ChevronDown size={16} aria-hidden="true" />}
    </button>
    <ul id={detailsId} className="warning-issues" hidden={!expanded}>
      {warnings.map((warning) => (
        <li key={warning.id}>
          <span className="warning-issue-label">{warning.label}</span>
          <span className="warning-issue-message">{warning.message}</span>
        </li>
      ))}
    </ul>
  </section>
}
