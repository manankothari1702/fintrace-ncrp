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

module.exports = { ROLES, ALL_ROLES, isValidRole };
