import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks";

export function Home() {
  const [q, setQ] = useState("");
  const { data } = useApi<any[]>(`/public/businesses?q=${encodeURIComponent(q)}`);
  return (
    <div className="container">
      <div className="card" style={{ padding: 32 }}>
        <h1>Book lessons, appointments and classes</h1>
        <p className="muted">Find a provider and pick a time that works — or just chat with their AI assistant.</p>
        <input placeholder="Search by name or category (e.g. piano, haircut, tutoring)" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="grid">
        {data?.map((b) => (
          <Link key={b.slug} to={`/b/${b.slug}`} className="card" style={{ color: "inherit", textDecoration: "none" }}>
            <h3>{b.name}</h3>
            <div className="badge">{b.category}</div>
            <p className="muted small">{b.description}</p>
          </Link>
        ))}
        {data?.length === 0 && <p className="muted">No businesses found.</p>}
      </div>
    </div>
  );
}
