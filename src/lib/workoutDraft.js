/**
 * Centralized workout draft management
 * Ensures exactly ONE active draft exists per user+device at any time.
 */

import { browser } from '$app/environment';

const DRAFT_VERSION = 1;
const STALE_DRAFT_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Check if a dayIndex is valid (non-negative integer)
 * @returns {boolean} true only if Number.isInteger(x) && x >= 0
 */
export function isValidDayIndex(x) {
  return Number.isInteger(x) && x >= 0;
}

/**
 * Get the localStorage key for the user's draft
 */
export function getDraftKey(userId) {
  return userId ? `activeWorkoutDraft:${userId}` : null;
}

/**
 * Check if a draft is stale (older than STALE_DRAFT_DAYS)
 * @returns {boolean} true if stale, false otherwise (including if updatedAt is missing/invalid)
 */
export function isDraftStale(draft) {
  if (!draft || typeof draft.updatedAt !== 'number') return false;
  const ageMs = Date.now() - draft.updatedAt;
  return ageMs > STALE_DRAFT_DAYS * MS_PER_DAY;
}

/**
 * Get human-readable age text for a draft
 * @returns {string} "today", "yesterday", or "X days ago"
 */
export function getDraftAgeText(draft) {
  if (!draft || typeof draft.updatedAt !== 'number') return '';
  const ageMs = Date.now() - draft.updatedAt;
  const ageDays = Math.floor(ageMs / MS_PER_DAY);
  if (ageDays === 0) return 'today';
  if (ageDays === 1) return 'yesterday';
  return `${ageDays} days ago`;
}

/**
 * Extract timestamp from draft for comparison (ms since epoch)
 * Falls back through: updatedAt -> updatedAtISO -> workoutStartTimeISO -> 0
 */
function extractTimestamp(draft) {
  if (typeof draft.updatedAt === 'number') return draft.updatedAt;
  if (draft.updatedAtISO) {
    const t = new Date(draft.updatedAtISO).getTime();
    if (!isNaN(t)) return t;
  }
  if (draft.workoutStartTimeISO) {
    const t = new Date(draft.workoutStartTimeISO).getTime();
    if (!isNaN(t)) return t;
  }
  return 0;
}

/**
 * Collect all localStorage keys that are draft keys for the given userId
 * Uses PREFIX matching: any key starting with `activeWorkoutDraft:${userId}`
 * This catches the canonical key AND any suffix variants (e.g., :dup, :old)
 */
function collectDraftKeysForUser(userId) {
  const canonicalPrefix = `activeWorkoutDraft:${userId}`;
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(canonicalPrefix)) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Read the current draft from localStorage
 * Performs canonicalization: ensures exactly ONE draft per user.
 * - Scans for all draft keys matching this user
 * - Selects most recently updated if multiple exist
 * - Cleans up duplicate/legacy keys
 * - Normalizes timestamps
 * @returns {object|null} The canonical draft object or null if none exists
 */
export function getDraft(userId) {
  if (!browser || !userId) return null;
  const canonicalKey = getDraftKey(userId);
  if (!canonicalKey) return null;

  // Collect all draft keys for this user (prefix-based)
  const allKeys = collectDraftKeysForUser(userId);
  if (allKeys.length === 0) return null;

  // Parse all drafts and track their source keys
  const drafts = [];
  for (const key of allKeys) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const draft = JSON.parse(raw);
        drafts.push({ key, draft });
      }
    } catch (_) {
      // Corrupt entry - remove immediately
      localStorage.removeItem(key);
    }
  }

  if (drafts.length === 0) return null;

  // Select canonical draft: most recently updated
  let canonical = drafts[0];
  for (const entry of drafts) {
    if (extractTimestamp(entry.draft) > extractTimestamp(canonical.draft)) {
      canonical = entry;
    }
  }

  // Clean up non-canonical keys for this user
  const removedKeys = [];
  for (const entry of drafts) {
    if (entry.key !== canonicalKey) {
      localStorage.removeItem(entry.key);
      removedKeys.push(entry.key);
    }
  }

  // DEV-only logging to verify canonicalization
  if (import.meta.env.DEV && allKeys.length > 1) {
    console.log('[Draft Canonicalization]', {
      userId,
      candidateKeys: allKeys,
      removedKeys,
      canonicalKey,
      selectedFrom: canonical.key
    });
  }

  const draft = canonical.draft;
  const sourceKey = canonical.key;

  // Timestamp normalization
  const now = Date.now();
  let needsWrite = sourceKey !== canonicalKey;

  if (typeof draft.createdAt !== 'number') {
    draft.createdAt = now;
    needsWrite = true;
  }
  if (typeof draft.updatedAt !== 'number') {
    draft.updatedAt = now;
    needsWrite = true;
  }
  // Ensure updatedAtISO matches updatedAt
  const expectedISO = new Date(draft.updatedAt).toISOString();
  if (draft.updatedAtISO !== expectedISO) {
    draft.updatedAtISO = expectedISO;
    needsWrite = true;
  }

  // Persist canonical draft at correct key if needed
  if (needsWrite) {
    try {
      localStorage.setItem(canonicalKey, JSON.stringify(draft));
    } catch (_) {
      // Ignore write errors during canonicalization
    }
  }

  return draft;
}

