<script>
  import { page } from '$app/stores';
  import { auth, db } from '$lib/firebase.js';
  import { doc, onSnapshot, getDoc, collection, addDoc, query, where, orderBy, limit, getDocs, updateDoc } from 'firebase/firestore';
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
  let notesModal = $state({ open: false, workoutExerciseId: null, setIndex: null, exerciseName: '' });

  // History modal state
  let historyModal = $state({ open: false, exerciseId: null, exerciseName: '' });

  // Active set index per exercise (for progressive disclosure in full tracking mode)
  // Structure: { workoutExerciseId: activeSetIndex }
  let activeSetIndices = $state({});

  // Backfill missing IDs in days array, returns true if any were added
  function backfillIds(days) {
    if (!days) return false;
    let changed = false;
    for (const day of days) {
      if (!day.workoutTemplateId) { day.workoutTemplateId = crypto.randomUUID(); changed = true; }
      for (const section of day.sections || []) {
        if (!section.sectionTemplateId) { section.sectionTemplateId = crypto.randomUUID(); changed = true; }
        for (const exercise of section.exercises || []) {
          if (!exercise.workoutExerciseId) { exercise.workoutExerciseId = crypto.randomUUID(); changed = true; }
        }
      }
    }
    return changed;
  }

  async function openHistoryModal(exerciseId, exerciseName) {
    // Clear stale data immediately before opening modal
    exerciseHistory = {
      ...exerciseHistory,
      [exerciseId]: { entries: [], lastSession: null, e1rm: null, repRanges: { '1-5': null, '6-8': null, '9-12': null } }
    };
    historyModal = { open: true, exerciseId, exerciseName };
    // Refresh history for this exercise from Firestore to ensure no stale/orphan PRs
    await refreshExerciseHistory(exerciseId);
  }

  async function refreshExerciseHistory(exerciseId) {
    if (!currentUserId) return;

    try {
      const logsQuery = query(
        collection(db, 'workoutLogs'),
        where('userId', '==', currentUserId),
        where('exerciseId', '==', exerciseId),
        orderBy('loggedAt', 'desc'),
        limit(10)
      );

      const snapshot = await getDocs(logsQuery);
      const entries = snapshot.docs.map(d => d.data());

      // If no entries exist, ensure clean state
      if (entries.length === 0) {
        exerciseHistory = {
          ...exerciseHistory,
          [exerciseId]: { entries: [], lastSession: null, e1rm: null, repRanges: { '1-5': null, '6-8': null, '9-12': null } }
        };
        return;
      }

      // Calculate estimated 1RM using Epley formula
      let best1RM = null;
      const repRanges = { '1-5': null, '6-8': null, '9-12': null };

      entries.forEach(entry => {
        const weight = parseFloat(entry.weight) || 0;
        const reps = parseInt(entry.reps) || 0;
        if (weight <= 0 || reps <= 0) return;

        const e1rm = weight * (1 + reps / 30);
        if (!best1RM || e1rm > best1RM.e1rm) {
          best1RM = { e1rm: Math.round(e1rm), weight, reps, date: entry.loggedAt, notes: entry.notes };
        }

        let range = null;
        if (reps >= 1 && reps <= 5) range = '1-5';
        else if (reps >= 6 && reps <= 8) range = '6-8';
        else if (reps >= 9 && reps <= 12) range = '9-12';

        if (range && (!repRanges[range] || weight > repRanges[range].weight)) {
          repRanges[range] = { weight, reps, date: entry.loggedAt, notes: entry.notes };
        }
      });

      // Find most recent session
      let lastSession = null;
      if (entries.length > 0 && entries[0].completedWorkoutId) {
        const sessionId = entries[0].completedWorkoutId;
        const sessionLogs = entries.filter(e => e.completedWorkoutId === sessionId);
        sessionLogs.sort((a, b) => (a.setNumber || 1) - (b.setNumber || 1));
        lastSession = {
          date: entries[0].loggedAt,
          sets: sessionLogs.map(log => ({
            setNumber: log.setNumber || 1,
            reps: log.reps,
            weight: log.weight,
            rir: log.rir,
            notes: log.notes,
            customInputs: log.customInputs
          }))
        };
      }

      // Update exerciseHistory for this specific exercise
      exerciseHistory = {
        ...exerciseHistory,
        [exerciseId]: {
          entries,
          lastSession,
          e1rm: best1RM,
          repRanges
        }
      };
    } catch (e) {
      console.log('Could not refresh exercise history:', e.message || e);
      // On error, ensure clean state
      exerciseHistory = {
        ...exerciseHistory,
        [exerciseId]: { entries: [], lastSession: null, e1rm: null, repRanges: { '1-5': null, '6-8': null, '9-12': null } }
      };
    }
  }

  function closeHistoryModal() {
    historyModal = { open: false, exerciseId: null, exerciseName: '' };
  }

  function openNotesModal(workoutExerciseId, setIndex, exerciseName) {
    notesModal = { open: true, workoutExerciseId, setIndex, exerciseName };
  }

  function closeNotesModal() {
    notesModal = { open: false, workoutExerciseId: null, setIndex: null, exerciseName: '' };
  }

  function getNotesValue() {
    if (!notesModal.workoutExerciseId) return '';
    return exerciseLogs[notesModal.workoutExerciseId]?.sets?.[notesModal.setIndex]?.notes || '';
  }

  function setNotesValue(value) {
    if (notesModal.workoutExerciseId && exerciseLogs[notesModal.workoutExerciseId]?.sets?.[notesModal.setIndex]) {
      exerciseLogs[notesModal.workoutExerciseId].sets[notesModal.setIndex].notes = value;
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
        const data = snapshot.data();

        // Backfill missing IDs in publishedDays and persist to Firestore
        if (data.publishedDays && backfillIds(data.publishedDays)) {
          updateDoc(doc(db, 'programs', programId), { publishedDays: data.publishedDays });
        }

        program = { id: snapshot.id, ...data };
        // Use published version for clients, fall back to days if not published
        const programDays = program.publishedDays || program.days;
        day = programDays?.[dayIndex];

        // Initialize exercise logs for all exercises
        if (day?.sections) {
          const logs = {};
          const completed = {};
          const setIndices = {};
          for (const section of day.sections) {
            for (const exercise of section.exercises || []) {
              if (section.mode === 'checkbox') {
                completed[exercise.workoutExerciseId] = false;
              } else {
                // Create per-set tracking using workoutExerciseId for uniqueness
                const numSets = parseInt(exercise.sets) || 3;
                logs[exercise.workoutExerciseId] = {
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
                // Initialize active set index to 0 (first set)
                setIndices[exercise.workoutExerciseId] = 0;
              }
            }
          }
          exerciseLogs = logs;
          exerciseCompleted = completed;
          activeSetIndices = setIndices;

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

        // Get logged entries for this exercise
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

          // Calculate estimated 1RM using Epley formula: weight × (1 + reps/30)
          let best1RM = null;
          // Rep-range PRs: track best weight for each range
          const repRanges = {
            '1-5': null,   // strength
            '6-8': null,   // hypertrophy-strength
            '9-12': null   // hypertrophy
          };

          entries.forEach(entry => {
            const weight = parseFloat(entry.weight) || 0;
            const reps = parseInt(entry.reps) || 0;
            if (weight <= 0 || reps <= 0) return;

            // Calculate estimated 1RM
            const e1rm = weight * (1 + reps / 30);
            if (!best1RM || e1rm > best1RM.e1rm) {
              best1RM = { e1rm: Math.round(e1rm), weight, reps, date: entry.loggedAt, notes: entry.notes };
            }

            // Categorize by rep range
            let range = null;
            if (reps >= 1 && reps <= 5) range = '1-5';
            else if (reps >= 6 && reps <= 8) range = '6-8';
            else if (reps >= 9 && reps <= 12) range = '9-12';

            if (range) {
              if (!repRanges[range] || weight > repRanges[range].weight) {
                repRanges[range] = { weight, reps, date: entry.loggedAt, notes: entry.notes };
              }
            }
          });

          // Find most recent session for this exercise
          let lastSession = null;
          if (entries.length > 0 && entries[0].completedWorkoutId) {
            const sessionId = entries[0].completedWorkoutId;
            const sessionLogs = entries.filter(e => e.completedWorkoutId === sessionId);
            sessionLogs.sort((a, b) => (a.setNumber || 1) - (b.setNumber || 1));
            lastSession = {
              date: entries[0].loggedAt,
              sets: sessionLogs.map(log => ({
                setNumber: log.setNumber || 1,
                reps: log.reps,
                weight: log.weight,
                rir: log.rir,
                notes: log.notes,
                customInputs: log.customInputs
              }))
            };
          }

          history[exerciseId] = {
            entries: entries,
            lastSession: lastSession,
            e1rm: best1RM,
            repRanges: repRanges
          };
        } catch (e) {
          console.log('Could not load exercise history:', e.message || e);
          history[exerciseId] = { entries: [], lastTwo: [], e1rm: null, repRanges: {} };
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

  function toggleExerciseComplete(workoutExerciseId) {
    exerciseCompleted[workoutExerciseId] = !exerciseCompleted[workoutExerciseId];
  }

  function isExerciseComplete(workoutExerciseId) {
    return exerciseCompleted[workoutExerciseId] || false;
  }

  // Check if a section is complete
  function isSectionComplete(sectionIndex) {
    const section = day?.sections?.[sectionIndex];
    if (!section || !section.exercises || section.exercises.length === 0) return false;

    if (section.mode === 'checkbox') {
      // All exercises must be checked
      return section.exercises.every(ex =>
        exerciseCompleted[ex.workoutExerciseId]
      );
    } else {
      // For full tracking, at least one set with reps or weight for all exercises
      return section.exercises.every(ex => {
        const log = exerciseLogs[ex.workoutExerciseId];
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
        exerciseCompleted[ex.workoutExerciseId]
      );
    } else {
      return section.exercises.some(ex => {
        const log = exerciseLogs[ex.workoutExerciseId];
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
  function hasExerciseData(workoutExerciseId) {
    const log = exerciseLogs[workoutExerciseId];
    if (!log || !log.sets) return false;
    return log.sets.some(set => set.weight || set.reps);
  }

  // Check if an exercise is fully completed (ALL sets have all required fields filled)
  // Uses the same logic as getSetCompletionState for consistency with dot indicators
  function isExerciseFullyCompleted(workoutExerciseId) {
    const log = exerciseLogs[workoutExerciseId];
    if (!log || !log.sets || log.sets.length === 0) return false;
    return log.sets.every(set => getSetCompletionState(set) === 'completed');
  }

  // Count incomplete exercises in current section
  function getIncompleteCount() {
    const section = getCurrentSection();
    if (!section || !section.exercises) return 0;

    if (section.mode === 'checkbox') {
      return section.exercises.filter(ex =>
        !exerciseCompleted[ex.workoutExerciseId]
      ).length;
    } else {
      return section.exercises.filter(ex => {
        const log = exerciseLogs[ex.workoutExerciseId];
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
        if (!exerciseCompleted[ex.workoutExerciseId]) {
          exerciseCompleted[ex.workoutExerciseId] = true;
        }
      });
      // Trigger reactivity
      exerciseCompleted = { ...exerciseCompleted };
    } else {
      section.exercises.forEach(ex => {
        const log = exerciseLogs[ex.workoutExerciseId];
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
  function addSet(workoutExerciseId) {
    const log = exerciseLogs[workoutExerciseId];
    if (log && log.sets) {
      log.sets.push({ reps: '', weight: '', rir: '', notes: '' });
      exerciseLogs = { ...exerciseLogs };
      // Navigate to the newly added set
      activeSetIndices[workoutExerciseId] = log.sets.length - 1;
      activeSetIndices = { ...activeSetIndices };
    }
  }

  // Remove a set from an exercise (keep at least 1)
  function removeSet(workoutExerciseId, setIndex) {
    const log = exerciseLogs[workoutExerciseId];
    if (log && log.sets && log.sets.length > 1) {
      log.sets.splice(setIndex, 1);
      exerciseLogs = { ...exerciseLogs };
      // Adjust active set index if needed
      const activeIdx = activeSetIndices[workoutExerciseId] || 0;
      if (activeIdx >= log.sets.length) {
        activeSetIndices[workoutExerciseId] = log.sets.length - 1;
        activeSetIndices = { ...activeSetIndices };
      }
    }
  }

  // Get active set index for an exercise
  function getActiveSetIndex(workoutExerciseId) {
    return activeSetIndices[workoutExerciseId] ?? 0;
  }

  // Set active set index (for tap to activate)
  function setActiveSetIndex(workoutExerciseId, index) {
    const log = exerciseLogs[workoutExerciseId];
    if (log && log.sets && index >= 0 && index < log.sets.length) {
      activeSetIndices[workoutExerciseId] = index;
      activeSetIndices = { ...activeSetIndices };
    }
  }

  // Navigate to next set (for swipe left)
  function nextSet(workoutExerciseId) {
    const log = exerciseLogs[workoutExerciseId];
    if (!log || !log.sets) return;
    const currentIdx = activeSetIndices[workoutExerciseId] ?? 0;
    if (currentIdx < log.sets.length - 1) {
      activeSetIndices[workoutExerciseId] = currentIdx + 1;
      activeSetIndices = { ...activeSetIndices };
    }
  }

  // Navigate to previous set (for swipe right)
  function prevSet(workoutExerciseId) {
    const currentIdx = activeSetIndices[workoutExerciseId] ?? 0;
    if (currentIdx > 0) {
      activeSetIndices[workoutExerciseId] = currentIdx - 1;
      activeSetIndices = { ...activeSetIndices };
    }
  }

  // Get set completion state: 'untouched' | 'incomplete' | 'completed'
  // Required fields: reps, weight, rir (notes excluded)
  function getSetCompletionState(set) {
    if (!set) return 'untouched';
    const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== '';
    const repsHas = hasValue(set.reps);
    const weightHas = hasValue(set.weight);
    const rirHas = hasValue(set.rir);
    const filledCount = [repsHas, weightHas, rirHas].filter(Boolean).length;
    if (filledCount === 0) return 'untouched';
    if (filledCount === 3) return 'completed';
    return 'incomplete';
  }

  // Get dot color based on completion state
  function getDotColor(state) {
    if (state === 'completed') return '#4CAF50';
    if (state === 'incomplete') return '#FFC107';
    return '#e0e0e0';
  }

  // Notes expanded state per exercise+set
  let notesExpanded = $state({});

  // Expanded exercise per section (accordion behavior)
  // Structure: { sectionIndex: workoutExerciseId }
  let expandedExercise = $state({});

  function isExerciseExpanded(sectionIndex, workoutExerciseId) {
    return expandedExercise[sectionIndex] === workoutExerciseId;
  }

  function toggleExerciseExpanded(sectionIndex, workoutExerciseId) {
    if (expandedExercise[sectionIndex] === workoutExerciseId) {
      // Collapse if already expanded (optional behavior)
      expandedExercise[sectionIndex] = null;
    } else {
      // Expand this one, collapse others
      expandedExercise[sectionIndex] = workoutExerciseId;
    }
    expandedExercise = { ...expandedExercise };
  }

  // Get compact prescription summary (main line, excludes RIR)
  function getPrescriptionSummary(exercise) {
    const parts = [];
    if (exercise.sets) {
      if (exercise.reps) {
        parts.push(`${exercise.sets} x ${exercise.reps}`);
      } else {
        const setWord = parseInt(exercise.sets) === 1 ? 'set' : 'sets';
        parts.push(`${exercise.sets} ${setWord}`);
      }
    }
    if (exercise.weight) parts.push(`@ ${exercise.weight}`);
    return parts.join(' ') || 'No prescription';
  }

  function isNotesExpanded(workoutExerciseId, setIndex) {
    return notesExpanded[`${workoutExerciseId}_${setIndex}`] || false;
  }

  function toggleNotesExpanded(workoutExerciseId, setIndex) {
    const key = `${workoutExerciseId}_${setIndex}`;
    notesExpanded[key] = !notesExpanded[key];
    notesExpanded = { ...notesExpanded };
  }

  // Stepper functions for numeric inputs
  function stepValue(workoutExerciseId, setIndex, field, delta) {
    const log = exerciseLogs[workoutExerciseId];
    if (!log || !log.sets || !log.sets[setIndex]) return;
    const current = parseFloat(log.sets[setIndex][field]) || 0;
    let newVal = current + delta;
    if (field === 'rir') newVal = Math.max(0, Math.min(10, newVal));
    else newVal = Math.max(0, newVal);
    log.sets[setIndex][field] = String(newVal);
    exerciseLogs = { ...exerciseLogs };
  }

  // Swipe handler state tracking (per exercise)
  let swipeState = $state({});

  // Swipe handlers for set navigation
  function handleSwipeStart(workoutExerciseId, e) {
    // Don't start swipe if target is an input/textarea/select/button
    const tag = e.target.tagName.toLowerCase();
    if (['input', 'textarea', 'select', 'button'].includes(tag)) return;

    const touch = e.touches ? e.touches[0] : e;
    swipeState[workoutExerciseId] = {
      startX: touch.clientX,
      startY: touch.clientY,
      swiping: true
    };
  }

  function handleSwipeMove(workoutExerciseId, e) {
    // Not strictly needed, but can be used for visual feedback later
  }

  function handleSwipeEnd(workoutExerciseId, e) {
    const state = swipeState[workoutExerciseId];
    if (!state || !state.swiping) return;

    const touch = e.changedTouches ? e.changedTouches[0] : e;
    const deltaX = touch.clientX - state.startX;
    const deltaY = touch.clientY - state.startY;

    // Reset swipe state
    swipeState[workoutExerciseId] = { swiping: false };

    // Ignore mostly-vertical gestures
    if (Math.abs(deltaY) > Math.abs(deltaX)) return;

    // Threshold for swipe detection (50px)
    const threshold = 50;
    if (Math.abs(deltaX) < threshold) return;

    // Swipe left (negative deltaX) → next set
    // Swipe right (positive deltaX) → previous set
    if (deltaX < -threshold) {
      nextSet(workoutExerciseId);
    } else if (deltaX > threshold) {
      prevSet(workoutExerciseId);
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

    const loggedAt = new Date();
    const workoutEndTime = new Date();
    const durationMinutes = Math.round((workoutEndTime - workoutStartTime) / 60000);

    // Get workoutTemplateId from the active day (publishedDays preferred)
    const sourceDay = (program.publishedDays || program.days)?.[parseInt($page.params.dayIndex)];
    const workoutTemplateId = sourceDay?.workoutTemplateId || day.workoutTemplateId || null;

    // Create workout session first to get its ID
    const sessionRef = await addDoc(collection(db, 'workoutSessions'), {
      userId: currentUserId,
      programId: program.id,
      programName: program.name,
      dayName: day.name,
      workoutTemplateId,
      startedAt: workoutStartTime,
      finishedAt: workoutEndTime,
      durationMinutes: durationMinutes
    });
    const completedWorkoutId = sessionRef.id;

    // Save all exercise logs to Firestore - one entry per SET
    const logPromises = [];

    for (const section of day.sections || []) {
      for (const exercise of section.exercises || []) {
        const log = exerciseLogs[exercise.workoutExerciseId];

        if (log && log.sets) {
          log.sets.forEach((set, setIndex) => {
            // Only save sets that have data
            if (set.weight || set.reps) {
              logPromises.push(addDoc(collection(db, 'workoutLogs'), {
                userId: currentUserId,
                programId: program.id,
                programName: program.name,
                dayName: day.name,
                completedWorkoutId: completedWorkoutId,
                workoutExerciseId: exercise.workoutExerciseId || null,
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
                customInputs: set.customInputs || null,
                loggedAt: loggedAt
              }));
            }
          });
        }
      }
    }

    await Promise.all(logPromises);

    goto(`/programs/${program.id}/summary?day=${$page.params.dayIndex}&duration=${durationMinutes}&session=${completedWorkoutId}`);
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
        {@const isComplete = isExerciseComplete(exercise.workoutExerciseId)}
        {@const showIncompleteHint = isSectionStarted(currentSectionIndex) && !isComplete}
        <div
          style="border: 2px solid {isComplete ? '#4CAF50' : showIncompleteHint ? '#FFC107' : '#ddd'}; padding: 15px; margin-bottom: 10px; border-radius: 8px; background: {isComplete ? '#f1f8e9' : showIncompleteHint ? '#fffde7' : 'white'}; cursor: pointer; transition: all 0.2s;"
          onclick={() => toggleExerciseComplete(exercise.workoutExerciseId)}
        >
          <div style="display: flex; align-items: center; gap: 15px;">
            <div style="width: 30px; height: 30px; border: 2px solid {isComplete ? '#4CAF50' : '#ccc'}; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: {isComplete ? '#4CAF50' : 'white'}; flex-shrink: 0;">
              {#if isComplete}
                <span style="color: white; font-size: 1.2em;">✓</span>
              {/if}
            </div>
            <div style="flex: 1;">
              <h3 style="margin: 0 0 5px 0; {isComplete ? 'text-decoration: line-through; color: #888;' : ''}">{exercise.name}</h3>
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
      <!-- Full tracking mode: collapsible exercise buckets (accordion) -->
      {#each getCurrentSection().exercises || [] as exercise, exIndex}
        {@const history = exerciseHistory[exercise.exerciseId]}
        {@const log = exerciseLogs[exercise.workoutExerciseId]}
        {@const hasData = hasExerciseData(exercise.workoutExerciseId)}
        {@const isCompleted = isExerciseFullyCompleted(exercise.workoutExerciseId)}
        {@const showIncompleteHint = isSectionStarted(currentSectionIndex) && !isCompleted}
        {@const repsLabel = exercise.repsMetric === 'distance' ? '' : 'reps'}
        {@const weightLabel = exercise.weightMetric === 'time' ? '' : 'lbs'}
        {@const repsHeader = exercise.repsMetric === 'distance' ? 'Distance' : 'Reps'}
        {@const weightHeader = exercise.weightMetric === 'time' ? 'Time' : 'Weight'}
        {@const nonInputReqs = (exercise.customReqs || []).filter(r => r.name && r.value && !r.clientInput)}
        {@const inputReqs = (exercise.customReqs || []).filter(r => r.name && r.value && r.clientInput)}
        {@const isExpanded = expandedExercise[currentSectionIndex] === exercise.workoutExerciseId}
        <div style="border: 2px solid {isCompleted ? '#4CAF50' : showIncompleteHint ? '#FFC107' : '#ddd'}; margin-bottom: 10px; border-radius: 8px; background: {isCompleted ? '#e8f5e9' : showIncompleteHint ? '#fffde7' : 'white'}; transition: all 0.3s; overflow: hidden;">

          {#if isExpanded}
            <!-- Expanded state: full-width banner replaces collapsed header -->
            <!-- Tapping banner opens history modal; chevron excluded via stopPropagation -->
            <div
              class="exercise-banner"
              style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 15px; position: relative; cursor: pointer; transition: filter 0.15s ease;"
              onclick={() => openHistoryModal(exercise.exerciseId, exercise.name)}
              role="button"
              tabindex="0"
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') openHistoryModal(exercise.exerciseId, exercise.name); }}
            >
              <!-- Chevron at top-right (collapse control) -->
              <button
                onclick={(e) => { e.stopPropagation(); toggleExerciseExpanded(currentSectionIndex, exercise.workoutExerciseId); }}
                style="position: absolute; top: 10px; right: 10px; background: rgba(255,255,255,0.15); border: none; cursor: pointer; font-size: 1.2em; color: white; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; z-index: 1;"
              >▲</button>

              <!-- Line 1: Title + history chevron + Tap for history hint (with right padding for collapse chevron) -->
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px; padding-right: 50px;">
                <span style="font-size: 1.1em; font-weight: bold;">{exercise.name}</span>
                <span style="color: rgba(255,255,255,0.5); font-size: 1em;">›</span>
                <span style="color: rgba(255,255,255,0.5); font-size: 0.85em; white-space: nowrap;">Tap for history</span>
              </div>
              <!-- Line 2: Prescription summary -->
              <div style="font-size: 0.95em; opacity: 0.95;">{getPrescriptionSummary(exercise)}</div>
              <!-- Line 3: RIR (if assigned) -->
              {#if exercise.rir}
                <div style="font-size: 0.9em; opacity: 0.9; margin-top: 4px;">RIR {exercise.rir}</div>
              {/if}
              <!-- Line 4: Notes (if present) -->
              {#if exercise.notes}
                <div style="font-size: 0.85em; opacity: 0.85; margin-top: 8px; font-style: italic; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 8px;">{exercise.notes}</div>
              {/if}
            </div>

            <!-- Logging UI content (below banner) -->
            <div style="padding: 15px;">

              <!-- Single-set view with swipe navigation -->
              {#if log && log.sets}
                {@const activeIdx = getActiveSetIndex(exercise.workoutExerciseId)}
                <div style="background: #fafafa; padding: 12px; border-radius: 8px;">
                  <!-- Active set (single set view with swipe handling) -->
                  {#if log.sets[activeIdx]}
                    {@const set = log.sets[activeIdx]}
                    {@const setIndex = activeIdx}
                    <div
                      style="background: white; border: 2px solid #667eea; border-radius: 8px; padding: 12px; margin-bottom: 6px; touch-action: pan-y;"
                      ontouchstart={(e) => handleSwipeStart(exercise.workoutExerciseId, e)}
                      ontouchend={(e) => handleSwipeEnd(exercise.workoutExerciseId, e)}
                      onmousedown={(e) => handleSwipeStart(exercise.workoutExerciseId, e)}
                      onmouseup={(e) => handleSwipeEnd(exercise.workoutExerciseId, e)}
                    >
                      <!-- Set header row: add (+) left, "Set" center, delete (x) right -->
                      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                        <!-- Green plus (add set) - left -->
                        <button
                          onclick={() => addSet(exercise.workoutExerciseId)}
                          style="background: none; border: none; color: #4CAF50; cursor: pointer; font-size: 1.5em; padding: 8px; min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center;"
                          title="Add set"
                        >+</button>

                        <!-- Center: "Set" label -->
                        <span style="font-weight: bold; color: #667eea; font-size: 1.1em;">Set</span>

                        <!-- Black x (delete set) - right -->
                        {#if log.sets.length > 1}
                          <button
                            onclick={() => removeSet(exercise.workoutExerciseId, setIndex)}
                            style="background: none; border: none; color: #000; cursor: pointer; font-size: 1.5em; padding: 8px; min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center;"
                            title="Remove set"
                          >×</button>
                        {:else}
                          <!-- Placeholder to maintain centering when delete not shown -->
                          <div style="min-width: 44px; min-height: 44px;"></div>
                        {/if}
                      </div>

                      <!-- Dot indicator -->
                      <div style="display: flex; justify-content: center; gap: 8px; margin-bottom: 10px;">
                        {#each log.sets as dotSet, dotIndex}
                          {@const completionState = getSetCompletionState(dotSet)}
                          {@const isActive = dotIndex === activeIdx}
                          <div style="width: {isActive ? '12px' : '10px'}; height: {isActive ? '12px' : '10px'}; border-radius: 50%; background: {getDotColor(completionState)}; {isActive ? 'box-shadow: 0 0 0 2px #667eea;' : ''} transition: all 0.2s;"></div>
                        {/each}
                      </div>

                      <!-- Vertical stacked inputs -->
                      <div style="display: flex; flex-direction: column; gap: 12px;">
                        <!-- Reps row -->
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0;">
                          <span style="font-weight: 500; color: #333;">{repsHeader}</span>
                          <div style="display: flex; align-items: center; gap: 12px;">
                            <button onclick={() => stepValue(exercise.workoutExerciseId, setIndex, 'reps', -1)} style="width: 44px; height: 44px; border: none; background: transparent; font-size: 1.5em; color: #667eea; cursor: pointer;">-</button>
                            <input
                              type="text"
                              value={set.reps}
                              oninput={(e) => { if (log.sets[setIndex]) { log.sets[setIndex].reps = e.target.value; exerciseLogs = { ...exerciseLogs }; } }}
                              placeholder={log.targetReps || '0'}
                              style="width: 60px; padding: 8px 0; border: none; background: transparent; font-size: 1.2em; text-align: center; outline: none; box-shadow: none !important; -webkit-appearance: none; appearance: none; border-radius: 0; text-decoration: none;"
                            />
                            <button onclick={() => stepValue(exercise.workoutExerciseId, setIndex, 'reps', 1)} style="width: 44px; height: 44px; border: none; background: transparent; font-size: 1.5em; color: #667eea; cursor: pointer;">+</button>
                          </div>
                        </div>

                        <!-- Weight row -->
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0;">
                          <span style="font-weight: 500; color: #333;">{weightHeader}</span>
                          <div style="display: flex; align-items: center; gap: 12px;">
                            <button onclick={() => stepValue(exercise.workoutExerciseId, setIndex, 'weight', -5)} style="width: 44px; height: 44px; border: none; background: transparent; font-size: 1.5em; color: #667eea; cursor: pointer;">-</button>
                            <input
                              type="text"
                              value={set.weight}
                              oninput={(e) => { if (log.sets[setIndex]) { log.sets[setIndex].weight = e.target.value; exerciseLogs = { ...exerciseLogs }; } }}
                              placeholder={log.targetWeight || '0'}
                              style="width: 60px; padding: 8px 0; border: none; background: transparent; font-size: 1.2em; text-align: center; outline: none; box-shadow: none !important; -webkit-appearance: none; appearance: none; border-radius: 0; text-decoration: none;"
                            />
                            <button onclick={() => stepValue(exercise.workoutExerciseId, setIndex, 'weight', 5)} style="width: 44px; height: 44px; border: none; background: transparent; font-size: 1.5em; color: #667eea; cursor: pointer;">+</button>
                          </div>
                        </div>

                        <!-- RIR row -->
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0;">
                          <span style="font-weight: 500; color: #333;">RIR</span>
                          <div style="display: flex; align-items: center; gap: 12px;">
                            <button onclick={() => stepValue(exercise.workoutExerciseId, setIndex, 'rir', -1)} style="width: 44px; height: 44px; border: none; background: transparent; font-size: 1.5em; color: #667eea; cursor: pointer;">-</button>
                            <input
                              type="text"
                              value={set.rir}
                              oninput={(e) => { if (log.sets[setIndex]) { log.sets[setIndex].rir = e.target.value; exerciseLogs = { ...exerciseLogs }; } }}
                              placeholder={log.targetRir || '0'}
                              style="width: 60px; padding: 8px 0; border: none; background: transparent; font-size: 1.2em; text-align: center; outline: none; box-shadow: none !important; -webkit-appearance: none; appearance: none; border-radius: 0; text-decoration: none;"
                            />
                            <button onclick={() => stepValue(exercise.workoutExerciseId, setIndex, 'rir', 1)} style="width: 44px; height: 44px; border: none; background: transparent; font-size: 1.5em; color: #667eea; cursor: pointer;">+</button>
                          </div>
                        </div>

                        <!-- Notes row (collapsed by default) -->
                        <div style="padding: 8px 0;">
                          {#if isNotesExpanded(exercise.workoutExerciseId, setIndex)}
                            <div style="display: flex; flex-direction: column; gap: 8px;">
                              <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span style="font-weight: 500; color: #333;">Notes</span>
                                <button onclick={() => toggleNotesExpanded(exercise.workoutExerciseId, setIndex)} style="background: none; border: none; color: #667eea; cursor: pointer; font-size: 0.9em;">Collapse</button>
                              </div>
                              <textarea
                                value={set.notes || ''}
                                oninput={(e) => { if (log.sets[setIndex]) { log.sets[setIndex].notes = e.target.value; exerciseLogs = { ...exerciseLogs }; } }}
                                placeholder="Add notes..."
                                style="width: 100%; min-height: 80px; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.95em; resize: vertical; box-sizing: border-box;"
                              ></textarea>
                            </div>
                          {:else}
                            <button
                              onclick={() => toggleNotesExpanded(exercise.workoutExerciseId, setIndex)}
                              style="display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 12px; border: 1px solid {set.notes ? '#4CAF50' : '#ddd'}; border-radius: 6px; background: {set.notes ? '#e8f5e9' : 'white'}; cursor: pointer;"
                            >
                              <span style="font-weight: 500; color: #333;">Notes</span>
                              <span style="color: {set.notes ? '#4CAF50' : '#999'}; font-size: 0.9em;">{set.notes ? 'View note' : '+ Add'}</span>
                            </button>
                          {/if}
                        </div>

                        <!-- Per-set client input fields -->
                        {#if inputReqs.length > 0}
                          {#each inputReqs as req, reqIndex}
                            <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0;">
                              <span style="font-weight: 500; color: #333;">{req.name}</span>
                              <input
                                type="text"
                                placeholder={req.value}
                                value={set.customInputs?.[reqIndex] || ''}
                                oninput={(e) => { if (!set.customInputs) set.customInputs = {}; set.customInputs[reqIndex] = e.target.value; exerciseLogs = { ...exerciseLogs }; }}
                                style="width: 80px; padding: 8px 0; border: none; background: transparent; font-size: 1.1em; text-align: center; outline: none; box-shadow: none !important; -webkit-appearance: none; appearance: none; border-radius: 0; text-decoration: none;"
                              />
                            </div>
                          {/each}
                        {/if}
                      </div>
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {:else}
            <!-- Collapsed state: summary header -->
            <button
              onclick={() => toggleExerciseExpanded(currentSectionIndex, exercise.workoutExerciseId)}
              style="width: 100%; padding: 12px 15px; background: none; border: none; cursor: pointer; text-align: left; display: flex; align-items: center; justify-content: space-between;"
            >
              <div>
                <h3 style="margin: 0; font-size: 1.1em; color: #333;">{exercise.name}</h3>
                <p style="margin: 4px 0 0 0; font-size: 0.85em; color: #666;">{getPrescriptionSummary(exercise)}</p>
                {#if exercise.rir}
                  <p style="margin: 2px 0 0 0; font-size: 0.85em; color: #666;">RIR {exercise.rir}</p>
                {/if}
              </div>
              <span style="font-size: 1.2em; color: #667eea; transition: transform 0.2s;">▼</span>
            </button>
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
  {@const historyExercise = day?.sections?.flatMap(s => s.exercises || []).find(e => e.exerciseId === historyModal.exerciseId)}
  <div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px;" onclick={closeHistoryModal}>
    <div style="background: white; border-radius: 12px; width: 100%; max-width: 500px; max-height: 80vh; overflow-y: auto;" onclick={(e) => e.stopPropagation()}>
      <div style="padding: 15px 20px; border-bottom: 1px solid #eee; position: sticky; top: 0; background: white; z-index: 1;">
        <h3 style="margin: 0;">{historyModal.exerciseName}</h3>
      </div>
      <div style="padding: 15px 20px;">
        <!-- Estimated 1RM -->
        {#if history?.e1rm}
          <div style="background: linear-gradient(135deg, #ff9800 0%, #f57c00 100%); color: white; padding: 15px; border-radius: 10px; margin-bottom: 15px; text-align: center;">
            <div style="font-size: 0.8em; opacity: 0.9; text-transform: uppercase; letter-spacing: 1px;">Estimated 1RM</div>
            <div style="font-size: 2em; font-weight: bold; margin: 5px 0;">{history.e1rm.e1rm} lbs</div>
            <div style="font-size: 0.8em; opacity: 0.85;">Based on {history.e1rm.weight}×{history.e1rm.reps} ({formatDate(history.e1rm.date)})</div>
          </div>
        {/if}

        <!-- Rep Range PRs -->
        {#if history?.repRanges && (history.repRanges['1-5'] || history.repRanges['6-8'] || history.repRanges['9-12'])}
          <div style="margin-bottom: 15px;">
            <div style="font-weight: 600; color: #333; margin-bottom: 10px; font-size: 0.9em;">Rep Range PRs</div>
            <div style="display: grid; gap: 8px;">
              {#if history.repRanges['1-5']}
                <div style="background: #e3f2fd; padding: 10px 12px; border-radius: 8px; border-left: 4px solid #1565c0;">
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: 600; color: #1565c0;">1-5 Reps (Strength)</span>
                    <span style="font-weight: bold; color: #333;">{history.repRanges['1-5'].weight} × {history.repRanges['1-5'].reps}</span>
                  </div>
                  <div style="font-size: 0.8em; color: #666; margin-top: 4px;">{formatDate(history.repRanges['1-5'].date)}</div>
                  {#if history.repRanges['1-5'].notes}
                    <div style="font-size: 0.8em; color: #888; font-style: italic; margin-top: 4px;">"{history.repRanges['1-5'].notes}"</div>
                  {/if}
                </div>
              {/if}
              {#if history.repRanges['6-8']}
                <div style="background: #f3e5f5; padding: 10px 12px; border-radius: 8px; border-left: 4px solid #7b1fa2;">
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: 600; color: #7b1fa2;">6-8 Reps (Power)</span>
                    <span style="font-weight: bold; color: #333;">{history.repRanges['6-8'].weight} × {history.repRanges['6-8'].reps}</span>
                  </div>
                  <div style="font-size: 0.8em; color: #666; margin-top: 4px;">{formatDate(history.repRanges['6-8'].date)}</div>
                  {#if history.repRanges['6-8'].notes}
                    <div style="font-size: 0.8em; color: #888; font-style: italic; margin-top: 4px;">"{history.repRanges['6-8'].notes}"</div>
                  {/if}
                </div>
              {/if}
              {#if history.repRanges['9-12']}
                <div style="background: #e8f5e9; padding: 10px 12px; border-radius: 8px; border-left: 4px solid #2e7d32;">
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: 600; color: #2e7d32;">9-12 Reps (Hypertrophy)</span>
                    <span style="font-weight: bold; color: #333;">{history.repRanges['9-12'].weight} × {history.repRanges['9-12'].reps}</span>
                  </div>
                  <div style="font-size: 0.8em; color: #666; margin-top: 4px;">{formatDate(history.repRanges['9-12'].date)}</div>
                  {#if history.repRanges['9-12'].notes}
                    <div style="font-size: 0.8em; color: #888; font-style: italic; margin-top: 4px;">"{history.repRanges['9-12'].notes}"</div>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        {/if}

        <!-- Most Recent Session -->
        {#if history?.lastSession}
          <div style="font-weight: 600; color: #333; margin-bottom: 10px; font-size: 0.9em;">Most Recent Session</div>
          <div style="background: #f8f9fa; padding: 12px; border-radius: 8px; border-left: 3px solid #667eea;">
            <div style="color: #888; font-size: 0.8em; margin-bottom: 8px;">{formatDate(history.lastSession.date)}</div>
            {#each history.lastSession.sets as set}
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; margin-bottom: 4px; background: white; border-radius: 5px; font-size: 0.9em;">
                <span style="font-weight: bold; color: #667eea; min-width: 40px;">Set {set.setNumber}</span>
                <span>{set.reps || '-'} × {set.weight || '-'}</span>
                {#if set.rir}<span style="color: #888;">(RIR: {set.rir})</span>{/if}
              </div>
              {#if set.customInputs}{#each Object.entries(set.customInputs) as [idx, val]}{#if val}{@const req = historyExercise?.customReqs?.filter(r => r.clientInput)?.[parseInt(idx)]}<div style="color: #9c27b0; font-size: 0.8em; margin: 0 0 4px 50px;">{req?.name || `Custom ${parseInt(idx)+1}`}: {val}{#if req?.value} {req.value}{/if}</div>{/if}{/each}{/if}
              {#if set.notes}<div style="color: #888; font-style: italic; font-size: 0.8em; margin: 0 0 6px 50px;">"{set.notes}"</div>{/if}
            {/each}
          </div>
        {:else}
          <p style="color: #888; text-align: center; font-size: 0.9em;">No sessions recorded yet.</p>
        {/if}
      </div>
      <div style="padding: 12px 20px; border-top: 1px solid #eee; display: flex; justify-content: flex-end;">
        <button onclick={closeHistoryModal} style="padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer;">
          Close
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Subtle hover/press feedback for exercise banner */
  :global(.exercise-banner:hover) {
    filter: brightness(1.08);
  }
  :global(.exercise-banner:active) {
    filter: brightness(0.95);
  }
</style>
