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

  // Exercise logging - tracks what user enters for each SET of each exercise
  // Structure: { exerciseId: { targetSets, targetReps, targetWeight, targetRir, sets: [{reps, weight, rir, notes}, ...] } }
  let exerciseLogs = $state({});

  // Checkbox completions for checkbox-mode sections
  let exerciseCompleted = $state({});

  // Track which sections user has passed (for marking as complete even if skipped)
  let visitedSections = $state(new Set());

  // Custom requirement inputs from client
  // Structure: { exerciseId: { reqIndex: value, ... } }
  let customReqInputs = $state({});

  // History data for each exercise (last 2 entries + PR)
  let exerciseHistory = $state({});

  // Notes modal state
  let notesModal = $state({ open: false, exerciseId: null, setIndex: null, exerciseName: '' });

  // History modal state
  let historyModal = $state({ open: false, exerciseId: null, exerciseName: '' });

  function openHistoryModal(exerciseId, exerciseName) {
    historyModal = { open: true, exerciseId, exerciseName };
  }

  function closeHistoryModal() {
    historyModal = { open: false, exerciseId: null, exerciseName: '' };
  }

  function openNotesModal(exerciseId, setIndex, exerciseName) {
    notesModal = { open: true, exerciseId, setIndex, exerciseName };
  }

  function closeNotesModal() {
    notesModal = { open: false, exerciseId: null, setIndex: null, exerciseName: '' };
  }

  function getNotesValue() {
    if (!notesModal.exerciseId) return '';
    return exerciseLogs[notesModal.exerciseId]?.sets?.[notesModal.setIndex]?.notes || '';
  }

  function setNotesValue(value) {
    if (notesModal.exerciseId && exerciseLogs[notesModal.exerciseId]?.sets?.[notesModal.setIndex]) {
      exerciseLogs[notesModal.exerciseId].sets[notesModal.setIndex].notes = value;
    }
  }

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
        // Use published version for clients, fall back to days if not published
        const programDays = program.publishedDays || program.days;
        day = programDays?.[dayIndex];

        // Initialize exercise logs for all exercises
        if (day?.sections) {
          const logs = {};
          const completed = {};
          for (const section of day.sections) {
            for (const exercise of section.exercises || []) {
              const key = `${section.name}-${exercise.exerciseId}`;
              if (section.mode === 'checkbox') {
                completed[key] = false;
              } else {
                // Create per-set tracking
                const numSets = parseInt(exercise.sets) || 3;
                logs[exercise.exerciseId] = {
                  targetSets: numSets,
                  targetReps: exercise.reps || '',
                  targetWeight: exercise.weight || '',
                  targetRir: exercise.rir || '',
                  sets: Array(numSets).fill(null).map(() => ({
                    reps: '',
                    weight: '',
                    rir: '',
                    notes: ''
                  }))
                };
              }
            }
          }
          exerciseLogs = logs;
          exerciseCompleted = completed;

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

  function isCheckboxSection(section) {
    return section?.mode === 'checkbox';
  }

  function toggleExerciseComplete(sectionName, exerciseId) {
    const key = `${sectionName}-${exerciseId}`;
    exerciseCompleted[key] = !exerciseCompleted[key];
  }

  function isExerciseComplete(sectionName, exerciseId) {
    const key = `${sectionName}-${exerciseId}`;
    return exerciseCompleted[key] || false;
  }

  // Check if a section is complete
  function isSectionComplete(sectionIndex) {
    const section = day?.sections?.[sectionIndex];
    if (!section || !section.exercises || section.exercises.length === 0) return false;

    if (section.mode === 'checkbox') {
      // All exercises must be checked
      return section.exercises.every(ex =>
        exerciseCompleted[`${section.name}-${ex.exerciseId}`]
      );
    } else {
      // For full tracking, at least one set with reps or weight for all exercises
      return section.exercises.every(ex => {
        const log = exerciseLogs[ex.exerciseId];
        if (!log || !log.sets) return false;
        return log.sets.some(set => set.weight || set.reps);
      });
    }
  }

  // Check if a section is started (has some data but not complete)
  function isSectionStarted(sectionIndex) {
    const section = day?.sections?.[sectionIndex];
    if (!section || !section.exercises || section.exercises.length === 0) return false;

    if (section.mode === 'checkbox') {
      return section.exercises.some(ex =>
        exerciseCompleted[`${section.name}-${ex.exerciseId}`]
      );
    } else {
      return section.exercises.some(ex => {
        const log = exerciseLogs[ex.exerciseId];
        if (!log || !log.sets) return false;
        return log.sets.some(set => set.weight || set.reps);
      });
    }
  }

  // Get progress bar color: red = not started, yellow = in progress, green = complete/visited
  function getSectionColor(sectionIndex) {
    if (visitedSections.has(sectionIndex) || isSectionComplete(sectionIndex)) return '#4CAF50'; // green
    if (isSectionStarted(sectionIndex)) return '#FFC107'; // yellow
    return '#ef5350'; // red
  }

  // Check if an exercise in full tracking mode has data (at least one set filled)
  function hasExerciseData(exerciseId) {
    const log = exerciseLogs[exerciseId];
    if (!log || !log.sets) return false;
    return log.sets.some(set => set.weight || set.reps);
  }

  // Count incomplete exercises in current section
  function getIncompleteCount() {
    const section = getCurrentSection();
    if (!section || !section.exercises) return 0;

    if (section.mode === 'checkbox') {
      return section.exercises.filter(ex =>
        !exerciseCompleted[`${section.name}-${ex.exerciseId}`]
      ).length;
    } else {
      return section.exercises.filter(ex => {
        const log = exerciseLogs[ex.exerciseId];
        if (!log || !log.sets) return true;
        return !log.sets.some(set => set.weight || set.reps);
      }).length;
    }
  }

  // Mark all incomplete exercises as DNC
  function markIncompleteAsDNC() {
    const section = getCurrentSection();
    if (!section || !section.exercises) return;

    if (section.mode === 'checkbox') {
      section.exercises.forEach(ex => {
        const key = `${section.name}-${ex.exerciseId}`;
        if (!exerciseCompleted[key]) {
          exerciseCompleted[key] = true;
        }
      });
      // Trigger reactivity
      exerciseCompleted = { ...exerciseCompleted };
    } else {
      section.exercises.forEach(ex => {
        const log = exerciseLogs[ex.exerciseId];
        if (log && log.sets) {
          // Mark empty sets as DNC
          log.sets.forEach(set => {
            if (!set.weight && !set.reps) {
              set.reps = 'DNC';
              set.weight = 'DNC';
              set.notes = 'Did not complete';
            }
          });
        }
      });
      // Trigger reactivity
      exerciseLogs = { ...exerciseLogs };
    }
  }

  // Add another set to an exercise
  function addSet(exerciseId) {
    const log = exerciseLogs[exerciseId];
    if (log && log.sets) {
      log.sets.push({ reps: '', weight: '', rir: '', notes: '' });
      exerciseLogs = { ...exerciseLogs };
    }
  }

  // Remove a set from an exercise (keep at least 1)
  function removeSet(exerciseId, setIndex) {
    const log = exerciseLogs[exerciseId];
    if (log && log.sets && log.sets.length > 1) {
      log.sets.splice(setIndex, 1);
      exerciseLogs = { ...exerciseLogs };
    }
  }

  function nextSection() {
    if (currentSectionIndex < getTotalSections() - 1) {
      visitedSections.add(currentSectionIndex);
      visitedSections = new Set(visitedSections); // trigger reactivity
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

    // Mark current section as visited
    visitedSections.add(currentSectionIndex);

    // Save all exercise logs to Firestore - one entry per SET
    const logPromises = [];
    const loggedAt = new Date();

    for (const section of day.sections || []) {
      for (const exercise of section.exercises || []) {
        const log = exerciseLogs[exercise.exerciseId];

        if (log && log.sets) {
          log.sets.forEach((set, setIndex) => {
            // Only save sets that have data
            if (set.weight || set.reps) {
              // Build custom req input data if any
              const customReqData = customReqInputs[exercise.exerciseId] || {};

              logPromises.push(addDoc(collection(db, 'workoutLogs'), {
                userId: currentUserId,
                programId: program.id,
                programName: program.name,
                dayName: day.name,
                exerciseId: exercise.exerciseId,
                exerciseName: exercise.name,
                setNumber: setIndex + 1,
                totalSets: log.sets.length,
                reps: set.reps,
                weight: set.weight,
                rir: set.rir,
                notes: set.notes,
                targetReps: log.targetReps,
                targetWeight: log.targetWeight,
                targetRir: log.targetRir,
                repsMetric: exercise.repsMetric || 'reps',
                weightMetric: exercise.weightMetric || 'weight',
                customReqInputs: Object.keys(customReqData).length > 0 ? customReqData : null,
                loggedAt: loggedAt
              }));
            }
          });
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

  <!-- Progress indicator: red = not started, yellow = in progress, green = complete -->
  <div style="display: flex; gap: 5px; margin-bottom: 10px;">
    {#each day.sections || [] as section, i}
      <div
        style="flex: 1; height: 12px; border-radius: 6px; background: {getSectionColor(i)}; opacity: {i === currentSectionIndex ? 1 : 0.6}; transition: all 0.3s; {i === currentSectionIndex ? 'box-shadow: 0 2px 6px rgba(0,0,0,0.25);' : ''} cursor: pointer;"
        onclick={() => currentSectionIndex = i}
      ></div>
    {/each}
  </div>
  <div style="display: flex; justify-content: center; gap: 15px; font-size: 0.75em; color: #888; margin-bottom: 15px;">
    <span><span style="display: inline-block; width: 10px; height: 10px; background: #ef5350; border-radius: 50%; margin-right: 4px;"></span>Not started</span>
    <span><span style="display: inline-block; width: 10px; height: 10px; background: #FFC107; border-radius: 50%; margin-right: 4px;"></span>In progress</span>
    <span><span style="display: inline-block; width: 10px; height: 10px; background: #4CAF50; border-radius: 50%; margin-right: 4px;"></span>Complete</span>
  </div>

  <!-- Current section -->
  {#if getCurrentSection()}
    <div style="background: #f5f5f5; padding: 15px; border-radius: 10px; margin-bottom: 20px;">
      <div style="display: flex; justify-content: space-between; align-items: start;">
        <div>
          <h2 style="margin: 0 0 5px 0;">{getCurrentSection().name}</h2>
          <p style="color: #888; margin: 0;">Section {currentSectionIndex + 1} of {getTotalSections()}</p>
        </div>
        {#if isSectionStarted(currentSectionIndex) && !isSectionComplete(currentSectionIndex)}
          <button
            onclick={markIncompleteAsDNC}
            style="background: #f5f5f5; border: 1px solid #ccc; padding: 8px 12px; border-radius: 6px; font-size: 0.8em; color: #666; cursor: pointer;"
            title="Mark all incomplete exercises as 'Did Not Complete'"
          >
            Skip {getIncompleteCount()} remaining
          </button>
        {/if}
      </div>
    </div>

    <!-- Exercises in this section -->
    {#if isCheckboxSection(getCurrentSection())}
      <!-- Checkbox-only mode: show all exercises with just checkboxes -->
      {#each getCurrentSection().exercises || [] as exercise}
        {@const isComplete = isExerciseComplete(getCurrentSection().name, exercise.exerciseId)}
        {@const showIncompleteHint = isSectionStarted(currentSectionIndex) && !isComplete}
        <div
          style="border: 2px solid {isComplete ? '#4CAF50' : showIncompleteHint ? '#FFC107' : '#ddd'}; padding: 15px; margin-bottom: 10px; border-radius: 8px; background: {isComplete ? '#f1f8e9' : showIncompleteHint ? '#fffde7' : 'white'}; cursor: pointer; transition: all 0.2s;"
          onclick={() => toggleExerciseComplete(getCurrentSection().name, exercise.exerciseId)}
        >
          <div style="display: flex; align-items: center; gap: 15px;">
            <div style="width: 30px; height: 30px; border: 2px solid {isExerciseComplete(getCurrentSection().name, exercise.exerciseId) ? '#4CAF50' : '#ccc'}; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: {isExerciseComplete(getCurrentSection().name, exercise.exerciseId) ? '#4CAF50' : 'white'}; flex-shrink: 0;">
              {#if isExerciseComplete(getCurrentSection().name, exercise.exerciseId)}
                <span style="color: white; font-size: 1.2em;">✓</span>
              {/if}
            </div>
            <div style="flex: 1;">
              <h3 style="margin: 0 0 5px 0; {isExerciseComplete(getCurrentSection().name, exercise.exerciseId) ? 'text-decoration: line-through; color: #888;' : ''}">{exercise.name}</h3>
              {#if exercise.sets || exercise.reps}
                <p style="color: #888; margin: 0; font-size: 0.9em;">
                  {#if exercise.sets}{exercise.sets} sets{/if}
                  {#if exercise.reps} × {exercise.reps}{/if}
                  {#if exercise.notes} — {exercise.notes}{/if}
                </p>
              {/if}
              {#if exercise.customReqs && exercise.customReqs.length > 0}
                <div style="margin-top: 5px;">
                  {#each exercise.customReqs as req}
                    {#if req.name && req.value}
                      <span style="display: inline-block; background: #fff3e0; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; margin-right: 5px;">
                        {req.name}: {req.value}
                      </span>
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    {:else}
      <!-- Full tracking mode: targets at top, inputs below -->
      {#each getCurrentSection().exercises || [] as exercise}
        {@const history = exerciseHistory[exercise.exerciseId]}
        {@const log = exerciseLogs[exercise.exerciseId]}
        {@const hasData = hasExerciseData(exercise.exerciseId)}
        {@const showIncompleteHint = isSectionStarted(currentSectionIndex) && !hasData}
        {@const repsLabel = exercise.repsMetric === 'distance' ? '' : 'reps'}
        {@const weightLabel = exercise.weightMetric === 'time' ? '' : 'lbs'}
        {@const repsHeader = exercise.repsMetric === 'distance' ? 'Distance' : 'Reps'}
        {@const weightHeader = exercise.weightMetric === 'time' ? 'Time' : 'Weight'}
        <div style="border: 2px solid {hasData ? '#4CAF50' : showIncompleteHint ? '#FFC107' : '#ddd'}; padding: 15px; margin-bottom: 15px; border-radius: 8px; background: {showIncompleteHint ? '#fffde7' : 'white'}; transition: all 0.3s;">

          <!-- Exercise name -->
          <h3 style="margin: 0 0 10px 0; font-size: 1.1em;">{exercise.name}</h3>

          <!-- Target details box -->
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 15px; border-radius: 8px; margin-bottom: 12px;">
            <div style="font-size: 1.2em; font-weight: bold; margin-bottom: 5px;">
              {exercise.sets || '?'} sets × {exercise.reps || '?'} {repsLabel}
              {#if exercise.weight} @ {exercise.weight} {weightLabel}{/if}
            </div>
            {#if exercise.rir}
              <div style="font-size: 0.9em; opacity: 0.9;">Target RIR: {exercise.rir}</div>
            {/if}
            {#if exercise.notes}
              <div style="font-size: 0.85em; opacity: 0.85; margin-top: 5px; font-style: italic;">{exercise.notes}</div>
            {/if}
          </div>

          <!-- Custom requirements with client input -->
          {#if exercise.customReqs && exercise.customReqs.length > 0}
            <div style="background: #fff8e1; padding: 10px 12px; border-radius: 8px; margin-bottom: 12px;">
              <div style="font-size: 0.8em; color: #666; margin-bottom: 8px; font-weight: 500;">Custom Requirements</div>
              {#each exercise.customReqs as req, reqIndex}
                {#if req.name && req.value}
                  <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                    <span style="font-size: 0.85em; color: #333; min-width: 80px;"><strong>{req.name}:</strong></span>
                    <span style="font-size: 0.85em; color: #888; padding: 4px 8px; background: white; border-radius: 4px;">{req.value}</span>
                    {#if req.clientInput}
                      <input
                        type="text"
                        placeholder="Your value..."
                        value={customReqInputs[exercise.exerciseId]?.[reqIndex] || ''}
                        oninput={(e) => {
                          if (!customReqInputs[exercise.exerciseId]) customReqInputs[exercise.exerciseId] = {};
                          customReqInputs[exercise.exerciseId][reqIndex] = e.target.value;
                          customReqInputs = { ...customReqInputs };
                        }}
                        style="flex: 1; padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 0.85em; max-width: 120px;"
                      />
                    {/if}
                  </div>
                {/if}
              {/each}
            </div>
          {/if}

          <!-- PR and History Button -->
          {#if history && (history.lastTwo?.length > 0 || history.pr)}
            <button
              onclick={() => openHistoryModal(exercise.exerciseId, exercise.name)}
              style="display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; margin-bottom: 12px; background: #f8f9fa; border: 1px solid #e0e0e0; border-radius: 8px; cursor: pointer; text-align: left;"
            >
              {#if history.pr}
                <span style="background: linear-gradient(135deg, #ff9800, #f57c00); color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8em; font-weight: bold;">PR: {history.pr.weight} lbs</span>
              {/if}
              <span style="color: #666; font-size: 0.85em; flex: 1;">
                {#if history.lastTwo?.length > 0}Last: {formatDate(history.lastTwo[0].loggedAt)}{/if}
              </span>
              <span style="color: #999; font-size: 0.9em;">View →</span>
            </button>
          {/if}

          <!-- Per-set input fields -->
          {#if log && log.sets}
            <div style="background: #fafafa; padding: 12px; border-radius: 8px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <p style="margin: 0; font-size: 0.85em; color: #666; font-weight: 500;">Log each set:</p>
                <button
                  onclick={() => addSet(exercise.exerciseId)}
                  style="background: #e8f5e9; border: 1px solid #4CAF50; color: #4CAF50; padding: 4px 10px; border-radius: 4px; font-size: 0.8em; cursor: pointer;"
                >
                  + Add Set
                </button>
              </div>

              <!-- Column headers -->
              <div style="display: grid; grid-template-columns: 40px 1fr 1fr 60px 1fr 30px; gap: 6px; margin-bottom: 6px; padding: 0 2px;">
                <span style="font-size: 0.7em; color: #999; text-transform: uppercase;">Set</span>
                <span style="font-size: 0.7em; color: #999; text-transform: uppercase;">{repsHeader}</span>
                <span style="font-size: 0.7em; color: #999; text-transform: uppercase;">{weightHeader}</span>
                <span style="font-size: 0.7em; color: #999; text-transform: uppercase;">RIR</span>
                <span style="font-size: 0.7em; color: #999; text-transform: uppercase;">Notes</span>
                <span></span>
              </div>

              <!-- Set rows -->
              {#each log.sets as set, setIndex}
                {@const setHasData = set.reps || set.weight}
                <div style="display: grid; grid-template-columns: 40px 1fr 1fr 60px 1fr 30px; gap: 6px; margin-bottom: 8px; align-items: center; background: {setHasData ? '#e8f5e9' : 'white'}; padding: 8px; border-radius: 6px; border: 1px solid {setHasData ? '#c8e6c9' : '#e0e0e0'};">
                  <!-- Set number -->
                  <div style="font-weight: bold; color: #667eea; text-align: center;">{setIndex + 1}</div>

                  <!-- Reps/Distance -->
                  <input
                    type="text"
                    bind:value={set.reps}
                    placeholder={log.targetReps || (exercise.repsMetric === 'distance' ? 'dist' : '0')}
                    style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ddd; border-radius: 4px; font-size: 0.95em; text-align: center; background: white;"
                  />

                  <!-- Weight/Time -->
                  <input
                    type="text"
                    bind:value={set.weight}
                    placeholder={log.targetWeight || (exercise.weightMetric === 'time' ? 'time' : 'lbs')}
                    style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ddd; border-radius: 4px; font-size: 0.95em; text-align: center; background: white;"
                  />

                  <!-- RIR -->
                  <input
                    type="text"
                    bind:value={set.rir}
                    placeholder={log.targetRir || '0'}
                    style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ddd; border-radius: 4px; font-size: 0.95em; text-align: center; background: white;"
                  />

                  <!-- Notes button -->
                  <button
                    onclick={() => openNotesModal(exercise.exerciseId, setIndex, exercise.name)}
                    style="width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid {set.notes ? '#4CAF50' : '#ddd'}; border-radius: 4px; font-size: 0.85em; background: {set.notes ? '#e8f5e9' : 'white'}; cursor: pointer; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                  >
                    {set.notes || '+ Note'}
                  </button>

                  <!-- Remove button -->
                  {#if log.sets.length > 1}
                    <button
                      onclick={() => removeSet(exercise.exerciseId, setIndex)}
                      style="background: none; border: none; color: #999; cursor: pointer; font-size: 1.2em; padding: 0;"
                      title="Remove set"
                    >×</button>
                  {:else}
                    <div></div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}

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

<!-- Notes Modal -->
{#if notesModal.open}
  <div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px;" onclick={closeNotesModal}>
    <div style="background: white; border-radius: 12px; width: 100%; max-width: 500px; max-height: 80vh; display: flex; flex-direction: column;" onclick={(e) => e.stopPropagation()}>
      <div style="padding: 15px 20px; border-bottom: 1px solid #eee;">
        <h3 style="margin: 0;">{notesModal.exerciseName} - Set {notesModal.setIndex + 1}</h3>
        <p style="margin: 5px 0 0 0; color: #888; font-size: 0.9em;">Add notes for this set</p>
      </div>
      <div style="padding: 20px; flex: 1;">
        <textarea
          value={getNotesValue()}
          oninput={(e) => setNotesValue(e.target.value)}
          placeholder="Enter notes... (form cues, how it felt, adjustments, etc.)"
          style="width: 100%; height: 150px; padding: 12px; box-sizing: border-box; border: 1px solid #ddd; border-radius: 8px; font-size: 1em; resize: vertical; font-family: inherit;"
        ></textarea>
      </div>
      <div style="padding: 15px 20px; border-top: 1px solid #eee; display: flex; justify-content: flex-end; gap: 10px;">
        <button onclick={closeNotesModal} style="padding: 10px 20px; background: #4CAF50; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 1em;">
          Done
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- History Modal -->
{#if historyModal.open}
  {@const history = exerciseHistory[historyModal.exerciseId]}
  <div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px;" onclick={closeHistoryModal}>
    <div style="background: white; border-radius: 12px; width: 100%; max-width: 500px; max-height: 80vh; overflow-y: auto;" onclick={(e) => e.stopPropagation()}>
      <div style="padding: 15px 20px; border-bottom: 1px solid #eee; position: sticky; top: 0; background: white;">
        <h3 style="margin: 0;">{historyModal.exerciseName}</h3>
        <p style="margin: 5px 0 0 0; color: #888; font-size: 0.9em;">PR & Recent History</p>
      </div>
      <div style="padding: 20px;">
        {#if history?.pr}
          <div style="background: linear-gradient(135deg, #ff9800 0%, #f57c00 100%); color: white; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
            <div style="font-weight: bold; font-size: 0.9em; opacity: 0.9;">Personal Record</div>
            <div style="font-size: 1.5em; font-weight: bold; margin: 5px 0;">{history.pr.weight} lbs × {history.pr.reps} reps</div>
            <div style="font-size: 0.85em; opacity: 0.9;">Set on {formatDate(history.pr.date)}</div>
          </div>
        {/if}

        {#if history?.lastTwo?.length > 0}
          <div style="font-weight: 600; color: #333; margin-bottom: 10px;">Recent Sessions</div>
          {#each history.lastTwo as entry}
            <div style="background: #f8f9fa; padding: 12px; border-radius: 8px; margin-bottom: 10px; border-left: 3px solid #667eea;">
              <div style="color: #888; font-size: 0.8em; margin-bottom: 5px;">{formatDate(entry.loggedAt)}</div>
              <div style="font-size: 1.1em; color: #333;">
                <strong>{entry.reps || '-'}</strong> reps @ <strong>{entry.weight || '-'}</strong> lbs
                {#if entry.rir}<span style="color: #888; font-size: 0.9em;"> (RIR: {entry.rir})</span>{/if}
              </div>
              {#if entry.notes}
                <div style="color: #666; font-style: italic; margin-top: 5px; font-size: 0.9em;">"{entry.notes}"</div>
              {/if}
            </div>
          {/each}
        {:else}
          <p style="color: #888; text-align: center;">No previous sessions recorded.</p>
        {/if}
      </div>
      <div style="padding: 15px 20px; border-top: 1px solid #eee; display: flex; justify-content: flex-end;">
        <button onclick={closeHistoryModal} style="padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer;">
          Close
        </button>
      </div>
    </div>
  </div>
{/if}