/**
 * Check if a draft matches a specific workout identity
 */
export function draftMatchesWorkout(draft, programId, dayIndex) {
  if (!draft) return false;
  return draft.programId === programId && draft.dayIndex === dayIndex;
}

/**
 * Write a draft to localStorage
 * Performs canonicalization: ensures exactly ONE draft key per user.
 *
 * Timestamp behavior:
 * - First creation: sets both createdAt and updatedAt to now
 * - Subsequent updates: only updates updatedAt, preserves createdAt
 *
 * Canonicalization:
 * - Always writes to canonical key: activeWorkoutDraft:${userId}
 * - Removes any suffix variants (e.g., :dup, :old) for this user
 */
export function setDraft(userId, draftData) {
  if (!browser || !userId) return false;
  const canonicalKey = getDraftKey(userId);
  if (!canonicalKey) return false;

  const now = Date.now();

  // Check existing draft for createdAt preservation AND dayIndex fallback
  let createdAt = now;
  let existingDayIndex = null;
  try {
    const raw = localStorage.getItem(canonicalKey);
    if (raw) {
      const existing = JSON.parse(raw);
      if (typeof existing.createdAt === 'number') {
        createdAt = existing.createdAt;
      }
      // Preserve existing valid dayIndex for fallback
      if (isValidDayIndex(existing.dayIndex)) {
        existingDayIndex = existing.dayIndex;
      }
    }
  } catch (_) {
    // Ignore parse errors, use new createdAt
  }

  // Validate incoming dayIndex
  let finalDayIndex = draftData.dayIndex;
  if (!isValidDayIndex(finalDayIndex)) {
    // Incoming dayIndex is invalid
    if (existingDayIndex !== null) {
      // Preserve existing valid dayIndex
      finalDayIndex = existingDayIndex;
      if (import.meta.env.DEV) {
        console.warn('[Draft] Invalid dayIndex in write, preserving existing:', {
          incoming: draftData.dayIndex,
          preserved: existingDayIndex
        });
      }
    } else {
      // No valid dayIndex available - abort save
      if (import.meta.env.DEV) {
        console.warn('[Draft] Aborting save: no valid dayIndex available', {
          incoming: draftData.dayIndex
        });
      }
      return false;
    }
  }

  const draft = {
    ...draftData,
    dayIndex: finalDayIndex, // Use validated dayIndex
    version: DRAFT_VERSION,
    userId,
    createdAt,
    updatedAt: now,
    updatedAtISO: new Date(now).toISOString()
  };

  try {
    // Write to canonical key
    localStorage.setItem(canonicalKey, JSON.stringify(draft));

    // Canonicalization: remove any suffix variants for this user
    const allKeys = collectDraftKeysForUser(userId);
    const removedKeys = [];
    for (const key of allKeys) {
      if (key !== canonicalKey) {
        localStorage.removeItem(key);
        removedKeys.push(key);
      }
    }

    // DEV-only logging for cleanup on write
    if (import.meta.env.DEV && removedKeys.length > 0) {
      console.log('[Draft Write Cleanup]', {
        userId,
        canonicalKey,
        removedKeys
      });
    }

    return true;
  } catch (e) {
    if (import.meta.env.DEV) {
      console.warn('Could not save workout draft:', e);
    }
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
