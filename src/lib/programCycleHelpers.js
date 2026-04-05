/**
 * Program Cycle Helper Functions
 *
 * Provides utilities for tracking client program cycles.
 * Cycles are a parallel tracking/history layer alongside programs.
 *
 * Firestore location: user/{userId}/programCycles/{cycleId}
 *
 * Schema version 1 - Initial cycle tracking model.
 */

import { db } from './firebase.js';
import { collection, doc, addDoc, getDoc, getDocs, updateDoc, query, where, orderBy, serverTimestamp, Timestamp } from 'firebase/firestore';

export const CYCLE_SCHEMA_VERSION = 1;

/**
 * Valid cycle status values.
 *
 * - active: Cycle is currently in progress
 * - completed: Cycle finished normally (all weeks elapsed, user completed)
 * - expired: Cycle window elapsed without completion
 * - removed: Cycle was manually removed/cancelled
 */
export const CYCLE_STATUSES = ['active', 'completed', 'expired', 'removed'];

/**
 * Validate that a status value is valid.
 *
 * @param {string} status - The status to validate
 * @returns {boolean} True if valid
 */
export function isValidCycleStatus(status) {
  return CYCLE_STATUSES.includes(status);
}

/**
 * Normalize a cycle status value.
 * Returns the status if valid, or 'active' as default.
 *
 * @param {string|null|undefined} status - The status to normalize
 * @returns {string} A valid status
 */
export function normalizeCycleStatus(status) {
  if (status && isValidCycleStatus(status)) {
    return status;
  }
  return 'active';
}

/**
 * Compute the cycle end date from start date and duration.
 *
 * @param {Date|Timestamp} startedAt - The cycle start date
 * @param {number} durationWeeks - Duration in weeks
 * @returns {Date} The computed end date
 */
export function computeCycleEndsAt(startedAt, durationWeeks) {
  // Convert Firestore Timestamp to Date if needed
  const startDate = startedAt?.toDate ? startedAt.toDate() : new Date(startedAt);

  // Add durationWeeks * 7 days
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + (durationWeeks * 7));

  return endDate;
}

/**
 * Build a new cycle record object from input values.
 *
 * This creates a plain object ready for Firestore insertion.
 * The createdAt field will use serverTimestamp() when saved.
 *
 * @param {Object} params
 * @param {string} params.userId - The client user ID
 * @param {string} params.programId - The program ID
 * @param {string} params.programNameSnapshot - Program name at time of assignment
 * @param {string} params.assignedByUserId - The admin/coach who assigned this
 * @param {Date|Timestamp} params.startedAt - When the cycle starts
 * @param {number} params.durationWeeks - Duration in weeks
 * @param {string} [params.status='active'] - Initial status
 * @returns {Object} The cycle record object
 */
export function buildCycleRecord({
  userId,
  programId,
  programNameSnapshot,
  assignedByUserId,
  startedAt,
  durationWeeks,
  status = 'active'
}) {
  // Convert startedAt to Timestamp if it's a Date
  const startTimestamp = startedAt instanceof Date
    ? Timestamp.fromDate(startedAt)
    : startedAt;

  // Compute endsAt
  const endsAtDate = computeCycleEndsAt(startedAt, durationWeeks);
  const endsAtTimestamp = Timestamp.fromDate(endsAtDate);

  return {
    // Core identifiers
    userId,
    programId,
    programNameSnapshot,
    assignedByUserId,

    // Timing
    startedAt: startTimestamp,
    durationWeeks,
    endsAt: endsAtTimestamp,

    // Status tracking
    status: normalizeCycleStatus(status),
    closedAt: null, // Set when status changes to completed/expired/removed

    // Metadata
    schemaVersion: CYCLE_SCHEMA_VERSION,
    createdAt: serverTimestamp()
  };
}

// =============================================================================
// Firestore Collection Helpers
// =============================================================================

/**
 * Get the Firestore collection reference for a user's program cycles.
 *
 * Path: user/{userId}/programCycles
 *
 * @param {string} userId - The user ID
 * @returns {CollectionReference} The collection reference
 */
export function getProgramCyclesCollection(userId) {
  return collection(db, 'user', userId, 'programCycles');
}

/**
 * Get the Firestore document reference for a specific cycle.
 *
 * Path: user/{userId}/programCycles/{cycleId}
 *
 * @param {string} userId - The user ID
 * @param {string} cycleId - The cycle document ID
 * @returns {DocumentReference} The document reference
 */
export function getProgramCycleDoc(userId, cycleId) {
  return doc(db, 'user', userId, 'programCycles', cycleId);
}

/**
 * Create a new program cycle record.
 *
 * @param {Object} cycleData - The cycle record data (from buildCycleRecord)
 * @returns {Promise<string>} The created document ID
 */
export async function createProgramCycle(cycleData) {
  const userId = cycleData.userId;
  if (!userId) {
    throw new Error('userId is required to create a program cycle');
  }

  const colRef = getProgramCyclesCollection(userId);
  const docRef = await addDoc(colRef, cycleData);
  return docRef.id;
}

/**
 * Get a specific program cycle by ID.
 *
 * @param {string} userId - The user ID
 * @param {string} cycleId - The cycle document ID
 * @returns {Promise<Object|null>} The cycle data with id, or null if not found
 */
export async function getProgramCycle(userId, cycleId) {
  const docRef = getProgramCycleDoc(userId, cycleId);
  const snap = await getDoc(docRef);

  if (!snap.exists()) {
    return null;
  }

  return {
    id: snap.id,
    ...snap.data()
  };
}

