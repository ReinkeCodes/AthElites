<script>
  import { page } from '$app/stores';
  import { auth, db } from '$lib/firebase.js';
  import { doc, onSnapshot, getDoc, collection, addDoc, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let program = $state(null);
  let day = $state(null);
  let currentSectionIndex = $state(0);
  let currentUserId = $state(null);
  let workoutStartTime = $state(null);

  // Exercise logging - tracks what user enters for each exercise
  let exerciseLogs = $state({});

  // History data for each exercise (last 2 entries + PR)
  let exerciseHistory = $state({});

  onMount(() => {
    workoutStartTime = new Date();

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUserId = user.uid;
      }
    });

    const programId = $page.params.id;
    const dayIndex = parseInt($page.params.dayIndex);

    onSnapshot(doc(db, 'programs', programId), async (snapshot) => {
      if (snapshot.exists()) {
        program = { id: snapshot.id, ...snapshot.data() };
        day = program.days?.[dayIndex];

        // Initialize exercise logs for all exercises
        if (day?.sections) {
          const logs = {};
          for (const section of day.sections) {
            for (const exercise of section.exercises || []) {
              const key = exercise.exerciseId;
              logs[key] = {
                sets: exercise.sets || '',
                reps: exercise.reps || '',
                weight: exercise.weight || '',
                rir: exercise.rir || '',
                notes: ''
              };
            }
          }
          exerciseLogs = logs;

          // Load history for each exercise
          if (currentUserId) {
            await loadExerciseHistory();
          }
        }
      }
    });
  });

  async function loadExerciseHistory() {
    if (!day?.sections || !currentUserId) return;

    const history = {};
    for (const section of day.sections) {
      for (const exercise of section.exercises || []) {
        const exerciseId = exercise.exerciseId;

        // Get last 2 logged entries for this exercise
        const logsQuery = query(
          collection(db, 'workoutLogs'),
          where('userId', '==', currentUserId),
          where('exerciseId', '==', exerciseId),
          orderBy('loggedAt', 'desc'),
          limit(10)
        );

        try {
          const snapshot = await getDocs(logsQuery);
          const entries = snapshot.docs.map(d => d.data());

          // Find PR (highest weight)
          let pr = null;
          entries.forEach(entry => {
            const weight = parseFloat(entry.weight) || 0;
            if (!pr || weight > pr.weight) {
              pr = { weight, reps: entry.reps, date: entry.loggedAt };
            }
          });

          history[exerciseId] = {
            lastTwo: entries.slice(0, 2),
            pr: pr
          };
        } catch (e) {
          // Index might not exist yet, that's ok
          history[exerciseId] = { lastTwo: [], pr: null };
        }
      }
    }
    exerciseHistory = history;
  }

  function getCurrentSection() {
    return day?.sections?.[currentSectionIndex];
  }

  function getTotalSections() {
    return day?.sections?.length || 0;
  }

  function nextSection() {
    if (currentSectionIndex < getTotalSections() - 1) {
      currentSectionIndex++;
    }
  }

  function prevSection() {
    if (currentSectionIndex > 0) {
      currentSectionIndex--;
    }
  }

  async function finishWorkout() {
    if (!currentUserId || !day) return;

    // Save all exercise logs to Firestore
    const logPromises = [];
    for (const section of day.sections || []) {
      for (const exercise of section.exercises || []) {
        const key = exercise.exerciseId;
        const log = exerciseLogs[key];

        if (log && (log.weight || log.reps)) {
          logPromises.push(addDoc(collection(db, 'workoutLogs'), {
            userId: currentUserId,
            programId: program.id,
            programName: program.name,
            dayName: day.name,
            exerciseId: exercise.exerciseId,
            exerciseName: exercise.name,
            sets: log.sets,
            reps: log.reps,
            weight: log.weight,
            rir: log.rir,
            notes: log.notes,
            loggedAt: new Date()
          }));
        }
      }
    }

    // Save workout session
    const workoutEndTime = new Date();
    const durationMinutes = Math.round((workoutEndTime - workoutStartTime) / 60000);

    await Promise.all([
      ...logPromises,
      addDoc(collection(db, 'workoutSessions'), {
        userId: currentUserId,
        programId: program.id,
        programName: program.name,
        dayName: day.name,
        startedAt: workoutStartTime,
        finishedAt: workoutEndTime,
        durationMinutes: durationMinutes
      })
    ]);

    goto(`/programs/${program.id}/summary?day=${$page.params.dayIndex}&duration=${durationMinutes}`);
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString();
  }
</script>

