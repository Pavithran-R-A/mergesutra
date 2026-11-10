export function summarizeAudit(report) {
  const counts = report?.metadata?.vulnerabilities;
  if (!counts || !Number.isSafeInteger(counts.total)) {
    throw new Error('npm audit returned no valid vulnerability summary.');
  }
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    if (!Number.isSafeInteger(counts[severity]) || counts[severity] < 0) {
      throw new Error(`npm audit returned an invalid ${severity} count.`);
    }
  }
  const severityTotal = counts.info + counts.low + counts.moderate + counts.high + counts.critical;
  if (severityTotal !== counts.total) {
    throw new Error('npm audit returned inconsistent vulnerability totals.');
  }
  if (counts.high > 0 || counts.critical > 0) {
    throw new Error(`npm audit found ${counts.high} high and ${counts.critical} critical issues.`);
  }
  return Object.freeze({ ...counts });
}
