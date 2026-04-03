/**
 * PR (Personal Record) Helper Functions
 *
 * Provides utilities for side-aware PR storage for unilateral exercises.
 * Schema version 2 adds explicit laterality and side metadata.
 */

export const PR_SCHEMA_VERSION = 2;

/**
 * Convert rep band to Firestore-safe key format
 * Examples: "6-8" → "6_8", "13+" → "13_plus"
 */
export function bandToKey(band) {
  return band.replace('-', '_').replace('+', '_plus');
}

/**
 * Get the rep band for a given rep count
 */
export function getRepBandFromReps(reps) {
  if (reps >= 1 && reps <= 5) return '1-5';
  if (reps >= 6 && reps <= 8) return '6-8';
  if (reps >= 9 && reps <= 12) return '9-12';
  if (reps >= 13) return '13+';
  return null;
}

/**
 * Compute the PR document ID for a given exercise, band, laterality, and side.
 *
 * For bilateral exercises: exerciseId__bandKey (e.g., "abc123__6_8")
 * For unilateral exercises: exerciseId__bandKey__side (e.g., "abc123__6_8__L")
 *
 * @param {string} exerciseId - The exercise ID
 * @param {string} band - The rep band (e.g., "6-8", "13+")
 * @param {string} laterality - 'bilateral' or 'unilateral'
 * @param {string|null} side - 'L' or 'R' for unilateral, null for bilateral
 * @returns {string} The document ID
 */
export function getPrDocId(exerciseId, band, laterality, side) {
  const bandKey = bandToKey(band);

  if (laterality === 'unilateral' && (side === 'L' || side === 'R')) {
    return `${exerciseId}__${bandKey}__${side}`;
  }

  // Bilateral or fallback
  return `${exerciseId}__${bandKey}`;
}

/**
 * Build the full PR document payload with schema v2 metadata.
 *
 * @param {Object} params
 * @param {string} params.exerciseId - The exercise ID
 * @param {string} params.exerciseName - The exercise name for display
 * @param {string} params.band - The rep band (e.g., "6-8")
 * @param {number} params.weight - The best weight
 * @param {number} params.reps - The reps at that weight
 * @param {string} params.laterality - 'bilateral' or 'unilateral'
 * @param {string|null} params.side - 'L', 'R', or null
 * @param {string|null} params.sessionId - The workout session ID
 * @param {*} params.achievedAt - Timestamp when PR was achieved
 * @param {*} params.updatedAt - Timestamp of this update (usually serverTimestamp())
 * @returns {Object} The PR document payload
 */
export function buildPrPayload({
  exerciseId,
  exerciseName,
  band,
  weight,
  reps,
  laterality,
  side,
  sessionId,
  achievedAt,
  updatedAt
}) {
  return {
    // Core fields
    exerciseId,
    exerciseNameSnapshot: exerciseName,
    repBand: band,
    metric: 'topWeight',
    bestWeight: weight,
    bestReps: reps,
    achievedAt,
    sessionId: sessionId || null,
    updatedAt,

    // Schema v2 metadata
    schemaVersion: PR_SCHEMA_VERSION,
    laterality: laterality || 'bilateral',
    side: laterality === 'unilateral' ? (side || null) : null
  };
}

/**
 * Check if a side value is valid for PR evaluation.
 *
 * For bilateral exercises: side should be null
 * For unilateral exercises: side must be 'L' or 'R'
 *
 * @param {string} laterality - 'bilateral' or 'unilateral'
 * @param {string|null} side - The side value
 * @returns {boolean} True if valid for PR evaluation
 */
export function isValidSideForPr(laterality, side) {
  if (laterality === 'bilateral') {
    return true; // Bilateral doesn't care about side
  }

  if (laterality === 'unilateral') {
    // Unilateral must have explicit L or R
    return side === 'L' || side === 'R';
  }

  // Unknown laterality - default to bilateral behavior
  return true;
}

/**
 * Get all possible PR doc IDs that should exist for an exercise/band combo.
 * Used for cleanup during recompute.
 *
 * @param {string} exerciseId
 * @param {string} band
 * @param {string} laterality
 * @returns {string[]} Array of possible doc IDs
 */
export function getAllPossiblePrDocIds(exerciseId, band, laterality) {
  const bandKey = bandToKey(band);

  if (laterality === 'unilateral') {
    // Unilateral should have side-specific docs
    return [
      `${exerciseId}__${bandKey}__L`,
      `${exerciseId}__${bandKey}__R`
    ];
  }

  // Bilateral uses unsuffixed doc
  return [`${exerciseId}__${bandKey}`];
}