/**
 * List all program cycles for a user.
 *
 * @param {string} userId - The user ID
 * @param {Object} [options] - Query options
 * @param {string} [options.status] - Filter by status
 * @param {string} [options.programId] - Filter by program ID
 * @returns {Promise<Array>} Array of cycle records with id
 */
export async function listProgramCycles(userId, options = {}) {
  const colRef = getProgramCyclesCollection(userId);

  let q = query(colRef, orderBy('createdAt', 'desc'));

  // Note: Firestore requires composite indexes for multiple where clauses.
  // For now, we'll filter in memory if needed.
  // In production, add indexes as query patterns emerge.

  const snap = await getDocs(q);
  let cycles = snap.docs.map(d => ({
    id: d.id,
    ...d.data()
  }));

  // Apply in-memory filters if provided
  if (options.status) {
    cycles = cycles.filter(c => c.status === options.status);
  }
  if (options.programId) {
    cycles = cycles.filter(c => c.programId === options.programId);
  }

  return cycles;
}

/**
 * List active program cycles for a user.
 *
 * @param {string} userId - The user ID
 * @returns {Promise<Array>} Array of active cycle records with id
 */
export async function listActiveProgramCycles(userId) {
  return listProgramCycles(userId, { status: 'active' });
}

/**
 * Update a program cycle's status.
 *
 * @param {string} userId - The user ID
 * @param {string} cycleId - The cycle document ID
 * @param {string} newStatus - The new status
 * @returns {Promise<void>}
 */
export async function updateCycleStatus(userId, cycleId, newStatus) {
  if (!isValidCycleStatus(newStatus)) {
    throw new Error(`Invalid cycle status: ${newStatus}`);
  }

  const docRef = getProgramCycleDoc(userId, cycleId);
  const updateData = {
    status: newStatus
  };

  // Set closedAt when moving to a terminal status
  if (newStatus === 'completed' || newStatus === 'expired' || newStatus === 'removed') {
    updateData.closedAt = serverTimestamp();
  }

  await updateDoc(docRef, updateData);
}

/**
 * Check if a cycle is currently within its active window.
 *
 * @param {Object} cycle - The cycle record
 * @returns {boolean} True if current time is between startedAt and endsAt
 */
export function isCycleInWindow(cycle) {
  const now = new Date();

  const startDate = cycle.startedAt?.toDate
    ? cycle.startedAt.toDate()
    : new Date(cycle.startedAt);

  const endDate = cycle.endsAt?.toDate
    ? cycle.endsAt.toDate()
    : new Date(cycle.endsAt);

  return now >= startDate && now <= endDate;
}

/**
 * Check if a cycle has expired (past its end date but still marked active).
 *
 * @param {Object} cycle - The cycle record
 * @returns {boolean} True if cycle is past endsAt but still active
 */
export function isCycleExpired(cycle) {
  if (cycle.status !== 'active') {
    return false;
  }

  const now = new Date();
  const endDate = cycle.endsAt?.toDate
    ? cycle.endsAt.toDate()
    : new Date(cycle.endsAt);

  return now > endDate;
}

// =============================================================================
// TEMPORARY DEV-ONLY HELPER - Remove before production deployment
// =============================================================================

/**
 * DEV ONLY: Create a test program cycle for manual validation.
 *
 * Usage from browser console:
 *   window.__devCreateTestCycle({
 *     userId: 'abc123',
 *     programId: 'prog456',
 *     programNameSnapshot: 'Test Program',
 *     assignedByUserId: 'admin789',
 *     startedAt: new Date(),
 *     durationWeeks: 4,
 *     status: 'active'
 *   })
 *
 * @param {Object} params - Cycle parameters
 * @returns {Promise<Object>} Result with cycleId and path
 */
async function devCreateTestCycle(params) {
  console.log('[DEV] Creating test program cycle...');

  // Validate required fields
  const required = ['userId', 'programId', 'programNameSnapshot', 'assignedByUserId', 'startedAt', 'durationWeeks'];
  const missing = required.filter(field => params[field] === undefined || params[field] === null);

  if (missing.length > 0) {
    const error = `Missing required fields: ${missing.join(', ')}`;
    console.error('[DEV] ' + error);
    throw new Error(error);
  }

  // Validate status if provided
  const status = params.status || 'active';
  if (!isValidCycleStatus(status)) {
    const error = `Invalid status "${status}". Must be one of: ${CYCLE_STATUSES.join(', ')}`;
    console.error('[DEV] ' + error);
    throw new Error(error);
  }

  // Validate durationWeeks is a positive number
  if (typeof params.durationWeeks !== 'number' || params.durationWeeks <= 0) {
    const error = 'durationWeeks must be a positive number';
    console.error('[DEV] ' + error);
    throw new Error(error);
  }

  // Build the cycle record using the canonical helper
  const cycleData = buildCycleRecord({
    userId: params.userId,
    programId: params.programId,
    programNameSnapshot: params.programNameSnapshot,
    assignedByUserId: params.assignedByUserId,
    startedAt: params.startedAt,
    durationWeeks: params.durationWeeks,
    status: status
  });

  console.log('[DEV] Built cycle record:', cycleData);

  // Create the cycle using the canonical Firestore helper
  const cycleId = await createProgramCycle(cycleData);
  const path = `user/${params.userId}/programCycles/${cycleId}`;

  console.log('[DEV] Successfully created cycle!');
  console.log('[DEV] Cycle ID:', cycleId);
  console.log('[DEV] Firestore path:', path);

  return {
    success: true,
    cycleId,
    path,
    cycleData
  };
}

// Expose on window in dev mode only
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  window.__devCreateTestCycle = devCreateTestCycle;
  console.log('[DEV] Program cycle test helper available: window.__devCreateTestCycle({...})');
}
