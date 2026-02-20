<script>
  import { page } from '$app/stores';
  import { auth, db } from '$lib/firebase.js';
  import { doc, onSnapshot, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

  let program = $state(null);
  let day = $state(null);
  let currentUserId = $state(null);
  let sessionLogs = $state([]);
  let duration = $state(0);
  let loading = $state(true);
  let dayIndex = $state(0);
  let sessionId = $state(null);

  // New PRs achieved in this session (read from sessionStorage, cleared after read)
  // Shape: Array<{ exerciseId, exerciseName, repBand, newWeight, newReps, prevWeight, prevReps }>
  let summaryNewPrs = $state([]);

  // PR celebration overlay state
  let showPrOverlay = $state(false);
  let selectedPrIndex = $state(0);
  let hasAutoOpenedPrOverlay = false; // One-time latch to prevent re-opening after close
  let hasPendingPrPayload = false; // Track if sessionStorage keys need clearing on dismiss

  // Celebration audio/streamers state
  let hasPlayedCelebrationThisView = false;
  let showTapToPlay = $state(false);
  let celebrationAudio = null;
  let streamers = $state([]);
  let streamerSpawnInterval = null;
  let streamerCleanupTimeout = null;
  const STREAMER_COLORS = ['#ffd700', '#c0c0c0', '#1a1a1a']; // gold, silver, black
  const STREAMER_DURATION = 4000;
  const STREAMER_SPAWN_RATE = 80; // ms between spawns
  const MAX_STREAMERS = 50;

  // Auto-show overlay when PRs are loaded (once per page view)
  $effect(() => {
    if (summaryNewPrs.length > 0 && !hasAutoOpenedPrOverlay) {
      showPrOverlay = true;
      hasAutoOpenedPrOverlay = true;
      // Trigger celebration on next tick (after overlay renders)
      setTimeout(() => triggerCelebration(), 50);
    }
  });

  // Attempt to play celebration (audio + streamers)
  function triggerCelebration() {
    if (hasPlayedCelebrationThisView) return;

    // Check if audio is allowed (primed from Finish Workout click)
    let canAttemptAudio = false;
    try {
      const allowFlag = sessionStorage.getItem('ae:allowPrAudio');
      const allowAt = parseInt(sessionStorage.getItem('ae:allowPrAudioAt') || '0');
      const elapsed = Date.now() - allowAt;
      canAttemptAudio = allowFlag === '1' && elapsed <= 15000;
    } catch (e) {
      // Ignore storage errors
    }

    if (canAttemptAudio) {
      attemptPlayAudio();
    } else {
      // Show tap-to-play fallback
      showTapToPlay = true;
    }
  }

  function attemptPlayAudio() {
    try {
      celebrationAudio = new Audio('/sfx/winning-sound-effect-button.mp3');
      celebrationAudio.volume = 0.5;
      const playPromise = celebrationAudio.play();

      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(() => {
          // Success - start streamers and mark as played
          hasPlayedCelebrationThisView = true;
          showTapToPlay = false;
          clearAllowAudioFlags();
          startStreamers();
        }).catch(() => {
          // Autoplay blocked - show tap fallback
          showTapToPlay = true;
        });
      } else {
        // Old browser without promise - assume success
        hasPlayedCelebrationThisView = true;
        clearAllowAudioFlags();
        startStreamers();
      }
    } catch (e) {
      // Audio creation failed - show tap fallback
      showTapToPlay = true;
    }
  }

  function onTapToPlay() {
    showTapToPlay = false;
    attemptPlayAudio();
  }

  function clearAllowAudioFlags() {
    try {
      sessionStorage.removeItem('ae:allowPrAudio');
      sessionStorage.removeItem('ae:allowPrAudioAt');
    } catch (e) {
      // Ignore
    }
  }

  // Streamer animation
  function startStreamers() {
    let spawnCount = 0;
    const maxSpawns = Math.floor(STREAMER_DURATION / STREAMER_SPAWN_RATE);

    streamerSpawnInterval = setInterval(() => {
      if (spawnCount >= maxSpawns || streamers.length >= MAX_STREAMERS) {
        clearInterval(streamerSpawnInterval);
        streamerSpawnInterval = null;
        return;
      }

      // Spawn 1-2 streamers per tick
      const count = Math.random() > 0.5 ? 2 : 1;
      for (let i = 0; i < count && streamers.length < MAX_STREAMERS; i++) {
        const id = Date.now() + Math.random();
        const color = STREAMER_COLORS[Math.floor(Math.random() * STREAMER_COLORS.length)];
        const left = Math.random() * 100; // % from left
        const width = 6 + Math.random() * 10; // px (larger for visibility)
        const height = 30 + Math.random() * 50; // px (larger for visibility)
        const duration = 2500 + Math.random() * 1500; // ms
        const delay = Math.random() * 100; // ms (reduced delay)
        const rotation = -20 + Math.random() * 40; // deg
        const drift = -30 + Math.random() * 60; // px horizontal drift

        streamers = [...streamers, { id, color, left, width, height, duration, delay, rotation, drift }];

        // Remove streamer after animation completes
        setTimeout(() => {
          streamers = streamers.filter(s => s.id !== id);
        }, duration + delay + 500);
      }
      spawnCount++;
    }, STREAMER_SPAWN_RATE);

    // Stop spawning after duration
    streamerCleanupTimeout = setTimeout(() => {
      if (streamerSpawnInterval) {
        clearInterval(streamerSpawnInterval);
        streamerSpawnInterval = null;
      }
    }, STREAMER_DURATION);
  }

  function stopCelebration() {
    // Stop audio
    if (celebrationAudio) {
      try {
        celebrationAudio.pause();
        celebrationAudio.currentTime = 0;
      } catch (e) {
        // Ignore
      }
      celebrationAudio = null;
    }
    // Stop streamer spawning
    if (streamerSpawnInterval) {
      clearInterval(streamerSpawnInterval);
      streamerSpawnInterval = null;
    }
    if (streamerCleanupTimeout) {
      clearTimeout(streamerCleanupTimeout);
      streamerCleanupTimeout = null;
    }
    // Clear remaining streamers
    streamers = [];
    showTapToPlay = false;
  }

  // Get currently selected PR
  function getSelectedPr() {
    return summaryNewPrs[selectedPrIndex] || null;
  }

  // Format delta line based on weight/reps changes
  function formatDeltaLine(pr) {
    if (!pr) return '';
    const { newWeight, newReps, prevWeight, prevReps, repBand } = pr;

    // First-ever PR (no previous)
    if (prevWeight === null || prevReps === null) {
      return 'New personal record!';
    }

    const weightDelta = newWeight - prevWeight;
    const repsDelta = newReps - prevReps;

    // Both increased
    if (weightDelta > 0 && repsDelta > 0) {
      return `+${weightDelta} lb and +${repsDelta} rep${repsDelta !== 1 ? 's' : ''}`;
    }
    // Weight increased, reps same
    if (weightDelta > 0 && repsDelta === 0) {
      return `+${weightDelta} lb at ${newReps} reps`;
    }
    // Weight same, reps increased
    if (weightDelta === 0 && repsDelta > 0) {
      return `+${repsDelta} rep${repsDelta !== 1 ? 's' : ''} at ${newWeight} lb`;
    }
    // Weight increased, reps decreased (still beat PR due to higher weight)
    if (weightDelta > 0 && repsDelta < 0) {
      return `+${weightDelta} lb in ${repBand} rep range`;
    }
    // Edge case: shouldn't happen but handle gracefully
    return 'Personal record!';
  }

  // Get rep band display label
  function getRepBandLabel(repBand) {
    const labels = {
      '1-5': 'Strength (1-5)',
      '6-8': 'Power (6-8)',
      '9-12': 'Hypertrophy (9-12)',
      '13+': 'Endurance (13+)'
    };
    return labels[repBand] || repBand;
  }

  // Get rep band color
  function getRepBandColor(repBand) {
    const colors = {
      '1-5': '#1565c0',
      '6-8': '#7b1fa2',
      '9-12': '#2e7d32',
      '13+': '#e65100'
    };
    return colors[repBand] || '#666';
  }

  function closePrOverlay() {
    showPrOverlay = false;
    // Stop celebration audio/streamers
    stopCelebration();
    // Clear sessionStorage keys on dismiss (prevents re-showing on future refreshes)
    if (hasPendingPrPayload) {
      try {
        sessionStorage.removeItem('ae:newPRsForSummary');
        sessionStorage.removeItem('ae:newPRsForSummarySessionId');
      } catch (err) {
        // Ignore cleanup errors
      }
      hasPendingPrPayload = false;
    }
  }

  function selectPr(index) {
    selectedPrIndex = index;
  }

  onMount(() => {
    // Read and clear new PRs from sessionStorage (set by workout finish)
    try {
      const stored = sessionStorage.getItem('ae:newPRsForSummary');
      if (stored) {
        summaryNewPrs = JSON.parse(stored);
        if (summaryNewPrs.length > 0) {
          hasPendingPrPayload = true;
        }
      }
    } catch (err) {
      console.error('Failed to parse new PRs from sessionStorage:', err);
      summaryNewPrs = [];
    }
    // Note: Keys are cleared on overlay dismiss, not on read (so refresh before dismiss still shows overlay)

    const urlParams = new URLSearchParams(window.location.search);
    dayIndex = parseInt(urlParams.get('day') || '0');
    duration = parseInt(urlParams.get('duration') || '0');
    sessionId = urlParams.get('session');

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUserId = user.uid;
        await loadSessionLogs();
      }
      loading = false;
    });

    const programId = $page.params.id;
    onSnapshot(doc(db, 'programs', programId), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        program = { id: snapshot.id, ...data };
        // Use published days for clients
        const days = data.publishedDays || data.days;
        day = days?.[dayIndex];
      }
    });
  });

  async function loadSessionLogs() {
    if (!currentUserId || !sessionId) return;

    try {
      const logsQuery = query(
        collection(db, 'workoutLogs'),
        where('userId', '==', currentUserId),
        where('completedWorkoutId', '==', sessionId)
      );

      const snapshot = await getDocs(logsQuery);
      const allLogs = snapshot.docs.map(d => d.data());

      // Group logs by exercise
      const groupedByExercise = {};
      allLogs.forEach(log => {
        const key = log.exerciseId;
        if (!groupedByExercise[key]) {
          groupedByExercise[key] = {
            exerciseId: log.exerciseId,
            exerciseName: log.exerciseName,
            sets: []
          };
        }
        groupedByExercise[key].sets.push({
          setNumber: log.setNumber || 1,
          reps: log.reps,
          weight: log.weight,
          rir: log.rir,
          notes: log.notes,
          repsMetric: log.repsMetric || 'reps',
          weightMetric: log.weightMetric || 'weight'
        });
      });

      sessionLogs = Object.values(groupedByExercise).map(exercise => {
        exercise.sets.sort((a, b) => a.setNumber - b.setNumber);
        return exercise;
      });
    } catch (e) {
      console.log('Could not load logs:', e);
      sessionLogs = [];
    }
  }
