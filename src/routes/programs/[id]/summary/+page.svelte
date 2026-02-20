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

  onMount(() => {
    // Read and clear new PRs from sessionStorage (set by workout finish)
    try {
      const stored = sessionStorage.getItem('ae:newPRsForSummary');
      if (stored) {
        summaryNewPrs = JSON.parse(stored);
      }
    } catch (err) {
      console.error('Failed to parse new PRs from sessionStorage:', err);
      summaryNewPrs = [];
    }
    // Clear keys after reading (one-time consumption)
    try {
      sessionStorage.removeItem('ae:newPRsForSummary');
      sessionStorage.removeItem('ae:newPRsForSummarySessionId');
    } catch (err) {
      // Ignore cleanup errors
    }
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
