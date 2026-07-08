'use strict';

/**
 * FinTrace NCRP — roles (Phase 1).
 *
 * The four tender roles. This is the single source of truth for the role set;
 * the users table stores `role` as free text and validity is checked against
 * ROLES here (kept in code, not a DB CHECK, so the set stays editable in one
 * place). The role→PERMISSION map is added alongside in Sub-step C.
 *
 * @module backend/src/lib/roles
 */

const ROLES = Object.freeze({
  SYSTEM_ADMIN: 'system_admin',
  SHO: 'sho',
  IO: 'io',
  DATA_ENTRY_OPERATOR: 'data_entry_operator',
});

/** All valid role identifiers. */
const ALL_ROLES = Object.freeze(Object.values(ROLES));

/**
 * @param {unknown} role
 * @returns {boolean}
 */
function isValidRole(role) {
  return typeof role === 'string' && ALL_ROLES.includes(role);
}

// ─── Permissions (Sub-step C) ────────────────────────────────────────
//
// Capability-based RBAC. Each protected route declares ONE required
// PERMISSION; roles are granted a set of permissions below. This map is the
// SINGLE place to tune who-can-do-what — routes never name roles directly, so
// re-tuning access is a one-edit change here.

const PERMISSIONS = Object.freeze({
  VIEW_CASES: 'view_cases',       // read reports / analysis / drill-downs
  UPLOAD_REPORT: 'upload_report', // ingest an NCRP file → analysis
  CASE_WORK: 'case_work',         // lien updates, email/freeze status changes
  EXPORT: 'export',               // PDF / Excel / entity exports
  VIEW_AUDIT: 'view_audit',       // read a case's audit trail
  DELETE_REPORT: 'delete_report', // destructive — remove a report
  MANAGE_USERS: 'manage_users',   // create/edit/deactivate users, reset pw
});

/**
 * Role → granted permissions. STARTING model per the tender brief; expected to
 * be tuned. Edit ONLY this map to change access.
 *   • System Admin — everything, incl. user management + destructive ops.
 *   • IO (Investigating Officer) — full case work: upload, analyse, lien,
 *     emails, export, and read the audit trail of the case.
 *   • SHO — read + oversight: view everything, export, read audit; no ingest,
 *     no case mutations, no delete.
 *   • Data Entry Operator — upload + view; no export, no case mutations,
 *     no delete, no audit.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.SYSTEM_ADMIN]: Object.freeze(Object.values(PERMISSIONS)),
  [ROLES.IO]: Object.freeze([
    PERMISSIONS.VIEW_CASES, PERMISSIONS.UPLOAD_REPORT, PERMISSIONS.CASE_WORK,
    PERMISSIONS.EXPORT, PERMISSIONS.VIEW_AUDIT,
  ]),
  [ROLES.SHO]: Object.freeze([
    PERMISSIONS.VIEW_CASES, PERMISSIONS.EXPORT, PERMISSIONS.VIEW_AUDIT,
  ]),
  [ROLES.DATA_ENTRY_OPERATOR]: Object.freeze([
    PERMISSIONS.VIEW_CASES, PERMISSIONS.UPLOAD_REPORT,
  ]),
});

/**
 * @param {string} role
 * @param {string} permission
 * @returns {boolean}
 */
function roleHasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role];
  return Array.isArray(perms) && perms.includes(permission);
}

module.exports = {
  ROLES,
  ALL_ROLES,
  isValidRole,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  roleHasPermission,
};