/**
 * Get all doc IDs that are stale for an exercise/band after recompute.
 * These are the wrong format docs that should be cleaned up.
 *
 * @param {string} exerciseId
 * @param {string} band
 * @param {string} laterality - Current laterality of the exercise
 * @returns {string[]} Array of stale doc IDs to delete
 */
export function getStalePrDocIds(exerciseId, band, laterality) {
  const bandKey = bandToKey(band);

  if (laterality === 'unilateral') {
    // Unilateral exercises should NOT have unsuffixed bilateral-style docs
    return [`${exerciseId}__${bandKey}`];
  }

  // Bilateral exercises should NOT have side-suffixed docs
  return [
    `${exerciseId}__${bandKey}__L`,
    `${exerciseId}__${bandKey}__R`
  ];
}

/**
 * Check if a log entry is eligible for rep-band PRs.
 * Time and distance exercises do not qualify.
 *
 * @param {Object} log - The workout log entry
 * @returns {boolean} True if eligible
 */
export function isEligibleForPr(log) {
  if (log.metricsV2 && Array.isArray(log.metricsV2)) {
    const hasReps = log.metricsV2.some(m => m.key === 'reps');
    const hasLoad = log.metricsV2.some(m => m.key === 'load');
    const hasTime = log.metricsV2.some(m => m.key === 'time');
    const hasDistance = log.metricsV2.some(m => m.key === 'distance');
    return hasReps && hasLoad && !hasTime && !hasDistance;
  }

  // Legacy fallback
  const repsMetric = log.repsMetric || 'reps';
  const weightMetric = log.weightMetric || 'weight';
  return repsMetric === 'reps' && weightMetric === 'weight';
}

/**
 * Parse a PR doc ID to extract its components.
 *
 * @param {string} docId - The PR doc ID
 * @returns {Object} { exerciseId, bandKey, side } - side is null for bilateral
 */
export function parsePrDocId(docId) {
  const parts = docId.split('__');

  if (parts.length === 3) {
    // Side-suffixed: exerciseId__bandKey__side
    return {
      exerciseId: parts[0],
      bandKey: parts[1],
      side: parts[2]
    };
  }

  if (parts.length === 2) {
    // Bilateral: exerciseId__bandKey
    return {
      exerciseId: parts[0],
      bandKey: parts[1],
      side: null
    };
  }

  // Invalid format
  return null;
}

/**
 * All rep bands
 */
export const ALL_REP_BANDS = ['1-5', '6-8', '9-12', '13+'];

/**
 * Check if an in-memory set is eligible for rep-band PRs.
 * Used during live workout completion (before Firestore save).
 * Time and distance exercises do not qualify.
 *
 * @param {Object} set - The in-memory set object { reps, weight, metricsV2?, ... }
 * @param {Object} exercise - The exercise definition { repsMetric?, weightMetric?, ... }
 * @returns {boolean} True if eligible for PR evaluation
 */
export function isSetEligibleForPr(set, exercise) {
  // Check if set has metricsV2 array (rare in live sets, but possible)
  if (set.metricsV2 && Array.isArray(set.metricsV2)) {
    const hasReps = set.metricsV2.some(m => m.key === 'reps');
    const hasLoad = set.metricsV2.some(m => m.key === 'load');
    const hasTime = set.metricsV2.some(m => m.key === 'time');
    const hasDistance = set.metricsV2.some(m => m.key === 'distance');
    return hasReps && hasLoad && !hasTime && !hasDistance;
  }

  // Standard live set check using exercise metric configuration
  const repsMetric = exercise?.repsMetric || 'reps';
  const weightMetric = exercise?.weightMetric || 'weight';

  // Only reps + weight metric combination qualifies for rep-band PRs
  // time and distance do not qualify
  return repsMetric === 'reps' && weightMetric === 'weight';
}

/**
 * Compare a PR candidate against an existing PR to determine if it's better.
 *
 * @param {Object} candidate - { weight, reps }
 * @param {Object} existing - { bestWeight, bestReps } or null if no existing PR
 * @returns {boolean} True if candidate beats existing (or existing is null)
 */
export function isPrBetterThanExisting(candidate, existing) {
  if (!existing) return true;

  const existingWeight = existing.bestWeight || 0;
  const existingReps = existing.bestReps || 0;

  // Higher weight wins
  if (candidate.weight > existingWeight) return true;
  // Same weight, more reps wins
  if (candidate.weight === existingWeight && candidate.reps > existingReps) return true;

  return false;
}

