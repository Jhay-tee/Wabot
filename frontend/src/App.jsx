import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";
import { Spinner } from "./components/ui/Spinner.jsx";

const Landing   = lazy(() => import("./pages/Landing.jsx"));
const Login     = lazy(() => import("./pages/Login.jsx"));
const Signup    = lazy(() => import("./pages/Signup.jsx"));
const Verify    = lazy(() => import("./pages/Verify.jsx"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword.jsx"));
const ResetPassword = lazy(() => import("./pages/ResetPassword.jsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const Docs      = lazy(() => import("./pages/Docs.jsx"));
const Admin     = lazy(() => import("./pages/Admin.jsx"));

function Loader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-[var(--text)]">
      <Spinner size="lg" />
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { token } = useAuth();
  const location  = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

function GuestRoute({ children }) {
  const { token } = useAuth();
  if (token) return <Navigate to="/dashboard" replace />;
  return children;
}

/* Admin route — must be logged in. The actual superadmin check happens
   on the server; the page shows an "Access Denied" screen on 403.      */
function AdminRoute({ children }) {
  const { token } = useAuth();
  const location  = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

export default function App() {
  return (
    <Suspense fallback={<Loader />}>
      <Routes>
        <Route path="/"          element={<GuestRoute><Landing /></GuestRoute>} />
        <Route path="/docs"      element={<Docs />} />
        <Route path="/verify"    element={<Verify />} />
        <Route path="/forgot-password" element={<GuestRoute><ForgotPassword /></GuestRoute>} />
        <Route path="/reset-password" element={<GuestRoute><ResetPassword /></GuestRoute>} />
        <Route path="/login"     element={<GuestRoute><Login /></GuestRoute>} />
        <Route path="/signup"    element={<GuestRoute><Signup /></GuestRoute>} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/dashboard/bots/:botId" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/admin"     element={<AdminRoute><Admin /></AdminRoute>} />
        <Route path="*"          element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
