/**
 * Timer Feedback Utilities
 * Provides audio feedback for timer goals.
 */

// Singleton Audio instance for goal timer SFX
let goalTimerAudio = null;

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
