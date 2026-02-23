/**
 * App Version Tracking
 * Provides version info for display and debugging.
 */

// App version (semantic versioning)
export const APP_VERSION = '0.11.0';

// Feature versions - track when specific features were last updated
// Increment when making significant changes to a feature
export const FEATURE_VERSIONS = {
  exerciseHistoryModalFormat: 2,
  prCelebration: 1,
  prPageConsolidation: 2,
  restTimerFeedback: 1,
  restTimerToast: 1,
  focusModeTimer: 1,
  tonnageTracking: 1,
  appVersioning: 1,
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
