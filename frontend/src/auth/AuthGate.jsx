/**
 * AuthGate (Phase 1 Sub-step D).
 *
 * The app-wide authentication gate. It wraps the shell (AppRoot) from OUTSIDE —
 * see main.jsx — so the off-limits shell module (src/shell) is never modified:
 *   • not signed in            → LoginScreen (nothing else is reachable)
 *   • signed in, must-change   → ChangePasswordScreen (forced)
 *   • signed in, provisioned   → the app shell (children)
 *
 * The account/profile control (AuthBar) is no longer rendered here as a separate
 * strip. The shell host (main.jsx) passes it into the shell's single top bar as
 * a slot, so the workspace toggle and the profile control share one unified bar.
 */

import { useAuth } from '../context/AuthContext.jsx';
import LoginScreen from './LoginScreen.jsx';
import ChangePasswordScreen from './ChangePasswordScreen.jsx';

export default function AuthGate({ children }) {
  const { isAuthenticated, mustChangePassword } = useAuth();

  if (!isAuthenticated) return <LoginScreen />;
  if (mustChangePassword) return <ChangePasswordScreen forced />;

  return children;
}