</script>

{#if loading}
  <div style="text-align: center; padding: 40px;">
    <p>Loading summary...</p>
  </div>
{:else}
  <div style="text-align: center; padding: 20px;">
    <!-- Success animation -->
    <div style="width: 80px; height: 80px; background: linear-gradient(135deg, #4CAF50, #8BC34A); border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;">
      <span style="color: white; font-size: 2.5em;">✓</span>
    </div>

    <h1 style="color: #4CAF50; margin-bottom: 5px;">Workout Complete!</h1>

    {#if program && day}
      <h2 style="margin: 10px 0 5px 0;">{day.name}</h2>
      <p style="color: #666; margin: 0;">{program.name}</p>
    {/if}

    {#if duration > 0}
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; margin: 25px auto; max-width: 200px;">
        <p style="font-size: 2.5em; margin: 0; font-weight: bold;">{duration}</p>
        <p style="margin: 5px 0 0 0; opacity: 0.9;">minutes</p>
      </div>
    {/if}

    <h3 style="margin-top: 30px; margin-bottom: 15px;">Today's Performance</h3>

    {#if sessionLogs.length === 0}
      <p style="color: #888;">No exercises logged for this workout.</p>
    {:else}
      <div style="text-align: left; max-width: 500px; margin: 0 auto;">
        {#each sessionLogs as exercise}
          <div style="background: white; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px 15px; margin-bottom: 12px;">
            <strong style="font-size: 1.1em;">{exercise.exerciseName}</strong>
            <div style="margin-top: 10px;">
              {#each exercise.sets as set}
                <div style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; margin-bottom: 4px; background: #f8f9fa; border-radius: 5px; font-size: 0.95em;">
                  <span style="font-weight: bold; color: #667eea; min-width: 35px;">Set {set.setNumber}</span>
                  <span style="color: #333;">
                    <strong>{set.reps || '-'}</strong> {set.repsMetric === 'distance' ? '' : 'reps'}
                    {#if set.weight} @ <strong>{set.weight}</strong> {set.weightMetric === 'time' ? '' : 'lbs'}{/if}
                    {#if set.rir} <span style="color: #888;">(RIR: {set.rir})</span>{/if}
                  </span>
                </div>
                {#if set.notes && set.notes !== 'Did not complete'}
                  <div style="color: #666; font-style: italic; font-size: 0.85em; margin: 0 0 8px 45px;">"{set.notes}"</div>
                {/if}
              {/each}
            </div>
          </div>
        {/each}
      </div>

      <p style="color: #888; font-size: 0.9em; margin-top: 20px;">
        {sessionLogs.length} exercise{sessionLogs.length !== 1 ? 's' : ''} logged
      </p>
    {/if}
  </div>

  <nav style="text-align: center; margin-top: 30px; padding-bottom: 30px;">
    <a href="/" style="display: inline-block; padding: 14px 28px; background: #4CAF50; color: white; text-decoration: none; border-radius: 8px; margin-right: 10px; font-weight: 500;">
      Home
    </a>
    <a href="/programs" style="display: inline-block; padding: 14px 28px; background: #2196F3; color: white; text-decoration: none; border-radius: 8px; font-weight: 500;">
      Programs
    </a>
  </nav>
{/if}

<!-- PR Celebration Overlay -->
{#if showPrOverlay && summaryNewPrs.length > 0}
  {@const selectedPr = getSelectedPr()}

  <!-- Streamers layer (OUTSIDE overlay to avoid transform stacking context issues) -->
  <div class="streamers-container" aria-hidden="true">
    {#each streamers as streamer (streamer.id)}
      <div
        class="streamer"
        style="
          left: {streamer.left}%;
          width: {streamer.width}px;
          height: {streamer.height}px;
          background: linear-gradient(135deg, {streamer.color} 0%, {streamer.color}cc 50%, {streamer.color} 100%);
          --dur: {streamer.duration}ms;
          --delay: {streamer.delay}ms;
          --drift: {streamer.drift}px;
          --rot: {streamer.rotation}deg;
        "
      ></div>
    {/each}
  </div>

  <div class="pr-overlay" onclick={closePrOverlay}>
    <div class="pr-overlay-content" onclick={(e) => e.stopPropagation()}>
      <!-- Tap to play fallback -->
      {#if showTapToPlay}
        <button class="tap-to-play-btn" onclick={onTapToPlay}>
          <span class="tap-to-play-icon">🔊</span>
          <span>Tap to play sound</span>
        </button>
      {/if}

      <!-- Hero PR Card -->
      <div class="pr-hero-card">
        <div class="pr-hero-header">
          <span class="pr-trophy">🏆</span>
          <span class="pr-title">NEW PR!</span>
        </div>

        {#if selectedPr}
          <div class="pr-exercise-name">{selectedPr.exerciseName}</div>

          <div class="pr-stats">
            <div class="pr-stat-new">
              <span class="pr-stat-label">NEW</span>
              <span class="pr-stat-value">{selectedPr.newWeight} × {selectedPr.newReps}</span>
            </div>
            <div class="pr-stat-prev">
              <span class="pr-stat-label">PREV</span>
              <span class="pr-stat-value">
                {#if selectedPr.prevWeight !== null && selectedPr.prevReps !== null}
                  {selectedPr.prevWeight} × {selectedPr.prevReps}
                {:else}
                  —
                {/if}
              </span>
            </div>
          </div>

          <div class="pr-delta">{formatDeltaLine(selectedPr)}</div>

          <div class="pr-badge" style="background: {getRepBandColor(selectedPr.repBand)}20; color: {getRepBandColor(selectedPr.repBand)}; border: 1px solid {getRepBandColor(selectedPr.repBand)};">
            {getRepBandLabel(selectedPr.repBand)}
          </div>
        {/if}
      </div>

      <!-- PR Wheel / Carousel -->
      {#if summaryNewPrs.length > 1}
        <div class="pr-wheel">
          <div class="pr-wheel-items">
            {#each summaryNewPrs as pr, i}
              <button
                class="pr-wheel-item"
                class:pr-wheel-item-active={i === selectedPrIndex}
                onclick={() => selectPr(i)}
                style="border-color: {getRepBandColor(pr.repBand)};"
              >
                <span class="pr-wheel-item-name">{pr.exerciseName}</span>
                <span class="pr-wheel-item-band" style="color: {getRepBandColor(pr.repBand)};">{pr.repBand}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Counter -->
      <div class="pr-counter">
        {selectedPrIndex + 1} of {summaryNewPrs.length}
      </div>

      <!-- Disclaimer -->
      <div class="pr-disclaimer">
        Showing strength PRs only (weight + reps)
      </div>

      <!-- Continue Button -->
      <button class="pr-continue-btn" onclick={closePrOverlay}>
        Continue
      </button>
    </div>
  </div>
{/if}

<style>
  /* PR Overlay */
  .pr-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.8);
    z-index: 2000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    animation: pr-overlay-fade-in 0.3s ease-out;
  }

  @keyframes pr-overlay-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .pr-overlay-content {
    width: 100%;
    max-width: 380px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    animation: pr-content-ascend 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  @keyframes pr-content-ascend {
    from {
      opacity: 0;
      transform: translateY(30px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  /* Hero Card */
  .pr-hero-card {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    border-radius: 16px;
    padding: 24px;
    width: 100%;
    text-align: center;
    box-shadow:
      0 0 0 2px rgba(255, 215, 0, 0.3),
      0 0 20px rgba(255, 215, 0, 0.2),
      0 0 40px rgba(255, 215, 0, 0.1),
      0 10px 40px rgba(0, 0, 0, 0.4);
    animation: pr-glow-pulse 2s ease-in-out infinite;
  }

  @keyframes pr-glow-pulse {
    0%, 100% {
      box-shadow:
        0 0 0 2px rgba(255, 215, 0, 0.3),
        0 0 20px rgba(255, 215, 0, 0.2),
        0 0 40px rgba(255, 215, 0, 0.1),
        0 10px 40px rgba(0, 0, 0, 0.4);
    }
    50% {
      box-shadow:
        0 0 0 3px rgba(255, 215, 0, 0.5),
        0 0 30px rgba(255, 215, 0, 0.3),
        0 0 60px rgba(255, 215, 0, 0.15),
        0 10px 40px rgba(0, 0, 0, 0.4);
    }
  }

  .pr-hero-header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin-bottom: 16px;
  }

  .pr-trophy {
    font-size: 2em;
  }

  .pr-title {
    font-size: 1.5em;
    font-weight: bold;
    color: #ffd700;
    text-transform: uppercase;
    letter-spacing: 2px;
  }

  .pr-exercise-name {
    font-size: 1.3em;
    font-weight: 600;
    color: white;
    margin-bottom: 16px;
  }

  .pr-stats {
    display: flex;
    justify-content: center;
    gap: 24px;
    margin-bottom: 12px;
  }

  .pr-stat-new,
  .pr-stat-prev {
    text-align: center;
  }

  .pr-stat-label {
    display: block;
    font-size: 0.7em;
    font-weight: 600;
    letter-spacing: 1px;
    margin-bottom: 4px;
  }

  .pr-stat-new .pr-stat-label {
    color: #4ade80;
  }

  .pr-stat-prev .pr-stat-label {
    color: #94a3b8;
  }

  .pr-stat-value {
    font-size: 1.4em;
    font-weight: bold;
    color: white;
  }

  .pr-stat-prev .pr-stat-value {
    color: #94a3b8;
  }

  .pr-delta {
    font-size: 1em;
    color: #4ade80;
    font-weight: 500;
    margin-bottom: 12px;
  }

  .pr-badge {
    display: inline-block;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 0.85em;
    font-weight: 600;
  }

  /* PR Wheel */
  .pr-wheel {
    width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .pr-wheel::-webkit-scrollbar {
    display: none;
  }

  .pr-wheel-items {
    display: flex;
    gap: 8px;
    padding: 4px;
    justify-content: center;
    flex-wrap: wrap;
  }

  .pr-wheel-item {
    background: rgba(255, 255, 255, 0.1);
    border: 2px solid transparent;
    border-radius: 10px;
    padding: 10px 14px;
    cursor: pointer;
    transition: all 0.2s ease;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-width: 100px;
  }

  .pr-wheel-item:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .pr-wheel-item-active {
    background: rgba(255, 255, 255, 0.2);
    border-color: currentColor;
    transform: scale(1.05);
  }

  .pr-wheel-item-name {
    font-size: 0.85em;
    color: white;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 120px;
  }

  .pr-wheel-item-band {
    font-size: 0.75em;
    font-weight: 600;
  }

  /* Counter */
  .pr-counter {
    font-size: 0.85em;
    color: rgba(255, 255, 255, 0.6);
  }

  /* Disclaimer */
  .pr-disclaimer {
    font-size: 0.75em;
    color: rgba(255, 255, 255, 0.4);
    text-align: center;
  }

  /* Continue Button */
  .pr-continue-btn {
    background: linear-gradient(135deg, #ffd700 0%, #ffb700 100%);
    color: #1a1a2e;
    border: none;
    border-radius: 10px;
    padding: 14px 40px;
    font-size: 1em;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }

  .pr-continue-btn:hover {
    transform: scale(1.02);
    box-shadow: 0 4px 20px rgba(255, 215, 0, 0.3);
  }

  .pr-continue-btn:active {
    transform: scale(0.98);
  }

  /* Streamers */
  .streamers-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    overflow: hidden;
    z-index: 2005; /* Above scrim (2000), below nothing - streamers should be very visible */
  }

  .streamer {
    position: absolute;
    top: -40px;
    border-radius: 3px;
    box-shadow:
      0 0 6px rgba(255, 255, 255, 0.5),
      inset 0 0 2px rgba(255, 255, 255, 0.3);
    animation-name: streamerFall;
    animation-duration: var(--dur, 2500ms);
    animation-delay: var(--delay, 0ms);
    animation-timing-function: linear;
    animation-fill-mode: forwards;
    will-change: transform, opacity;
  }

  @keyframes streamerFall {
    0% {
      opacity: 1;
      transform: translateY(0) translateX(0) rotate(0deg);
    }
    90% {
      opacity: 0.9;
    }
    100% {
      opacity: 0;
      transform: translateY(110vh) translateX(var(--drift, 0px)) rotate(var(--rot, 0deg));
    }
  }

  /* Tap to Play */
  .tap-to-play-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(255, 255, 255, 0.15);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 20px;
    padding: 8px 16px;
    color: white;
    font-size: 0.85em;
    cursor: pointer;
    transition: background 0.2s ease;
    margin-bottom: 8px;
  }

  .tap-to-play-btn:hover {
    background: rgba(255, 255, 255, 0.25);
  }

  .tap-to-play-icon {
    font-size: 1.1em;
  }

</style>
