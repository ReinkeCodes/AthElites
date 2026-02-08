/**
 * Centralized workout draft management
 * Ensures exactly ONE active draft exists per user+device at any time.
 */

import { browser } from '$app/environment';

const DRAFT_VERSION = 1;

/**
 * Get the localStorage key for the user's draft
 */
export function getDraftKey(userId) {
  return userId ? `activeWorkoutDraft:${userId}` : null;
}

/**
 * Read the current draft from localStorage
 * @returns {object|null} The draft object or null if none exists
 */
export function getDraft(userId) {
  if (!browser || !userId) return null;
  const key = getDraftKey(userId);
  if (!key) return null;

  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    return draft;
  } catch (e) {
    console.warn('Corrupt workout draft, removing:', e);
    localStorage.removeItem(key);
    return null;
  }
}

/**
 * Check if a draft matches a specific workout identity
 */
export function draftMatchesWorkout(draft, programId, dayIndex) {
  if (!draft) return false;
  return draft.programId === programId && draft.dayIndex === dayIndex;
}

/**
 * Write a draft to localStorage (internal - does NOT enforce single-draft rule)
 * Use setDraftSafe for enforced writes from workout page
 */
export function setDraft(userId, draftData) {
  if (!browser || !userId) return false;
  const key = getDraftKey(userId);
  if (!key) return false;

  const draft = {
    ...draftData,
    version: DRAFT_VERSION,
    userId,
    updatedAtISO: new Date().toISOString()
  };

  try {
    localStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch (e) {
    console.warn('Could not save workout draft:', e);
    return false;
  }
}

/**
 * Clear the draft from localStorage
 */
export function clearDraft(userId) {
  if (!browser || !userId) return;
  const key = getDraftKey(userId);
  if (key) {
    localStorage.removeItem(key);
  }
}

/**
 * Get a human-readable label for the draft
 */
export function getDraftLabel(draft) {
  if (!draft) return '';
  const programName = draft.programName || 'Workout';
  const dayName = draft.dayName || `Day ${(draft.dayIndex || 0) + 1}`;
  return `${programName} — ${dayName}`;
}

/**
 * Check if attempting to write a draft for a different workout than existing
 * Returns: { conflict: boolean, existingDraft: object|null }
 */
export function checkDraftConflict(userId, programId, dayIndex) {
  const existingDraft = getDraft(userId);
  if (!existingDraft) {
    return { conflict: false, existingDraft: null };
  }

  const matches = draftMatchesWorkout(existingDraft, programId, dayIndex);
  if (matches) {
    return { conflict: false, existingDraft };
  }

  // Different workout draft exists
  if (import.meta.env.DEV) {
    console.warn('[Draft] Blocked write: existing draft for different workout', {
      existing: { programId: existingDraft.programId, dayIndex: existingDraft.dayIndex },
      attempted: { programId, dayIndex }
    });
  }

  return { conflict: true, existingDraft };
}