{#if program && day}
  <div style="margin-bottom: 20px;">
    <h1 style="margin-bottom: 5px;">{day.name}</h1>
    <p style="color: #666; margin: 0;">{program.name}</p>
  </div>

  <!-- Progress indicator -->
  <div style="display: flex; gap: 5px; margin-bottom: 20px;">
    {#each day.sections || [] as section, i}
      <div style="flex: 1; height: 8px; border-radius: 4px; background: {i <= currentSectionIndex ? '#4CAF50' : '#ddd'};"></div>
    {/each}
  </div>

  <!-- Current section -->
  {#if getCurrentSection()}
    <div style="background: #f5f5f5; padding: 15px; border-radius: 10px; margin-bottom: 20px;">
      <h2 style="margin: 0 0 15px 0;">{getCurrentSection().name}</h2>
      <p style="color: #888; margin: 0;">Section {currentSectionIndex + 1} of {getTotalSections()}</p>
    </div>

    <!-- Exercises in this section -->
    {#each getCurrentSection().exercises || [] as exercise}
      {@const history = exerciseHistory[exercise.exerciseId]}
      <div style="border: 1px solid #ddd; padding: 15px; margin-bottom: 15px; border-radius: 8px; background: white;">
        <h3 style="margin: 0 0 5px 0;">{exercise.name}</h3>
        <p style="color: #888; margin: 0 0 10px 0; font-size: 0.9em;">
          Target: {exercise.sets} sets × {exercise.reps}
          {#if exercise.weight} @ {exercise.weight}{/if}
          {#if exercise.rir} (RIR: {exercise.rir}){/if}
        </p>
        {#if exercise.customReqs && exercise.customReqs.length > 0}
          <div style="margin-bottom: 10px;">
            {#each exercise.customReqs as req}
              {#if req.name && req.value}
                <span style="display: inline-block; background: #fff3e0; padding: 3px 8px; border-radius: 4px; font-size: 0.85em; margin-right: 5px; margin-bottom: 3px;">
                  <strong>{req.name}:</strong> {req.value}
                </span>
              {/if}
            {/each}
          </div>
        {/if}

        <!-- History section -->
        {#if history && (history.lastTwo?.length > 0 || history.pr)}
          <div style="background: #f0f8ff; padding: 10px; margin-bottom: 10px; border-radius: 5px; font-size: 0.85em;">
            {#if history.pr}
              <div style="color: #ff9800; font-weight: bold;">
                PR: {history.pr.weight} × {history.pr.reps}
              </div>
            {/if}
            {#if history.lastTwo?.length > 0}
              <div style="color: #666; margin-top: 5px;">
                <strong>Recent:</strong>
                {#each history.lastTwo as entry, i}
                  <div>{formatDate(entry.loggedAt)}: {entry.weight || '-'} × {entry.reps || '-'}</div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <!-- Input fields -->
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 8px;">
          <div>
            <label style="font-size: 0.8em; color: #666;">Sets</label>
            <input
              type="text"
              bind:value={exerciseLogs[exercise.exerciseId].sets}
              style="width: 100%; padding: 8px; box-sizing: border-box;"
            />
          </div>
          <div>
            <label style="font-size: 0.8em; color: #666;">Reps</label>
            <input
              type="text"
              bind:value={exerciseLogs[exercise.exerciseId].reps}
              style="width: 100%; padding: 8px; box-sizing: border-box;"
            />
          </div>
          <div>
            <label style="font-size: 0.8em; color: #666;">Weight</label>
            <input
              type="text"
              bind:value={exerciseLogs[exercise.exerciseId].weight}
              style="width: 100%; padding: 8px; box-sizing: border-box;"
            />
          </div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 8px;">
          <div>
            <label style="font-size: 0.8em; color: #666;">RIR</label>
            <input
              type="text"
              bind:value={exerciseLogs[exercise.exerciseId].rir}
              style="width: 100%; padding: 8px; box-sizing: border-box;"
            />
          </div>
          <div>
            <label style="font-size: 0.8em; color: #666;">Notes</label>
            <input
              type="text"
              bind:value={exerciseLogs[exercise.exerciseId].notes}
              placeholder="How did it feel?"
              style="width: 100%; padding: 8px; box-sizing: border-box;"
            />
          </div>
        </div>
      </div>
    {/each}

    <!-- Navigation buttons -->
    <div style="display: flex; justify-content: space-between; margin-top: 20px;">
      {#if currentSectionIndex > 0}
        <button onclick={prevSection} style="padding: 12px 24px;">Previous</button>
      {:else}
        <div></div>
      {/if}

      {#if currentSectionIndex < getTotalSections() - 1}
        <button onclick={nextSection} style="padding: 12px 24px; background: #4CAF50; color: white; border: none; cursor: pointer;">
          Next Section
        </button>
      {:else}
        <button onclick={finishWorkout} style="padding: 12px 24px; background: #2196F3; color: white; border: none; cursor: pointer;">
          Finish Workout
        </button>
      {/if}
    </div>
  {:else}
    <p>No exercises in this section.</p>
  {/if}
{:else}
  <p>Loading workout...</p>
{/if}

<nav style="margin-top: 30px;">
  <a href="/programs/{$page.params.id}/days">← Back to Day Selection</a>
</nav>
