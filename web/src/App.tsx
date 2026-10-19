import type { ReactElement } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { Home } from "./pages/Home";
import { Account, AuthCallback, ForgotPassword, Login, Register, ResetPassword, StartBusiness } from "./pages/AuthPages";
import { BookingPage } from "./pages/BookingPage";
import { ManageBooking } from "./pages/ManageBooking";
import { AdminHome, AdminLayout } from "./pages/admin/AdminLayout";
import { SuperAdmin } from "./pages/super/SuperAdmin";
import { MyBookings } from "./pages/MyBookings";

function TopBar() {
  const { session, logout } = useAuth();
  const role = session?.user.role;
  return (
    <header className="topbar">
      <div className="container">
        <Link to="/" className="brand">Slotwise</Link>
        <div className="spacer" />
        {session ? (
          <>
            {role !== "customer" && <Link to="/admin">Admin</Link>}
            {role === "superadmin" && <Link to="/super">Super admin</Link>}
            <Link to="/me">My bookings</Link>
            <Link to="/account">Account</Link>
            <button className="link" onClick={logout}>Sign out</button>
          </>
        ) : (
          <>
            <Link to="/login">Sign in</Link>
            <Link to="/register?provider=1" className="btn primary">List your business</Link>
          </>
        )}
      </div>
    </header>
  );
}

function RequireRole({ roles, children }: { roles: string[]; children: ReactElement }) {
  const { session, loading } = useAuth();
  if (loading) return <div className="container muted">Loading…</div>;
  if (!session) return <Navigate to="/login" replace />;
  if (!roles.includes(session.user.role)) return <div className="container">You don't have access to this page.</div>;
  return children;
}

export function App() {
  return (
    <>
      <TopBar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/start-business" element={<RequireRole roles={["customer", "admin", "superadmin"]}><StartBusiness /></RequireRole>} />
        <Route path="/account" element={<RequireRole roles={["customer", "admin", "superadmin"]}><Account /></RequireRole>} />
        <Route path="/b/:slug" element={<BookingPage />} />
        <Route path="/manage/:token" element={<ManageBooking />} />
        <Route path="/me" element={<RequireRole roles={["customer", "admin", "superadmin"]}><MyBookings /></RequireRole>} />
        <Route path="/admin" element={<RequireRole roles={["admin", "superadmin"]}><AdminHome /></RequireRole>} />
        <Route path="/admin/:bid/*" element={<RequireRole roles={["admin", "superadmin"]}><AdminLayout /></RequireRole>} />
        <Route path="/super/*" element={<RequireRole roles={["superadmin"]}><SuperAdmin /></RequireRole>} />
        <Route path="*" element={<div className="container">Page not found.</div>} />
      </Routes>
    </>
  );
}
