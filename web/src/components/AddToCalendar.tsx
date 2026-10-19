export interface CalendarLinks { google: string; outlook: string; office365: string; ics: string }

/** "Add to calendar" for customers: Google and Outlook open pre-filled; Apple/other calendars take the .ics file. */
export function AddToCalendar({ links }: { links?: CalendarLinks }) {
  if (!links) return null;
  return (
    <div className="stack">
      <span className="small muted">Add to your calendar</span>
      <div className="row">
        <a className="btn" href={links.google} target="_blank" rel="noopener">Google Calendar</a>
        <a className="btn" href={links.outlook} target="_blank" rel="noopener">Outlook.com</a>
        <a className="btn" href={links.office365} target="_blank" rel="noopener">Outlook (work/school)</a>
        <a className="btn" href={links.ics} download>Apple / other (.ics)</a>
      </div>
    </div>
  );
}
