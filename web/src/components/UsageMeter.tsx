export interface MeterReading { metric: string; label: string; used: number; included: number; extra: number; limit: number; remaining: number; percent: number }

const tone = (pct: number) => (pct >= 100 ? "var(--bad)" : pct >= 80 ? "var(--warn)" : "var(--ok)");

/** One usage bar: "212 of 300 online bookings", coloured green → amber at 80% → red when used up. */
export function UsageMeter({ m, compact = false }: { m: MeterReading; compact?: boolean }) {
  const pct = Math.min(100, m.percent);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ minWidth: 0 }}>{m.label.charAt(0).toUpperCase() + m.label.slice(1)}</span>
        <span className={compact ? "small" : ""} style={{ whiteSpace: "nowrap" }}><strong>{m.used}</strong> of {m.limit}{m.limit ? ` (${m.percent}%)` : ""}</span>
      </div>
      <div role="progressbar" aria-label={m.label} aria-valuemin={0} aria-valuemax={m.limit} aria-valuenow={m.used}
        style={{ height: compact ? 6 : 10, borderRadius: 999, background: "var(--border)", overflow: "hidden" }}>
        <div style={{ width: `${m.limit ? pct : m.used ? 100 : 0}%`, height: "100%", background: tone(m.percent) }} />
      </div>
      {!compact && (
        <span className="small muted">
          {m.limit === 0 ? "Not included in your plan" : m.percent >= 100 ? "Used up" : `${m.remaining} left`}
          {m.extra ? ` · includes ${m.extra} extra you added this month` : ""}
        </span>
      )}
    </div>
  );
}
