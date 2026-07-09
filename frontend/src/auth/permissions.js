/**
 * Frontend mirror of the backend role→permission map (backend/src/lib/roles.js)
 * — used ONLY to show/hide UI affordances. The backend remains the sole
 * enforcer; this is a UX convenience so users aren't offered actions they'd be
 * 403'd on. Keep in sync with the backend map (the single source of truth).
 */

export const PERMISSIONS = Object.freeze({
  VIEW_CASES: 'view_cases',
  UPLOAD_REPORT: 'upload_report',
  CASE_WORK: 'case_work',
  EXPORT: 'export',
  VIEW_AUDIT: 'view_audit',
  DELETE_REPORT: 'delete_report',
  MANAGE_USERS: 'manage_users',
  MANAGE_BACKUPS: 'manage_backups',
});

export const ROLES = Object.freeze({
  SYSTEM_ADMIN: 'system_admin',
  SHO: 'sho',
  IO: 'io',
  DATA_ENTRY_OPERATOR: 'data_entry_operator',
});

/** Human-readable role names for the UI. */
export const ROLE_LABELS = Object.freeze({
  [ROLES.SYSTEM_ADMIN]: 'System Admin',
  [ROLES.SHO]: 'SHO',
  [ROLES.IO]: 'Investigating Officer',
  [ROLES.DATA_ENTRY_OPERATOR]: 'Data Entry Operator',
});

const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.SYSTEM_ADMIN]: Object.values(PERMISSIONS),
  [ROLES.IO]: [
    PERMISSIONS.VIEW_CASES, PERMISSIONS.UPLOAD_REPORT, PERMISSIONS.CASE_WORK,
    PERMISSIONS.EXPORT, PERMISSIONS.VIEW_AUDIT,
  ],
  [ROLES.SHO]: [PERMISSIONS.VIEW_CASES, PERMISSIONS.EXPORT, PERMISSIONS.VIEW_AUDIT],
  [ROLES.DATA_ENTRY_OPERATOR]: [PERMISSIONS.VIEW_CASES, PERMISSIONS.UPLOAD_REPORT],
});

/**
 * @param {string} role
 * @param {string} permission
 * @returns {boolean}
 */
export function roleHasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role];
  return Array.isArray(perms) && perms.includes(permission);
}

/** @param {string} role @returns {string} display label */
export function roleLabel(role) {
  return ROLE_LABELS[role] || role || 'Unknown';
}
