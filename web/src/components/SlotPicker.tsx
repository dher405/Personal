import { useMemo, useState } from "react";
import { DateTime } from "luxon";
import { useApi } from "../hooks";

export interface Slot { start: string; end: string; staffId: string; staffName: string }

/**
 * Week strip + time grid. `slotsPath` builds the API path for a given day so the
 * same picker serves the public page, the reschedule screen, and the admin.
 */
export function SlotPicker({ timezone, slotsPath, onPick, selected, showStaff, initialDay }: {
  timezone: string;
  /** ISO date to open on (e.g. the booking being moved); defaults to today. */
  initialDay?: string;
  slotsPath: (day: string) => string;
  onPick: (slot: Slot) => void;
  selected?: Slot | null;
  showStaff?: boolean;
}) {
  const today = DateTime.now().setZone(timezone).startOf("day");
  const start = initialDay ? DateTime.max(DateTime.fromISO(initialDay, { zone: timezone }), today) : today;
  const [weekStart, setWeekStart] = useState(start);
  const [day, setDay] = useState(start.toISODate()!);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => weekStart.plus({ days: i })), [weekStart]);
  const { data: slots, loading, error } = useApi<Slot[]>(slotsPath(day));

  return (
    <div className="stack">
      <div className="row">
        <button disabled={weekStart <= today} onClick={() => setWeekStart(weekStart.minus({ days: 7 }))}>‹</button>
        <strong>{weekStart.toFormat("LLLL yyyy")}</strong>
        <button onClick={() => setWeekStart(weekStart.plus({ days: 7 }))}>›</button>
        <span className="muted small">Times shown in {timezone.replace("_", " ")}</span>
      </div>
      <div className="days">
        {days.map((d) => (
          <button key={d.toISODate()} className={d.toISODate() === day ? "primary" : ""} onClick={() => setDay(d.toISODate()!)}>
            <span className="small">{d.toFormat("ccc")}</span>
            <strong>{d.toFormat("d")}</strong>
          </button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      {loading && !slots ? <div className="muted">Loading times…</div> : slots?.length === 0 ? (
        <div className="muted">No open times this day. Try another date.</div>
      ) : (
        <div className="slots">
          {slots?.map((s) => (
            <button
              key={s.start + s.staffId}
              className={selected?.start === s.start && selected?.staffId === s.staffId ? "primary" : ""}
              onClick={() => onPick(s)}
              title={s.staffName}
              style={{ flexDirection: "column", justifyContent: "center" }}
            >
              {DateTime.fromISO(s.start).setZone(timezone).toFormat("h:mm a")}
              {showStaff && <span className="small">{s.staffName}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
