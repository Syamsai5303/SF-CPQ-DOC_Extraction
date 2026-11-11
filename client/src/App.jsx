import { Navigate, Route, Routes } from 'react-router-dom';
import { GuestOnly, RequireAuth } from './auth.jsx';
import { OrgProvider } from './org.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Connections from './pages/Connections.jsx';

/** Authenticated area: guarded and wrapped in the multi-org context. */
const Private = ({ children }) => (
  <RequireAuth>
    <OrgProvider>{children}</OrgProvider>
  </RequireAuth>
);

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
      <Route path="/register" element={<GuestOnly><Register /></GuestOnly>} />
      <Route path="/forgot-password" element={<GuestOnly><ForgotPassword /></GuestOnly>} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/dashboard" element={<Private><Dashboard /></Private>} />
      <Route path="/connections" element={<Private><Connections mode="list" /></Private>} />
      <Route path="/connections/new" element={<Private><Connections mode="new" /></Private>} />
      <Route path="/connections/:id/edit" element={<Private><Connections mode="edit" /></Private>} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
