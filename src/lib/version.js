/**
 * App Version Tracking
 * Provides version info for display and debugging.
 */

// App version (semantic versioning)
export const APP_VERSION = '0.12.14';

// Feature versions - track when specific features were last updated
// Increment when making significant changes to a feature
// Format: { v: version_number, date: 'YYYY-MM-DD' }
export const FEATURE_VERSIONS = {
  appVersioning: { v: 1, date: '02 - 25 - 2026' },
  exerciseCreateFlow: { v: 1, date: '02 - 25 - 2026' },
  exerciseHistoryModalFormat: { v: 2, date: '02 - 25 - 2026' },
  exerciseLaterality: { v: 1, date: '03 - 10 - 2026' },
  exerciseLibraryTypeDropdown: { v: 1, date: '02 - 25 - 2026' },
  exercisePickerModal: { v: 1, date: '02 - 25 - 2026' },
  firestoreListenerHygiene: { v: 1, date: '03 - 03 - 2026' },
  focusModeTimer: { v: 1, date: '02 - 25 - 2026' },
  metricsV2Foundation: { v: 8, date: '03 - 10 - 2026' },
  passwordReset: { v: 1, date: '03 - 03 - 2026' },
  prCelebration: { v: 1, date: '02 - 25 - 2026' },
  prPageConsolidation: { v: 2, date: '02 - 25 - 2026' },
  restTimerFeedback: { v: 1, date: '02 - 25 - 2026' },
  restTimerToast: { v: 1, date: '02 - 25 - 2026' },
  settingsEmailActions: { v: 1, date: '03 - 04 - 2026' },
  tonnageTracking: { v: 1, date: '02 - 25 - 2026' },
  workoutSessionQoL: { v: 1, date: '02 - 25 - 2026' }
};

// Build ID from environment (set by CI/CD, e.g., git SHA)
// Falls back to 'dev' for local development
export const BUILD_ID = import.meta.env?.VITE_BUILD_ID || 'dev';

// Build time from environment (ISO timestamp set by CI/CD)
// Falls back to empty string for local development
export const BUILD_TIME = import.meta.env?.VITE_BUILD_TIME || '';

// Helper to format build info for display
export function getBuildInfo() {
  const parts = [`v${APP_VERSION}`, `Build: ${BUILD_ID}`];
  if (BUILD_TIME) {
    parts.push(`(${BUILD_TIME})`);
  }
  return parts.join(' | ');
}