/**
 * Extract PR candidate data from an in-memory set during live workout completion.
 * Returns null if the set is not eligible or has invalid data.
 *
 * @param {Object} set - The in-memory set object { reps, weight, side?, ... }
 * @param {Object} exercise - The exercise definition { exerciseId, name, repsMetric?, weightMetric?, ... }
 * @param {string} laterality - 'bilateral' or 'unilateral'
 * @returns {Object|null} PR candidate or null if not eligible
 */
export function extractPrCandidate(set, exercise, laterality) {
  // Check eligibility
  if (!isSetEligibleForPr(set, exercise)) return null;

  const weight = parseFloat(set.weight);
  const reps = parseInt(set.reps);

  // Must have valid numeric weight + reps
  if (isNaN(weight) || isNaN(reps) || weight <= 0 || reps <= 0) return null;

  const repBand = getRepBandFromReps(reps);
  if (!repBand) return null;

  // Determine side
  const side = laterality === 'unilateral' ? (set.side || null) : null;

  // For unilateral exercises, must have valid side
  if (!isValidSideForPr(laterality, side)) return null;

  return {
    exerciseId: exercise.exerciseId,
    exerciseName: exercise.name,
    repBand,
    weight,
    reps,
    laterality,
    side
  };
}

/**
 * Compute side-to-side comparison for unilateral exercises.
 *
 * Returns comparison data including label, severity, and whether to show.
 *
 * Thresholds:
 * - Under 10%: "No Imbalance" (severity: 'none')
 * - 10% to 15% inclusive: "Worth Monitoring" (severity: 'monitoring')
 * - Over 15%: "Asymmetry to Address" (severity: 'address')
 *
 * @param {number|null} leftE1RM - Left side best e1RM value
 * @param {number|null} rightE1RM - Right side best e1RM value
 * @returns {Object} { shouldShow, strongerSide, differencePercent, label, severity }
 */
export function computeUnilateralComparison(leftE1RM, rightE1RM) {
  // Validate both sides have positive values
  if (!leftE1RM || !rightE1RM || leftE1RM <= 0 || rightE1RM <= 0) {
    return {
      shouldShow: false,
      strongerSide: null,
      differencePercent: 0,
      label: '',
      severity: 'none'
    };
  }

  // Determine stronger and weaker sides
  const leftStronger = leftE1RM >= rightE1RM;
  const strongerValue = leftStronger ? leftE1RM : rightE1RM;
  const weakerValue = leftStronger ? rightE1RM : leftE1RM;
  const strongerSide = leftStronger ? 'Left Side' : 'Right Side';

  // Calculate percent difference: ((stronger / weaker) - 1) * 100
  const differencePercent = Math.round(((strongerValue / weakerValue) - 1) * 100);

  // Determine severity and label based on thresholds
  let severity;
  let label;

  if (differencePercent < 10) {
    severity = 'none';
    label = 'No Imbalance';
  } else if (differencePercent <= 15) {
    severity = 'monitoring';
    label = `${strongerSide} is (+${differencePercent}%) Stronger (Worth Monitoring)`;
  } else {
    severity = 'address';
    label = `${strongerSide} is (+${differencePercent}%) Stronger (Asymmetry to Address)`;
  }

  return {
    shouldShow: true,
    strongerSide,
    differencePercent,
    label,
    severity
  };
}

/**
 * Extract PR candidate data from a saved workoutLog document.
 * Returns null if the log is not eligible or has invalid data.
 *
 * @param {Object} log - The saved workoutLog document
 * @param {string} laterality - 'bilateral' or 'unilateral'
 * @returns {Object|null} PR candidate or null if not eligible
 */
export function extractPrCandidateFromLog(log, laterality) {
  // Check eligibility using log-based helper
  if (!isEligibleForPr(log)) return null;

  const weight = parseFloat(log.weight);
  const reps = parseInt(log.reps);

  // Must have valid numeric weight + reps
  if (isNaN(weight) || isNaN(reps) || weight <= 0 || reps <= 0) return null;

  const repBand = getRepBandFromReps(reps);
  if (!repBand) return null;

  // Determine side
  const side = laterality === 'unilateral' ? (log.side || null) : null;

  // For unilateral exercises, must have valid side
  if (!isValidSideForPr(laterality, side)) return null;

  return {
    exerciseId: log.exerciseId,
    exerciseName: log.exerciseName || 'Unknown Exercise',
    repBand,
    weight,
    reps,
    laterality,
    side,
    sessionId: log.completedWorkoutId || null,
    loggedAt: log.loggedAt
  };
}
