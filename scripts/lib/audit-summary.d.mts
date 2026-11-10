export interface AuditCounts {
  readonly info: number;
  readonly low: number;
  readonly moderate: number;
  readonly high: number;
  readonly critical: number;
  readonly total: number;
}

export function summarizeAudit(report: unknown): AuditCounts;
