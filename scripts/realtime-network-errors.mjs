/** Continuous input expiry at 250ms is silent neutralization. Only a detected
 * five-second network absence can legitimately end controller authority. */
export function unexpectedNetworkErrors(errors, lossPercent = 0) {
  const afterAbsence = new Set(['AUTH_EXPIRED', 'STALE_CONTROLLER', 'CONTROL_REQUIRED']);
  return errors.filter(error => !(lossPercent > 0 && Number.isFinite(error.silenceMs) && error.silenceMs >= 5000 && afterAbsence.has(error.code)));
}
