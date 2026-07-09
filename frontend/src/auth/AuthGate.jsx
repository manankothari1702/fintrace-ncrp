/**
 * AuthGate (Phase 1 Sub-step D).
 *
 * The app-wide authentication gate. It wraps the shell (AppRoot) from OUTSIDE —
 * see main.jsx — so the off-limits shell module (src/shell) is never modified:
 *   • not signed in            → LoginScreen (nothing else is reachable)
 *   • signed in, must-change   → ChangePasswordScreen (forced)
 *   • signed in, provisioned   → AuthBar (user chip + logout + admin tools)
 *                                followed by the app shell (children)
 */

import { useAuth } from '../context/AuthContext.jsx';
import LoginScreen from './LoginScreen.jsx';
import ChangePasswordScreen from './ChangePasswordScreen.jsx';
import AuthBar from './AuthBar.jsx';

export default function AuthGate({ children }) {
  const { isAuthenticated, mustChangePassword } = useAuth();

  if (!isAuthenticated) return <LoginScreen />;
  if (mustChangePassword) return <ChangePasswordScreen forced />;

  return (
    <>
      <AuthBar />
      {children}
    </>
  );
}
