import { Link } from "react-router-dom";
import { DateTime } from "luxon";
import { useApi } from "../hooks";

export function MyBookings() {
  const { data } = useApi<any[]>("/auth/my-bookings");
  return (
    <div className="container">
      <h1>My bookings</h1>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>When</th><th>Business</th><th>Service</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data?.map((b) => (
              <tr key={b.code}>
                <td>{DateTime.fromISO(b.starts_at).toLocaleString(DateTime.DATETIME_MED)}</td>
                <td>{b.business_name}</td><td>{b.service_name}</td><td>{b.status}</td>
                <td><Link to={`/manage/${b.manage_token}`}>Manage</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.length === 0 && <p className="muted">No bookings yet.</p>}
      </div>
    </div>
  );
}
