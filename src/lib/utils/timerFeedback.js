/**
 * Timer Feedback Utilities
 * Provides audio feedback for timer goals and rest timers.
 */

// Singleton Audio instance for goal timer SFX
let goalTimerAudio = null;

// Singleton Audio instance for rest timer SFX
let restTimerAudio = null;

/**
 * Prime the goal timer audio (call on user gesture like Start click).
 * Creates the Audio instance and loads it for immediate playback.
 */
export function primeGoalTimerAudio() {
  try {
    if (!goalTimerAudio) {
      goalTimerAudio = new Audio('/sfx/astralsynthesizer-11l-victory_trumpet-1749704501065-358769.mp3');
      goalTimerAudio.volume = 0.6;
    }
    goalTimerAudio.load();
    return true;
  } catch (e) {
    console.warn('[timerFeedback] Failed to prime goal audio:', e);
    return false;
  }
}

/**
 * Play the goal timer audio.
 * Resets to start and plays. Returns true on success, false on failure.
 * @returns {Promise<boolean>}
 */
export async function playGoalTimerAudio() {
  try {
    if (!goalTimerAudio) {
      // Attempt to create if not primed
      goalTimerAudio = new Audio('/sfx/astralsynthesizer-11l-victory_trumpet-1749704501065-358769.mp3');
      goalTimerAudio.volume = 0.6;
    }
    goalTimerAudio.currentTime = 0;
    await goalTimerAudio.play();
    return true;
  } catch (e) {
    console.warn('[timerFeedback] Failed to play goal audio:', e);
    return false;
  }
}

/**
 * Prime the rest timer audio (call on user gesture like Start click).
 * Creates the Audio instance and loads it for immediate playback.
 */
export function primeRestTimerAudio() {
  try {
    if (!restTimerAudio) {
      restTimerAudio = new Audio('/sfx/transcendedlifting-race-start-beeps-125125.mp3');
      restTimerAudio.volume = 0.7;
    }
    restTimerAudio.load();
    return true;
  } catch (e) {
    console.warn('[timerFeedback] Failed to prime rest audio:', e);
    return false;
  }
}

/**
 * Play the rest timer audio (beeps at T-3s).
 * Resets to start and plays. Returns true on success, false on failure.
 * @returns {Promise<boolean>}
 */
export async function playRestTimerAudio() {
  try {
    if (!restTimerAudio) {
      // Attempt to create if not primed
      restTimerAudio = new Audio('/sfx/transcendedlifting-race-start-beeps-125125.mp3');
      restTimerAudio.volume = 0.7;
    }
    restTimerAudio.currentTime = 0;
    await restTimerAudio.play();
    return true;
  } catch (e) {
    console.warn('[timerFeedback] Failed to play rest audio:', e);
    return false;
  }
}

/**
 * Pause the rest timer audio if currently playing.
 */
export function pauseRestTimerAudio() {
  try {
    if (restTimerAudio && !restTimerAudio.paused) {
      restTimerAudio.pause();
    }
  } catch (e) {
    console.warn('[timerFeedback] Failed to pause rest audio:', e);
  }
}

/**
 * Resume the rest timer audio if currently paused.
 * @returns {Promise<boolean>}
 */
export async function resumeRestTimerAudio() {
  try {
    if (restTimerAudio && restTimerAudio.paused && restTimerAudio.currentTime > 0) {
      await restTimerAudio.play();
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[timerFeedback] Failed to resume rest audio:', e);
    return false;
  }
}

/**
 * Stop the rest timer audio (pause + rewind to start).
 */
export function stopRestTimerAudio() {
  try {
    if (restTimerAudio) {
      restTimerAudio.pause();
      restTimerAudio.currentTime = 0;
    }
  } catch (e) {
    console.warn('[timerFeedback] Failed to stop rest audio:', e);
  }
}

/**
 * Check if rest timer SFX is enabled (reads from localStorage).
 * @returns {boolean} true if enabled (default), false if disabled
 */
export function isRestSfxEnabled() {
  if (typeof localStorage === 'undefined') return true;
  const stored = localStorage.getItem('ae:restSfxEnabled');
  return stored !== '0';
}
