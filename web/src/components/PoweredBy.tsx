/**
 * "Powered by Slotwise" on free-plan businesses' booking pages (and the pages customers manage bookings on).
 * Links to the home page, in a new tab so a customer mid-booking (or inside a website's embedded calendar) doesn't
 * lose their place. The ref tells the home page where the visit came from.
 */
export function PoweredBy({ from }: { from: string }) {
  return (
    <div className="powered-by">
      <a href={`/?ref=powered-by&from=${encodeURIComponent(from)}`} target="_blank" rel="noopener">
        <img className="powered-by-mark" src="/logo.svg" alt="" width={18} height={18} />
        <span>Powered by <b>Slotwise</b>: free online booking for teachers &amp; pros</span>
      </a>
    </div>
  );
}
