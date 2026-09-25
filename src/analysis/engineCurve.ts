import type { EngineTorquePoint } from './types'

const FTLB_TO_NM = 1.355817948
const RAD_PER_SEC_PER_RPM = (2 * Math.PI) / 60

export const defaultEngineTorqueCurve: ReadonlyArray<EngineTorquePoint> = [
  { rpm: 1000, torque: 0 },
  { rpm: 1800, torque: 18 },
  { rpm: 2400, torque: 18.5 },
  { rpm: 2600, torque: 18.1 },
  { rpm: 2800, torque: 17.4 },
  { rpm: 3000, torque: 16.6 },
  { rpm: 3200, torque: 15.4 },
  { rpm: 3400, torque: 14.5 },
  { rpm: 3600, torque: 13.5 },
  { rpm: 3950, torque: 10 },
  { rpm: 4000, torque: 0 },
]

export function interpolateEngineTorqueFtLb(rpm: number, curve: ReadonlyArray<EngineTorquePoint>): number {
  if (!Number.isFinite(rpm) || rpm <= 0 || curve.length === 0) return 0
  if (rpm <= curve[0].rpm) return curve[0].torque
  if (rpm >= curve[curve.length - 1].rpm) return curve[curve.length - 1].torque

  let low = 0
  let high = curve.length - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (curve[mid].rpm <= rpm) low = mid
    else high = mid
  }

  const left = curve[low]
  const right = curve[high]
  const span = right.rpm - left.rpm
  if (span <= 0) return left.torque
  const fraction = (rpm - left.rpm) / span
  return left.torque + fraction * (right.torque - left.torque)
}

export function enginePowerKwFromRpm(rpm: number, curve: ReadonlyArray<EngineTorquePoint>): number {
  const torqueNm = interpolateEngineTorqueFtLb(rpm, curve) * FTLB_TO_NM
  const omega = rpm * RAD_PER_SEC_PER_RPM
  return Math.max(0, torqueNm * omega / 1000)
}
