/** Return the exact tc arguments and applied delays, separate from the nominal
 * requested RTT. Linux tc requires nonzero latency with a named distribution. */
export function netemProfile({ rttMs, jitterMs, lossPercent }) {
  for (const [name, value] of Object.entries({ rttMs, jitterMs, lossPercent })) {
    if (!Number.isFinite(value) || value < 0 || (name === 'lossPercent' && value > 100)) throw new Error(`Invalid netem ${name}`);
  }
  const zeroRttJitterFloorMs = rttMs === 0 && jitterMs > 0 ? 0.001 : 0;
  const oneWayBaseDelayMs = rttMs / 2 + zeroRttJitterFloorMs;
  const oneWayJitterMs = jitterMs / 2;
  const args = ['qdisc', 'replace', 'dev', 'lo', 'root', 'handle', '1:', 'netem'];
  if (oneWayBaseDelayMs || oneWayJitterMs) {
    args.push('delay', `${oneWayBaseDelayMs}ms`);
    if (oneWayJitterMs) args.push(`${oneWayJitterMs}ms`, 'distribution', 'normal');
  }
  if (lossPercent) args.push('loss', `${lossPercent}%`);
  if (args.at(-1) === 'netem') args.push('delay', '0ms');
  return { args, applied: { oneWayBaseDelayMs, oneWayJitterMs, lossPercent, zeroRttJitterFloorMs } };
}
