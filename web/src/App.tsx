import type { ReactElement } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import { Home } from "./pages/Home";
import { Account, AuthCallback, ForgotPassword, Login, Register, ResetPassword, StartBusiness } from "./pages/AuthPages";
import { BookingPage } from "./pages/BookingPage";
import { ManageBooking } from "./pages/ManageBooking";
import { AdminHome, AdminLayout } from "./pages/admin/AdminLayout";
import { SuperAdmin } from "./pages/super/SuperAdmin";
import { MyBookings } from "./pages/MyBookings";
import { GuidePage } from "./pages/GuidePage";
import { PrivacyPage, TermsPage } from "./pages/LegalPages";

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
            {role === "admin" && <Link to="/admin">Admin</Link>}
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

/**
 * The super admin works on businesses inside Super admin → Businesses. Links that point at /admin/...
 * (emails, Stripe and calendar redirects) are forwarded there, keeping the tab and query string.
 */
function SuperRedirect({ children }: { children: ReactElement }) {
  const { session } = useAuth();
  const { pathname, search } = useLocation();
  if (session?.user.role !== "superadmin") return children;
  return <Navigate to={pathname.replace(/^\/admin/, "/super/businesses") + search} replace />;
}

export function App() {
  return (
    <>
      {!useLocation().pathname.startsWith("/embed/") && <TopBar />}
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
        <Route path="/embed/:slug" element={<BookingPage embed />} />
        <Route path="/manage/:token" element={<ManageBooking />} />
        <Route path="/guide" element={<GuidePage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/me" element={<RequireRole roles={["customer", "admin", "superadmin"]}><MyBookings /></RequireRole>} />
        <Route path="/admin" element={<RequireRole roles={["admin", "superadmin"]}><SuperRedirect><AdminHome /></SuperRedirect></RequireRole>} />
        <Route path="/admin/:bid/*" element={<RequireRole roles={["admin", "superadmin"]}><SuperRedirect><AdminLayout /></SuperRedirect></RequireRole>} />
        <Route path="/super/*" element={<RequireRole roles={["superadmin"]}><SuperAdmin /></RequireRole>} />
        <Route path="*" element={<div className="container">Page not found.</div>} />
      </Routes>
    </>
  );
}
