<script>
  import { page } from '$app/stores';
  import { auth, db } from '$lib/firebase.js';
  import { doc, onSnapshot, getDoc, collection, addDoc, query, where, orderBy, limit, getDocs, updateDoc, getDocsFromServer, setDoc, increment, serverTimestamp } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { setDraft, getDraftKey as getDraftKeyHelper } from '$lib/workoutDraft.js';
  import { primeGoalTimerAudio, playGoalTimerAudio, primeRestTimerAudio, playRestTimerAudio, pauseRestTimerAudio, resumeRestTimerAudio, stopRestTimerAudio, isRestSfxEnabled } from '$lib/utils/timerFeedback.js';

  let program = $state(null);
  let day = $state(null);
  let currentSectionIndex = $state(0);
  let currentUserId = $state(null);
  let workoutStartTime = $state(null);

  // Exercise logging - tracks what user enters for each SET of each exercise
  // Structure: { exerciseId: { targetSets, targetReps, targetWeight, targetRir, sets: [{reps, weight, rir, notes}, ...] } }
  let exerciseLogs = $state({});

  // Track last entered numeric values per exercise for placeholders/stepper base (session-only)
  // Structure: { workoutExerciseId: { weight: value, reps: value, rir: value } }
  let lastEntered = $state({});

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

  // Video modal state
  let videoModalExercise = $state(null);
  let pendingVideoExercise = $state(null);

  // Exercises library (for video URLs)
  let exercises = $state([]);

  // Single-flight lock to prevent double Finish execution
  let isSavingFinish = $state(false);

  // Zero sets confirmation modal state
  let showZeroSetsConfirm = $state(false);

  // Verification failure modal state
  let showVerificationError = $state(false);

  // Slow save hint state
  let showSavingHint = $state(false);

  // Timer references for cleanup
  let savingHintTimer = null;
  let hardTimeoutTimer = null;
  let finishAborted = false;

  // Draft persistence
  let draftSaveTimer = null;
  let didHydrateFromDraft = false; // One-time flag: true after draft restore attempted
  let isWorkoutInitialized = false; // Gate autosave until init + hydration done
  let draftDirty = false; // True when state changed since last successful draft write

  function getDraftKey() {
    return currentUserId ? getDraftKeyHelper(currentUserId) : null;
  }

  function saveDraft() {
    if (!currentUserId || !program?.id || !day) return;
    const draftData = {
      programId: program.id,
      programName: program.name || 'Workout',
      dayIndex: parseInt($page.params.dayIndex),
      dayName: day.name || `Day ${parseInt($page.params.dayIndex) + 1}`,
      workoutStartTimeISO: workoutStartTime?.toISOString() || null,
      exerciseLogs,
      exerciseCompleted,
      activeSetIndices,
      visitedSectionsArray: Array.from(visitedSections),
      currentSectionIndex
    };
    const success = setDraft(currentUserId, draftData);
    if (success) {
      draftDirty = false;
    }
  }

  // Immediate flush for pagehide/visibilitychange (no debounce)
  function flushDraftIfDirty() {
    if (draftDirty && currentUserId && program?.id && day && isWorkoutInitialized) {
      if (draftSaveTimer) {
        clearTimeout(draftSaveTimer);
        draftSaveTimer = null;
      }
      saveDraft();
    }
  }

  function scheduleDraftSave() {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => saveDraft(), 400); // Fast debounce for per-set autosave
  }

  function loadDraft() {
    const key = getDraftKey();
    if (!key || !program?.id) return false;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      if (draft.programId !== program.id || draft.dayIndex !== parseInt($page.params.dayIndex)) {
        return false; // Different workout, don't restore
      }
      // Restore state
      if (draft.workoutStartTimeISO) workoutStartTime = new Date(draft.workoutStartTimeISO);
      if (draft.exerciseLogs) exerciseLogs = draft.exerciseLogs;
      if (draft.exerciseCompleted) exerciseCompleted = draft.exerciseCompleted;
      if (draft.activeSetIndices) activeSetIndices = draft.activeSetIndices;
      if (draft.visitedSectionsArray) visitedSections = new Set(draft.visitedSectionsArray);
      if (typeof draft.currentSectionIndex === 'number') currentSectionIndex = draft.currentSectionIndex;
      return true;
    } catch (e) {
      console.warn('Corrupt workout draft, removing:', e);
      localStorage.removeItem(key);
      return false;
    }
  }

  function clearDraft() {
    const key = getDraftKey();
    if (key) {
      localStorage.removeItem(key);
    }
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = null;
    }
  }

  // Auto-save draft on state changes (debounced)
  $effect(() => {
    // Access reactive state to establish dependencies
    const _ = [exerciseLogs, exerciseCompleted, activeSetIndices, currentSectionIndex, visitedSections];
    if (currentUserId && program?.id && day && isWorkoutInitialized) {
      draftDirty = true; // Mark dirty immediately; cleared after successful write
      scheduleDraftSave();
    }
  });

  // Active set index per exercise (for progressive disclosure in full tracking mode)
  // Structure: { workoutExerciseId: activeSetIndex }
  let activeSetIndices = $state({});

  // Generate stable unique IDs (Firestore-based, works on all browsers including mobile Safari)
  function generateId() {
    return doc(collection(db, '_')).id;
  }

  // Backfill missing IDs in days array, returns true if any were added
  function backfillIds(days) {
    if (!days) return false;
    let changed = false;
    for (const day of days) {
      if (!day.workoutTemplateId) { day.workoutTemplateId = generateId(); changed = true; }
      for (const section of day.sections || []) {
        if (!section.sectionTemplateId) { section.sectionTemplateId = generateId(); changed = true; }
        for (const exercise of section.exercises || []) {
          if (!exercise.workoutExerciseId) { exercise.workoutExerciseId = generateId(); changed = true; }
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
        limit(20)
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

  // Extract YouTube video ID from URL (returns null if not YouTube)
  function getYouTubeId(url) {
    if (!url) return null;
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  function openVideoModal(exercise) {
    pendingVideoExercise = exercise;
  }

  function confirmOpenVideo() {
    videoModalExercise = pendingVideoExercise;
    pendingVideoExercise = null;
  }

  function cancelOpenVideo() {
    pendingVideoExercise = null;
  }

  function closeVideoModal() {
    videoModalExercise = null;
  }

  function handleVideoModalKeydown(e) {
    if (e.key === 'Escape') closeVideoModal();
  }

  function handleConfirmKeydown(e) {
    if (e.key === 'Escape') cancelOpenVideo();
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
    startSessionTimer();
    initRestSfxPreference();

    // Background/pagehide flush handlers (iOS Safari needs pagehide)
    function handlePageHide() {
      flushDraftIfDirty();
    }
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        flushDraftIfDirty();
      }
    }

    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibilityChange);

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
          // Only initialize state if not already hydrated (prevents onSnapshot overwrites)
          if (!didHydrateFromDraft) {
            exerciseLogs = logs;
            exerciseCompleted = completed;
            activeSetIndices = setIndices;

            // Try to restore from draft (same workout only)
            if (currentUserId) {
              loadDraft(); // Will overwrite defaults if draft matches
            }
            didHydrateFromDraft = true;
            isWorkoutInitialized = true;
          }

          // Load history for each exercise
          if (currentUserId) {
            await loadExerciseHistory();
          }

          // Load exercises library for video URLs
          const exercisesSnap = await getDocs(collection(db, 'exercises'));
          exercises = exercisesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        }
      }
    });

    // Cleanup listeners and timers on unmount
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // Clear all rest timer intervals
      Object.values(restTimerIntervals).forEach(interval => {
        if (interval) clearInterval(interval);
      });
      // Clear all long-press timers
      Object.values(longPressTimers).forEach(timer => {
        if (timer) clearTimeout(timer);
      });
      // Clear all stopwatch intervals
      Object.values(stopwatchIntervals).forEach(interval => {
        if (interval) clearInterval(interval);
      });
      // Clear session timer
      if (sessionTimerInterval) {
        clearInterval(sessionTimerInterval);
      }
    };
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
          limit(20)
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
        // A set is "started" if it has any value OR any N/A marker
        return log.sets.some(set => set.weight || set.reps || set.na?.weight || set.na?.reps);
      });
    }
  }

  // Get progress bar color: red = not started, yellow = in progress, green = complete/visited
  function getSectionColor(sectionIndex) {
    if (visitedSections.has(sectionIndex) || isSectionComplete(sectionIndex)) return '#4CAF50'; // green
    if (isSectionStarted(sectionIndex)) return '#FFC107'; // yellow
    return '#ef5350'; // red
  }

  // Check if an exercise in full tracking mode has data (at least one set filled or N/A)
  function hasExerciseData(workoutExerciseId) {
    const log = exerciseLogs[workoutExerciseId];
    if (!log || !log.sets) return false;
    return log.sets.some(set => set.weight || set.reps || set.na?.weight || set.na?.reps);
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

  // Helper: check if a standard field is empty (no value, not N/A, not DNC)
  function isFieldEmpty(set, field) {
    if (!set) return true;
    const val = set[field];
    const isNaField = set.na?.[field] === true;
    const isDNC = val === 'DNC';
    const hasValue = val !== null && val !== undefined && String(val).trim() !== '';
    return !hasValue && !isNaField && !isDNC;
  }

  // Helper: check if a set has any empty standard fields
  function setHasEmptyFields(set) {
    if (!set) return true;
    return isFieldEmpty(set, 'reps') || isFieldEmpty(set, 'weight') || isFieldEmpty(set, 'rir');
  }

  // Skip a single set: fill empty standard fields with DNC
  function skipSet(workoutExerciseId, setIndex) {
    const log = exerciseLogs[workoutExerciseId];
    if (!log || !log.sets || !log.sets[setIndex]) return;
    const set = log.sets[setIndex];

    // Fill empty standard fields with DNC
    if (isFieldEmpty(set, 'reps')) set.reps = 'DNC';
    if (isFieldEmpty(set, 'weight')) set.weight = 'DNC';
    if (isFieldEmpty(set, 'rir')) set.rir = 'DNC';

    exerciseLogs = { ...exerciseLogs };
  }

  // Skip remaining sets: fill empty standard fields with DNC for current and all subsequent sets
  function skipRemainingSets(workoutExerciseId) {
    const log = exerciseLogs[workoutExerciseId];
    if (!log || !log.sets) return;

    const activeIdx = activeSetIndices[workoutExerciseId] ?? 0;

    // Fill DNC for all sets from active index onwards
    for (let i = activeIdx; i < log.sets.length; i++) {
      const set = log.sets[i];
      if (isFieldEmpty(set, 'reps')) set.reps = 'DNC';
      if (isFieldEmpty(set, 'weight')) set.weight = 'DNC';
      if (isFieldEmpty(set, 'rir')) set.rir = 'DNC';
    }

    exerciseLogs = { ...exerciseLogs };
  }

  // Check if there are remaining sets with empty fields (for Skip Remaining visibility)
  function hasRemainingSetsWithEmptyFields(workoutExerciseId) {
    const log = exerciseLogs[workoutExerciseId];
    if (!log || !log.sets) return false;

    const activeIdx = activeSetIndices[workoutExerciseId] ?? 0;

    for (let i = activeIdx; i < log.sets.length; i++) {
      if (setHasEmptyFields(log.sets[i])) return true;
    }
    return false;
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
    // A field is "filled" if it has a value OR is marked N/A
    const repsHas = hasValue(set.reps) || set.na?.reps === true;
    const weightHas = hasValue(set.weight) || set.na?.weight === true;
    const rirHas = hasValue(set.rir) || set.na?.rir === true;
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

  // Session timer (overall workout duration)
  let sessionElapsed = $state(0); // seconds
  let sessionTimerInterval = null;
  let sessionTimerRunning = $state(true);

  // Format session time as MM:SS (or M:SS for < 10 min)
  function formatSessionTime(seconds) {
    if (seconds == null || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Start the session timer
  function startSessionTimer() {
    if (sessionTimerInterval) return; // Already running
    sessionTimerInterval = setInterval(() => {
      if (sessionTimerRunning && workoutStartTime) {
        sessionElapsed = Math.floor((Date.now() - workoutStartTime.getTime()) / 1000);
      }
    }, 1000);
  }

  // Stop the session timer
  function stopSessionTimer() {
    sessionTimerRunning = false;
    if (sessionTimerInterval) {
      clearInterval(sessionTimerInterval);
      sessionTimerInterval = null;
    }
  }

  // Rest timer state per exercise (local UI state only, not persisted)
  // Structure: { workoutExerciseId: { remaining: number, running: boolean, finished: boolean } }
  let restTimerState = $state({});
  let restTimerIntervals = {}; // Interval references, not reactive
  let longPressTimers = {}; // Long-press detection timers
  let restBeepFired = {}; // Latch to track if T-3s beep has fired per exercise
  let restBeepSuppressed = {}; // Track if beep was suppressed (muted at threshold) - no late start
  let restBeepPausedByTimer = {}; // Track if beep audio was paused due to timer pause

  // Global rest-done toast state (single-expiry gate)
  // Only one rest-done toast can be active at a time
  let activeRestDone = $state(null); // null | { workoutExerciseId, exerciseName, restSeconds }

  // Rest timer SFX mute toggle (persisted in localStorage)
  let restSfxEnabled = $state(true); // Default: enabled

  function initRestSfxPreference() {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('ae:restSfxEnabled');
      // Default to "1" (enabled) if not set
      restSfxEnabled = stored !== '0';
    }
  }

  function toggleRestSfx() {
    restSfxEnabled = !restSfxEnabled;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('ae:restSfxEnabled', restSfxEnabled ? '1' : '0');
    }
    // If muting, stop any currently playing rest SFX immediately
    // (but don't reset restBeepFired - prevents restart if unmuted later this cycle)
    if (!restSfxEnabled) {
      stopRestTimerAudio();
    }
  }

  // Helper to find exercise by workoutExerciseId
  function findExerciseById(workoutExerciseId) {
    if (!day?.sections) return null;
    for (const section of day.sections) {
      for (const exercise of section.exercises || []) {
        if (exercise.workoutExerciseId === workoutExerciseId) {
          return exercise;
        }
      }
    }
    return null;
  }

  // Find which section index contains an exercise
  function findSectionIndexByExerciseId(workoutExerciseId) {
    if (!day?.sections) return -1;
    for (let i = 0; i < day.sections.length; i++) {
      const section = day.sections[i];
      for (const exercise of section.exercises || []) {
        if (exercise.workoutExerciseId === workoutExerciseId) {
          return i;
        }
      }
    }
    return -1;
  }

  // Navigate to and highlight the rest-done exercise (called from toast View button)
  function viewRestDoneExercise() {
    if (!activeRestDone) return;
    const { workoutExerciseId } = activeRestDone;

    // Find which section contains this exercise
    const sectionIdx = findSectionIndexByExerciseId(workoutExerciseId);
    if (sectionIdx < 0) return;

    // Switch to that section if not already there
    if (currentSectionIndex !== sectionIdx) {
      currentSectionIndex = sectionIdx;
    }

    // Expand the exercise accordion (for full tracking mode)
    expandedExercise[sectionIdx] = workoutExerciseId;
    expandedExercise = { ...expandedExercise };

    // Scroll to the exercise after DOM updates
    setTimeout(() => {
      const el = document.querySelector(`[data-exercise-id="${workoutExerciseId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }

  // Format seconds as M:SS
  function formatRestTime(seconds) {
    if (seconds == null || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Initialize rest timer state for an exercise
  function initRestTimer(workoutExerciseId, restSeconds) {
    if (!restTimerState[workoutExerciseId]) {
      restTimerState[workoutExerciseId] = {
        remaining: restSeconds,
        running: false,
        finished: false
      };
      restTimerState = { ...restTimerState };
    }
  }

  // Start or resume the rest timer
  function startRestTimer(workoutExerciseId, restSeconds) {
    // Prime audio on user gesture
    primeRestTimerAudio();

    // Initialize if needed
    if (!restTimerState[workoutExerciseId]) {
      restTimerState[workoutExerciseId] = {
        remaining: restSeconds,
        running: false,
        finished: false
      };
      // Reset all beep state flags for fresh start
      restBeepFired[workoutExerciseId] = false;
      restBeepSuppressed[workoutExerciseId] = false;
      restBeepPausedByTimer[workoutExerciseId] = false;
    }

    const state = restTimerState[workoutExerciseId];

    // If finished, restart from full duration
    if (state.finished) {
      state.remaining = restSeconds;
      state.finished = false;
      // Reset all beep state flags for new cycle
      restBeepFired[workoutExerciseId] = false;
      restBeepSuppressed[workoutExerciseId] = false;
      restBeepPausedByTimer[workoutExerciseId] = false;
    } else if (restBeepFired[workoutExerciseId] && restBeepPausedByTimer[workoutExerciseId] && isRestSfxEnabled()) {
      // Resuming from pause - resume audio if beep was paused by timer pause
      resumeRestTimerAudio();
      restBeepPausedByTimer[workoutExerciseId] = false;
    }

    state.running = true;
    restTimerState = { ...restTimerState };

    // Clear any existing interval
    if (restTimerIntervals[workoutExerciseId]) {
      clearInterval(restTimerIntervals[workoutExerciseId]);
    }

    // Start countdown interval
    restTimerIntervals[workoutExerciseId] = setInterval(() => {
      const timerState = restTimerState[workoutExerciseId];
      if (!timerState || !timerState.running) {
        clearInterval(restTimerIntervals[workoutExerciseId]);
        return;
      }

      if (timerState.remaining > 0) {
        timerState.remaining--;
        restTimerState = { ...restTimerState };

        // One-shot beep at T-3s (plays once per rest cycle)
        if (timerState.remaining <= 3 && !restBeepFired[workoutExerciseId] && !restBeepSuppressed[workoutExerciseId]) {
          if (isRestSfxEnabled()) {
            // Sound enabled - play beeps
            restBeepFired[workoutExerciseId] = true;
            playRestTimerAudio();
          } else {
            // Muted at threshold - suppress for this cycle (no late retroactive start)
            restBeepSuppressed[workoutExerciseId] = true;
          }
        }
      } else {
        // Timer finished
        clearInterval(restTimerIntervals[workoutExerciseId]);
        timerState.running = false;

        // Single-expiry gate: only show REST DONE if no other rest toast is active
        if (activeRestDone === null) {
          timerState.finished = true;
          const exercise = findExerciseById(workoutExerciseId);
          activeRestDone = {
            workoutExerciseId,
            exerciseName: exercise?.name || 'Exercise',
            restSeconds: exercise?.restSeconds || 0
          };
        }
        // If activeRestDone is already set, this timer just stops without REST DONE state

        restTimerState = { ...restTimerState };
      }
    }, 1000);
  }

  // Pause the rest timer
  function pauseRestTimer(workoutExerciseId) {
    const state = restTimerState[workoutExerciseId];
    if (state) {
      state.running = false;
      restTimerState = { ...restTimerState };
    }
    if (restTimerIntervals[workoutExerciseId]) {
      clearInterval(restTimerIntervals[workoutExerciseId]);
    }
    // Pause any playing rest SFX and track that it was paused by timer
    if (restBeepFired[workoutExerciseId]) {
      pauseRestTimerAudio();
      restBeepPausedByTimer[workoutExerciseId] = true;
    }
  }

  // Reset the rest timer to full duration
  function resetRestTimer(workoutExerciseId, restSeconds) {
    if (restTimerIntervals[workoutExerciseId]) {
      clearInterval(restTimerIntervals[workoutExerciseId]);
    }
    restTimerState[workoutExerciseId] = {
      remaining: restSeconds,
      running: false,
      finished: false
    };
    restTimerState = { ...restTimerState };
    // Stop and rewind any playing rest SFX
    stopRestTimerAudio();
    // Reset all beep state flags for next cycle
    restBeepFired[workoutExerciseId] = false;
    restBeepSuppressed[workoutExerciseId] = false;
    restBeepPausedByTimer[workoutExerciseId] = false;
    // Clear global toast if this exercise was the active rest-done
    if (activeRestDone?.workoutExerciseId === workoutExerciseId) {
      activeRestDone = null;
    }
  }

  // Acknowledge rest-done toast (called from global toast button)
  function acknowledgeRestDone() {
    if (!activeRestDone) return;
    const { workoutExerciseId, restSeconds } = activeRestDone;
    // Reset the timer to idle (this also clears activeRestDone via resetRestTimer)
    resetRestTimer(workoutExerciseId, restSeconds);
  }

  // Handle tap on rest timer pill
  function handleRestTimerTap(workoutExerciseId, restSeconds) {
    const state = restTimerState[workoutExerciseId];

    if (!state || (!state.running && !state.finished && state.remaining === restSeconds)) {
      // Idle state - start
      startRestTimer(workoutExerciseId, restSeconds);
    } else if (state.running) {
      // Running - pause
      pauseRestTimer(workoutExerciseId);
    } else if (state.finished) {
      // Finished (REST DONE) - acknowledge by resetting to idle (no auto-restart)
      resetRestTimer(workoutExerciseId, restSeconds);
    } else {
      // Paused - resume
      startRestTimer(workoutExerciseId, restSeconds);
    }
  }

  // Long-press handlers for reset
  function handleRestTimerPointerDown(workoutExerciseId, restSeconds) {
    longPressTimers[workoutExerciseId] = setTimeout(() => {
      resetRestTimer(workoutExerciseId, restSeconds);
      longPressTimers[workoutExerciseId] = null;
    }, 600); // 600ms for long-press
  }

  function handleRestTimerPointerUp(workoutExerciseId) {
    if (longPressTimers[workoutExerciseId]) {
      clearTimeout(longPressTimers[workoutExerciseId]);
      longPressTimers[workoutExerciseId] = null;
    }
  }

  function handleRestTimerPointerLeave(workoutExerciseId) {
    if (longPressTimers[workoutExerciseId]) {
      clearTimeout(longPressTimers[workoutExerciseId]);
      longPressTimers[workoutExerciseId] = null;
    }
  }

  // Get the rest timer display state
  function getRestTimerDisplay(workoutExerciseId, restSeconds) {
    const state = restTimerState[workoutExerciseId];

    if (!state || (!state.running && !state.finished && (state.remaining === restSeconds || state.remaining === undefined))) {
      // Idle state
      return { mode: 'idle', text: `Rest ${formatRestTime(restSeconds)}` };
    } else if (state.finished) {
      // Finished state - persistent until acknowledged
      return { mode: 'finished', text: 'REST DONE' };
    } else if (state.running) {
      // Running state
      return { mode: 'running', text: formatRestTime(state.remaining) };
    } else {
      // Paused state
      return { mode: 'paused', text: `⏸ ${formatRestTime(state.remaining)}` };
    }
  }

  // ============================================
  // STOPWATCH (for time-metric exercises)
  // ============================================
  // State: 'idle' | 'running' | 'stopped'
  // Structure: { key: { elapsed: number (seconds), state: string, startedAt: number (timestamp) } }
  // key = workoutExerciseId-setIndex
  let stopwatchState = $state({});
  let stopwatchIntervals = {}; // Interval references, not reactive
  let goalFeedbackFired = {}; // Track if goal feedback already fired per stopwatch key

  // Focus mode state: { workoutExerciseId, setIndex, exerciseName, targetTime, targetRir, customReqs } or null
  let focusMode = $state(null);

  // Parse targetTime string to seconds (e.g., "1:30" -> 90, "45" -> 45)
  function parseTargetTimeToSeconds(targetTime) {
    if (!targetTime) return null;
    const str = String(targetTime).trim();
    if (!str) return null;

    // Try M:SS format
    const colonMatch = str.match(/^(\d+):(\d{1,2})$/);
    if (colonMatch) {
      const mins = parseInt(colonMatch[1], 10);
      const secs = parseInt(colonMatch[2], 10);
      return mins * 60 + secs;
    }

    // Try plain number (seconds)
    const num = parseFloat(str);
    if (!isNaN(num) && num > 0) {
      return Math.floor(num);
    }

    return null;
  }

  // Format elapsed seconds as M:SS
  function formatStopwatchTime(seconds) {
    if (seconds == null || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Get stopwatch key for exercise + set
  function getStopwatchKey(workoutExerciseId, setIndex) {
    return `${workoutExerciseId}-${setIndex}`;
  }

  // Get stopwatch state for exercise + set
  function getStopwatch(workoutExerciseId, setIndex) {
    const key = getStopwatchKey(workoutExerciseId, setIndex);
    return stopwatchState[key] || { elapsed: 0, state: 'idle' };
  }

  // Start the stopwatch
  function startStopwatch(workoutExerciseId, setIndex) {
    const key = getStopwatchKey(workoutExerciseId, setIndex);
    const current = stopwatchState[key] || { elapsed: 0, state: 'idle' };

    // Prime goal timer audio on user gesture (Start click)
    primeGoalTimerAudio();

    // Reset goal feedback flag for fresh start
    goalFeedbackFired[key] = false;

    // Clear any existing interval
    if (stopwatchIntervals[key]) {
      clearInterval(stopwatchIntervals[key]);
    }

    // Update state
    stopwatchState[key] = {
      elapsed: current.elapsed,
      state: 'running',
      startedAt: Date.now() - (current.elapsed * 1000)
    };
    stopwatchState = { ...stopwatchState };

    // Start counting up
    stopwatchIntervals[key] = setInterval(() => {
      const sw = stopwatchState[key];
      if (!sw || sw.state !== 'running') {
        clearInterval(stopwatchIntervals[key]);
        return;
      }
      sw.elapsed = Math.floor((Date.now() - sw.startedAt) / 1000);
      stopwatchState = { ...stopwatchState };

      // Goal feedback: only fire if Focus Mode is open, goal exists, and not already fired
      if (focusMode && focusMode.workoutExerciseId === workoutExerciseId && focusMode.setIndex === setIndex) {
        const goalSecs = parseTargetTimeToSeconds(focusMode.targetTime);
        if (goalSecs && goalSecs > 0 && !goalFeedbackFired[key] && sw.elapsed >= goalSecs) {
          goalFeedbackFired[key] = true;
          playGoalTimerAudio(); // Fire and forget
        }
      }
    }, 100); // Update frequently for smooth display
  }

  // Stop/pause the stopwatch
  function stopStopwatch(workoutExerciseId, setIndex) {
    const key = getStopwatchKey(workoutExerciseId, setIndex);
    const current = stopwatchState[key];

    if (stopwatchIntervals[key]) {
      clearInterval(stopwatchIntervals[key]);
    }

    if (current) {
      current.state = 'stopped';
      stopwatchState = { ...stopwatchState };
    }
  }

  // Resume the stopwatch
  function resumeStopwatch(workoutExerciseId, setIndex) {
    startStopwatch(workoutExerciseId, setIndex);
  }

  // Reset the stopwatch
  function resetStopwatch(workoutExerciseId, setIndex) {
    const key = getStopwatchKey(workoutExerciseId, setIndex);

    if (stopwatchIntervals[key]) {
      clearInterval(stopwatchIntervals[key]);
    }

    stopwatchState[key] = { elapsed: 0, state: 'idle' };
    stopwatchState = { ...stopwatchState };

    // Reset goal feedback flag so it can fire again on next run
    goalFeedbackFired[key] = false;
  }

  // Finish: populate time field and exit focus mode
  function finishStopwatch(workoutExerciseId, setIndex) {
    const key = getStopwatchKey(workoutExerciseId, setIndex);
    const sw = stopwatchState[key];

    if (sw && sw.elapsed > 0) {
      // Populate the time field (weight field for time-metric exercises)
      const log = exerciseLogs[workoutExerciseId];
      if (log && log.sets && log.sets[setIndex]) {
        // Format as seconds or M:SS based on what's typical
        const timeValue = formatStopwatchTime(sw.elapsed);
        log.sets[setIndex].weight = timeValue;
        exerciseLogs = { ...exerciseLogs };
        // Track lastEntered for time (stored in weight field)
        updateLastEntered(workoutExerciseId, 'weight', timeValue);
      }
    }

    // Reset stopwatch
    resetStopwatch(workoutExerciseId, setIndex);

    // Exit focus mode
    focusMode = null;
  }

  // Open focus mode for stopwatch
  function openFocusMode(workoutExerciseId, setIndex, exercise) {
    focusMode = {
      workoutExerciseId,
      setIndex,
      exerciseName: exercise.name,
      targetTime: exercise.weight || null,
      targetRir: exercise.rir || null,
      customReqs: exercise.customReqs || []
    };
  }

  // Close focus mode without finishing
  function closeFocusMode() {
    if (focusMode) {
      // Pause the timer (keeps elapsed time, just stops counting)
      stopStopwatch(focusMode.workoutExerciseId, focusMode.setIndex);
      // Reset goal feedback flag for this stopwatch
      const key = getStopwatchKey(focusMode.workoutExerciseId, focusMode.setIndex);
      goalFeedbackFired[key] = false;
    }
    focusMode = null;
  }

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

  // Get single metric label for checkbox-only sections
  // Returns formatted label like "6 Reps" or "2 Min" if exactly one metric, else null
  function getSingleMetricLabel(exercise) {
    const hasReps = exercise.reps && String(exercise.reps).trim() !== '';
    const hasWeight = exercise.weight && String(exercise.weight).trim() !== '';
    const isTimeMetric = exercise.weightMetric === 'time';

    // Single metric: only reps OR only time (excluding notes)
    if (hasReps && !hasWeight) {
      return `${exercise.reps} Reps`;
    }
    if (hasWeight && !hasReps && isTimeMetric) {
      return `${exercise.weight}`;
    }

    return null;
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
    // Clear N/A if stepping
    clearNa(workoutExerciseId, setIndex, field);
    const currentVal = log.sets[setIndex][field];
    const hasValue = currentVal !== null && currentVal !== undefined && String(currentVal).trim() !== '' && currentVal !== 'DNC';
    // Use current value if present, otherwise use lastEntered/target as base
    const base = hasValue ? parseFloat(currentVal) || 0 : getStepperBase(workoutExerciseId, field);
    let newVal = base + delta;
    if (field === 'rir') newVal = Math.max(0, Math.min(10, newVal));
    else newVal = Math.max(0, newVal);
    log.sets[setIndex][field] = String(newVal);
    exerciseLogs = { ...exerciseLogs };
    // Track lastEntered for the new value
    updateLastEntered(workoutExerciseId, field, String(newVal));
  }

  // N/A field handling
  function isNa(workoutExerciseId, setIndex, field) {
    const log = exerciseLogs[workoutExerciseId];
    if (!log || !log.sets || !log.sets[setIndex]) return false;
    return log.sets[setIndex].na?.[field] === true;
  }

  function toggleNa(workoutExerciseId, setIndex, field) {
    const log = exerciseLogs[workoutExerciseId];
    if (!log || !log.sets || !log.sets[setIndex]) return;
    const set = log.sets[setIndex];
    if (!set.na) set.na = {};
    if (set.na[field]) {
      // Clear N/A
      delete set.na[field];
      // Clean up empty na object
      if (Object.keys(set.na).length === 0) delete set.na;
    } else {
      // Set N/A and clear value
      set.na[field] = true;
      set[field] = '';
    }
    exerciseLogs = { ...exerciseLogs };
  }

  function clearNa(workoutExerciseId, setIndex, field) {
    const log = exerciseLogs[workoutExerciseId];
    if (!log || !log.sets || !log.sets[setIndex]) return;
    const set = log.sets[setIndex];
    if (set.na?.[field]) {
      delete set.na[field];
      if (Object.keys(set.na).length === 0) delete set.na;
    }
  }

  // Update lastEntered when user enters a numeric value (not N/A, not DNC)
  function updateLastEntered(workoutExerciseId, field, value) {
    if (!value || value === 'N/A' || value === 'DNC') return;
    const trimmed = String(value).trim();
    if (trimmed === '') return;
    // Check if it's a valid numeric value (allow decimals and time formats like 1:30)
    const isNumeric = /^[\d:.]+$/.test(trimmed);
    if (!isNumeric) return;

    if (!lastEntered[workoutExerciseId]) {
      lastEntered[workoutExerciseId] = {};
    }
    lastEntered[workoutExerciseId][field] = trimmed;
    lastEntered = { ...lastEntered };
  }

  // Get placeholder value: lastEntered > program target > fallback
  function getPlaceholder(workoutExerciseId, field, fallback) {
    const log = exerciseLogs[workoutExerciseId];
    // Priority 1: lastEntered
    if (lastEntered[workoutExerciseId]?.[field]) {
      return lastEntered[workoutExerciseId][field];
    }
    // Priority 2: program target
    if (log) {
      if (field === 'reps' && log.targetReps) return log.targetReps;
      if (field === 'weight' && log.targetWeight) return log.targetWeight;
      if (field === 'rir' && log.targetRir) return log.targetRir;
    }
    // Priority 3: fallback
    return fallback;
  }

  // Get stepper base value when field is empty
  function getStepperBase(workoutExerciseId, field) {
    // Priority 1: lastEntered
    if (lastEntered[workoutExerciseId]?.[field]) {
      return parseFloat(lastEntered[workoutExerciseId][field]) || 0;
    }
    // Priority 2: program target
    const log = exerciseLogs[workoutExerciseId];
    if (log) {
      if (field === 'reps' && log.targetReps) return parseFloat(log.targetReps) || 0;
      if (field === 'weight' && log.targetWeight) return parseFloat(log.targetWeight) || 0;
      if (field === 'rir' && log.targetRir) return parseFloat(log.targetRir) || 0;
    }
    // Priority 3: fallback to 0
    return 0;
  }

  function handleFieldInput(workoutExerciseId, setIndex, field, value) {
    const log = exerciseLogs[workoutExerciseId];
    if (!log || !log.sets || !log.sets[setIndex]) return;
    // Clear N/A when user types a value
    if (value && value.trim() !== '') {
      clearNa(workoutExerciseId, setIndex, field);
    }
    log.sets[setIndex][field] = value;
    exerciseLogs = { ...exerciseLogs };
    // Track lastEntered for numeric values
    updateLastEntered(workoutExerciseId, field, value);
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

  // Compute count of eligible sets that would be written to Firestore
  // A set is eligible if: weight OR reps OR notes OR any truthy customInputs value
  function computeExpectedSetWrites() {
    if (!day?.sections) return 0;
    let count = 0;
    for (const section of day.sections) {
      for (const exercise of section.exercises || []) {
        const log = exerciseLogs[exercise.workoutExerciseId];
        if (log && log.sets) {
          for (const set of log.sets) {
            const hasCustomInput = set.customInputs && Object.values(set.customInputs).some(v => v);
            if (set.weight || set.reps || set.notes || hasCustomInput) {
              count++;
            }
          }
        }
      }
    }
    return count;
  }

  // Compute session tonnage: sum(weight * reps) for sets where both are numeric
  function computeSessionTonnage() {
    let totalTonnage = 0;
    for (const section of day?.sections || []) {
      for (const exercise of section.exercises || []) {
        const log = exerciseLogs[exercise.workoutExerciseId];
        if (log && log.sets) {
          for (const set of log.sets) {
            // Skip N/A, DNC, or non-numeric values
            const weightVal = parseFloat(set.weight);
            const repsVal = parseFloat(set.reps);
            if (!isNaN(weightVal) && !isNaN(repsVal) && weightVal > 0 && repsVal > 0) {
              totalTonnage += weightVal * repsVal;
            }
          }
        }
      }
    }
    return totalTonnage;
  }

  // Update tonnage stats (monthly and yearly) using atomic increment
  // Writes a ledger doc per session for idempotency and future reversal
  async function updateTonnageStats(userId, sessionId, sessionTonnage) {
    if (!sessionTonnage || sessionTonnage <= 0) return;

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // 1-12
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    const yearKey = `${year}`;

    // Ledger doc path: user/{uid}/stats/sessionTonnage_{sessionId}
    const ledgerRef = doc(db, 'user', userId, 'stats', `sessionTonnage_${sessionId}`);

    // Idempotency check: if ledger already exists, do not re-increment
    const ledgerSnap = await getDoc(ledgerRef);
    if (ledgerSnap.exists()) {
      return;
    }

    // Create ledger doc
    await setDoc(ledgerRef, {
      sessionId,
      tonnage: sessionTonnage,
      monthKey,
      yearKey,
      finishedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    // Monthly tonnage doc
    const monthDocRef = doc(db, 'user', userId, 'stats', `tonnage_${monthKey}`);
    await setDoc(monthDocRef, {
      monthKey,
      year,
      month,
      tonnage: increment(sessionTonnage),
      updatedAt: serverTimestamp()
    }, { merge: true });

    // Yearly tonnage doc
    const yearDocRef = doc(db, 'user', userId, 'stats', `tonnage_${yearKey}`);
    await setDoc(yearDocRef, {
      yearKey,
      year,
      tonnage: increment(sessionTonnage),
      updatedAt: serverTimestamp()
    }, { merge: true });
  }

  // Rep-band classification for strength PRs
  // Bands: 1-5, 6-8, 9-12, 13+
  function getRepBand(reps) {
    if (reps >= 1 && reps <= 5) return '1-5';
    if (reps >= 6 && reps <= 8) return '6-8';
    if (reps >= 9 && reps <= 12) return '9-12';
    if (reps >= 13) return '13+';
    return null;
  }

  // Collect PR candidates from the current session (strength sets only, full-tracking sections)
  // Returns: Map<string, { exerciseId, exerciseName, repBand, weight, reps }>
  // Key format: `${exerciseId}__${repBand}`
  function collectPrCandidates() {
    const candidates = new Map();

    for (const section of day?.sections || []) {
      // Skip checkbox-mode sections (not full tracking)
      if (section?.mode === 'checkbox') continue;

      for (const exercise of section.exercises || []) {
        const log = exerciseLogs[exercise.workoutExerciseId];
        if (!log || !log.sets) continue;

        for (const set of log.sets) {
          const weight = parseFloat(set.weight);
          const reps = parseInt(set.reps);

          // Must have valid numeric weight + reps for strength PR
          if (isNaN(weight) || isNaN(reps) || weight <= 0 || reps <= 0) continue;

          const repBand = getRepBand(reps);
          if (!repBand) continue;

          const key = `${exercise.exerciseId}__${repBand}`;
          const existing = candidates.get(key);

          // Keep best: highest weight wins, tie-breaker = more reps
          if (!existing || weight > existing.weight || (weight === existing.weight && reps > existing.reps)) {
            candidates.set(key, {
              exerciseId: exercise.exerciseId,
              exerciseName: exercise.name,
              repBand,
              weight,
              reps
            });
          }
        }
      }
    }

    return candidates;
  }

  // Update exercise PR docs for this session (write-forward, non-blocking)
  // Path: user/{userId}/stats/prs/exercisePrs/{exerciseId}__{repBand}
  async function updateExercisePrs(userId, sessionId) {
    const candidates = collectPrCandidates();
    if (candidates.size === 0) return;

    const now = serverTimestamp();

    for (const [key, candidate] of candidates) {
      try {
        // Document ID: replace hyphen with underscore, plus with _plus for Firestore safety
        // Path: user/{uid}/stats/prs/exercisePrs/{docId} (6 segments = valid doc ref)
        // Examples: "6-8" → "6_8", "13+" → "13_plus"
        const bandKey = candidate.repBand.replace('-', '_').replace('+', '_plus');
        const docId = `${candidate.exerciseId}__${bandKey}`;
        const prRef = doc(db, 'user', userId, 'stats', 'prs', 'exercisePrs', docId);

        const prSnap = await getDoc(prRef);

        let shouldUpdate = false;
        if (!prSnap.exists()) {
          // No existing PR - create it
          shouldUpdate = true;
        } else {
          const existing = prSnap.data();
          const existingWeight = existing.bestWeight || 0;
          const existingReps = existing.bestReps || 0;

          // Update if candidate beats existing: higher weight, or same weight with more reps
          if (candidate.weight > existingWeight) {
            shouldUpdate = true;
          } else if (candidate.weight === existingWeight && candidate.reps > existingReps) {
            shouldUpdate = true;
          }
        }

        if (shouldUpdate) {
          await setDoc(prRef, {
            exerciseId: candidate.exerciseId,
            exerciseNameSnapshot: candidate.exerciseName,
            repBand: candidate.repBand,
            metric: 'topWeight',
            bestWeight: candidate.weight,
            bestReps: candidate.reps,
            achievedAt: now,
            sessionId: sessionId,
            updatedAt: now
          }, { merge: true });
        }
      } catch (err) {
        // Non-fatal: log and continue with other PR candidates
        console.error(`PR update failed for ${key}:`, err);
      }
    }
  }

  // Detect new PRs achieved in this session by comparing candidates against existing PR docs
  // Must be called BEFORE updateExercisePrs() to get accurate "prev" values
  // Returns: Array<{ exerciseId, exerciseName, repBand, newWeight, newReps, prevWeight, prevReps }>
  async function detectNewPrs(userId) {
    const candidates = collectPrCandidates();
    if (candidates.size === 0) return [];

    const newPrs = [];

    // Read all existing PR docs in parallel for speed
    const readPromises = [];
    const candidateList = Array.from(candidates.entries());

    for (const [key, candidate] of candidateList) {
      const bandKey = candidate.repBand.replace('-', '_').replace('+', '_plus');
      const docId = `${candidate.exerciseId}__${bandKey}`;
      const prRef = doc(db, 'user', userId, 'stats', 'prs', 'exercisePrs', docId);

      readPromises.push(
        getDoc(prRef)
          .then(snap => ({ key, candidate, snap, error: null }))
          .catch(err => ({ key, candidate, snap: null, error: err }))
      );
    }

    const results = await Promise.all(readPromises);

    for (const { key, candidate, snap, error } of results) {
      if (error) {
        // Non-fatal: skip this candidate if read fails
        console.error(`PR read failed for ${key}:`, error);
        continue;
      }

      let isNewPr = false;
      let prevWeight = null;
      let prevReps = null;

      if (!snap || !snap.exists()) {
        // No existing PR doc - this is a new PR
        isNewPr = true;
      } else {
        const existing = snap.data();
        prevWeight = existing.bestWeight || 0;
        prevReps = existing.bestReps || 0;

        // Check if candidate beats existing
        if (candidate.weight > prevWeight) {
          isNewPr = true;
        } else if (candidate.weight === prevWeight && candidate.reps > prevReps) {
          isNewPr = true;
        }
      }

      if (isNewPr) {
        newPrs.push({
          exerciseId: candidate.exerciseId,
          exerciseName: candidate.exerciseName,
          repBand: candidate.repBand,
          newWeight: candidate.weight,
          newReps: candidate.reps,
          prevWeight,
          prevReps
        });
      }
    }

    return newPrs;
  }

  async function finishWorkout() {
    if (!currentUserId || !day) return;
    if (isSavingFinish) return; // Prevent double-tap / duplicate executions
    isSavingFinish = true;
    stopSessionTimer(); // Stop the session timer

    // Prime audio for PR celebration (must be close to user gesture for autoplay)
    try {
      sessionStorage.setItem('ae:allowPrAudio', '1');
      sessionStorage.setItem('ae:allowPrAudioAt', String(Date.now()));
    } catch (e) {
      // Ignore storage errors
    }

    // Check if user has 0 eligible sets
    const expectedSetWrites = computeExpectedSetWrites();
    if (expectedSetWrites === 0) {
      showZeroSetsConfirm = true;
      return; // Wait for user to confirm or cancel
    }

    await executeFinishWorkout();
  }

  function cancelZeroSetsConfirm() {
    showZeroSetsConfirm = false;
    isSavingFinish = false;
  }

  async function confirmZeroSetsSave() {
    showZeroSetsConfirm = false;
    await executeFinishWorkout();
  }

  function clearFinishTimers() {
    if (savingHintTimer) { clearTimeout(savingHintTimer); savingHintTimer = null; }
    if (hardTimeoutTimer) { clearTimeout(hardTimeoutTimer); hardTimeoutTimer = null; }
    showSavingHint = false;
  }

  async function executeFinishWorkout() {
    // Reset aborted flag and start timers
    finishAborted = false;

    // Soft hint after 3s
    savingHintTimer = setTimeout(() => {
      if (isSavingFinish && !finishAborted) {
        showSavingHint = true;
      }
    }, 3000);

    // Hard timeout after 12s
    hardTimeoutTimer = setTimeout(() => {
      if (isSavingFinish && !finishAborted) {
        finishAborted = true;
        clearFinishTimers();
        showVerificationError = true;
        isSavingFinish = false;
      }
    }, 12000);

    try {
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
      if (finishAborted) return; // Hard timeout fired
      const completedWorkoutId = sessionRef.id;

      // Save all exercise logs to Firestore - one entry per SET
      const logPromises = [];

      for (const section of day.sections || []) {
        for (const exercise of section.exercises || []) {
          const log = exerciseLogs[exercise.workoutExerciseId];

          if (log && log.sets) {
            log.sets.forEach((set, setIndex) => {
              // Only save sets that have data (weight, reps, notes, or custom inputs)
              const hasCustomInput = set.customInputs && Object.values(set.customInputs).some(v => v);
              if (set.weight || set.reps || set.notes || hasCustomInput) {
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
      if (finishAborted) return; // Hard timeout fired

      // Server read-back verification
      const expectedSetWrites = logPromises.length;
      try {
        const verifyQuery = query(
          collection(db, 'workoutLogs'),
          where('userId', '==', currentUserId),
          where('completedWorkoutId', '==', completedWorkoutId)
        );
        const verifySnapshot = await getDocsFromServer(verifyQuery);
        if (finishAborted) return; // Hard timeout fired
        const actualSetWrites = verifySnapshot.size;

        if (actualSetWrites !== expectedSetWrites) {
          // Verification failed - mismatch
          clearFinishTimers();
          showVerificationError = true;
          isSavingFinish = false;
          return;
        }
      } catch (verifyError) {
        // Verification failed - error during check
        console.error('Verification error:', verifyError);
        clearFinishTimers();
        showVerificationError = true;
        isSavingFinish = false;
        return;
      }

      // Verification passed - update tonnage stats (must complete before navigation)
      const sessionTonnage = computeSessionTonnage();
      if (sessionTonnage > 0) {
        try {
          await updateTonnageStats(currentUserId, completedWorkoutId, sessionTonnage);
        } catch (err) {
          console.error('Tonnage stats update failed:', err);
        }
      }

      // Detect new PRs BEFORE updating (to get accurate "prev" values)
      let newPrs = [];
      try {
        newPrs = await detectNewPrs(currentUserId);
      } catch (err) {
        console.error('PR detection failed:', err);
      }

      // Update exercise PRs (write-forward, non-blocking)
      try {
        await updateExercisePrs(currentUserId, completedWorkoutId);
      } catch (err) {
        console.error('Exercise PR update failed:', err);
      }

      // Store new PRs in sessionStorage for summary page celebration
      // Summary page reads and clears these keys after consuming
      try {
        sessionStorage.setItem('ae:newPRsForSummary', JSON.stringify(newPrs));
        sessionStorage.setItem('ae:newPRsForSummarySessionId', completedWorkoutId);
      } catch (err) {
        console.error('Failed to store new PRs:', err);
      }

      // Clear draft and timers, then navigate to summary
      clearDraft();
      clearFinishTimers();
      goto(`/programs/${program.id}/summary?day=${$page.params.dayIndex}&duration=${durationMinutes}&session=${completedWorkoutId}`);
    } finally {
      clearFinishTimers();
      isSavingFinish = false;
    }
  }

  function dismissVerificationError() {
    showVerificationError = false;
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString();
  }
</script>

{#if program && day}
  <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px;">
    <div>
      <h1 style="margin-bottom: 5px;">{day.name}</h1>
      <p style="color: #666; margin: 0;">{program.name}</p>
    </div>
    <div class="session-timer">
      {formatSessionTime(sessionElapsed)}
    </div>
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
        {@const singleMetric = getSingleMetricLabel(exercise)}
        {@const libraryEx = exercises.find(e => e.id === exercise.exerciseId)}
        <div
          data-exercise-id={exercise.workoutExerciseId}
          style="border: 2px solid {isComplete ? '#4CAF50' : showIncompleteHint ? '#FFC107' : '#ddd'}; padding: 15px; margin-bottom: 10px; border-radius: 8px; background: {isComplete ? '#f1f8e9' : showIncompleteHint ? '#fffde7' : 'white'}; cursor: pointer; transition: all 0.2s;"
          onclick={() => toggleExerciseComplete(exercise.workoutExerciseId)}
        >
          <div style="display: flex; align-items: center; gap: 15px;">
            <div style="width: 30px; height: 30px; border: 2px solid {isComplete ? '#4CAF50' : '#ccc'}; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: {isComplete ? '#4CAF50' : 'white'}; flex-shrink: 0;">
              {#if isComplete}
                <span style="color: white; font-size: 1.2em;">✓</span>
              {/if}
            </div>
            <div style="flex: 1; min-width: 0;">
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 5px;">
                <h3 style="margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; {isComplete ? 'text-decoration: line-through; color: #888;' : ''}">{exercise.name}</h3>
                {#if libraryEx?.videoUrl?.trim()}
                  <button
                    type="button"
                    aria-label="Play video"
                    onclick={(e) => { e.stopPropagation(); openVideoModal(libraryEx); }}
                    style="background: #fff; border: 1px solid #9C27B0; color: #9C27B0; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; cursor: pointer; flex-shrink: 0;"
                  >▶ Video</button>
                {/if}
              </div>
              {#if singleMetric}
                <p style="color: #888; margin: 0; font-size: 0.9em;">{singleMetric}</p>
                {#if exercise.notes}
                  <p style="color: #888; margin: 2px 0 0 0; font-size: 0.9em;">{exercise.notes}</p>
                {/if}
              {:else if exercise.sets || exercise.reps}
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
        {@const libraryEx = exercises.find(e => e.id === exercise.exerciseId)}
        <div
          data-exercise-id={exercise.workoutExerciseId}
          style="border: 2px solid {isCompleted ? '#4CAF50' : showIncompleteHint ? '#FFC107' : '#ddd'}; margin-bottom: 10px; border-radius: 8px; background: {isCompleted ? '#e8f5e9' : showIncompleteHint ? '#fffde7' : 'white'}; transition: all 0.3s; overflow: hidden;"
        >
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
              <!-- Video pill (centered under "Tap for history") -->
              {#if libraryEx?.videoUrl?.trim()}
                <button
                  type="button"
                  aria-label="Play video"
                  onclick={(e) => { e.stopPropagation(); openVideoModal(libraryEx); }}
                  style="position: absolute; top: 52px; left: 50%; transform: translateX(-50%); background: transparent; border: 1px solid white; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; cursor: pointer; z-index: 1;"
                >▶ Video</button>
              {/if}

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
              <!-- Static custom requirements (clientInput=false) -->
              {#if nonInputReqs.length > 0}
                <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;">
                  {#each nonInputReqs as req}
                    <span style="background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.4); padding: 2px 8px; border-radius: 12px; font-size: 0.8em;">{req.name}: {req.value}</span>
                  {/each}
                </div>
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

                      <!-- Dot indicator with navigation arrows -->
                      <div style="display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 10px;">
                        <button
                          onclick={() => prevSet(exercise.workoutExerciseId)}
                          disabled={activeIdx === 0}
                          aria-label="Previous set"
                          style="background: none; border: none; font-size: 1.5em; color: {activeIdx === 0 ? '#ccc' : '#555'}; cursor: {activeIdx === 0 ? 'default' : 'pointer'}; padding: 8px; min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center;"
                        >&lt;</button>
                        <div style="display: flex; gap: 8px;">
                          {#each log.sets as dotSet, dotIndex}
                            {@const completionState = getSetCompletionState(dotSet)}
                            {@const isActive = dotIndex === activeIdx}
                            <div style="width: {isActive ? '12px' : '10px'}; height: {isActive ? '12px' : '10px'}; border-radius: 50%; background: {getDotColor(completionState)}; {isActive ? 'box-shadow: 0 0 0 2px #667eea;' : ''} transition: all 0.2s;"></div>
                          {/each}
                        </div>
                        <button
                          onclick={() => nextSet(exercise.workoutExerciseId)}
                          disabled={activeIdx === log.sets.length - 1}
                          aria-label="Next set"
                          style="background: none; border: none; font-size: 1.5em; color: {activeIdx === log.sets.length - 1 ? '#ccc' : '#555'}; cursor: {activeIdx === log.sets.length - 1 ? 'default' : 'pointer'}; padding: 8px; min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center;"
                        >&gt;</button>
                      </div>

                      <!-- Skip set button (below tracker dots) - only show if set has empty fields -->
                      {#if setHasEmptyFields(set)}
                        <div style="display: flex; justify-content: center; margin-bottom: 6px;">
                          <button
                            class="skip-set-btn"
                            onclick={() => skipSet(exercise.workoutExerciseId, setIndex)}
                            aria-label="Skip this set"
                          >Skip</button>
                        </div>
                      {/if}

                      <!-- Vertical stacked inputs -->
                      <div style="display: flex; flex-direction: column; gap: 12px;">
                        <!-- Reps row -->
                        <!-- Reps row -->
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0;">
                          <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="font-weight: 500; color: #333;">{repsHeader}</span>
                            <button
                              class="na-btn {isNa(exercise.workoutExerciseId, setIndex, 'reps') ? 'na-btn-active' : ''}"
                              onclick={() => toggleNa(exercise.workoutExerciseId, setIndex, 'reps')}
                              aria-label="Mark reps as N/A"
                            >N/A</button>
                          </div>
                          <div class="stepper-row">
                            <button class="stepper-btn" onclick={() => stepValue(exercise.workoutExerciseId, setIndex, 'reps', -1)}>-</button>
                            <input
                              type="text"
                              class="stepper-input"
                              value={isNa(exercise.workoutExerciseId, setIndex, 'reps') ? 'N/A' : set.reps}
                              oninput={(e) => handleFieldInput(exercise.workoutExerciseId, setIndex, 'reps', e.target.value)}
                              onfocus={() => clearNa(exercise.workoutExerciseId, setIndex, 'reps')}
                              placeholder={getPlaceholder(exercise.workoutExerciseId, 'reps', '0')}
                            />
                            <button class="stepper-btn" onclick={() => stepValue(exercise.workoutExerciseId, setIndex, 'reps', 1)}>+</button>
                          </div>
                        </div>

                        <!-- Weight/Time row -->
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0;">
                          <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="font-weight: 500; color: #333;">{weightHeader}</span>
                            <button
                              class="na-btn {isNa(exercise.workoutExerciseId, setIndex, 'weight') ? 'na-btn-active' : ''}"
                              onclick={() => toggleNa(exercise.workoutExerciseId, setIndex, 'weight')}
                              aria-label="Mark {weightHeader.toLowerCase()} as N/A"
                            >N/A</button>
                          </div>
                          <div class="stepper-row">
                            {#if exercise.weightMetric === 'time'}
                              <!-- Time metric: show input + stopwatch button -->
                              <input
                                type="text"
                                class="stepper-input stepper-input-time"
                                value={isNa(exercise.workoutExerciseId, setIndex, 'weight') ? 'N/A' : set.weight}
                                oninput={(e) => handleFieldInput(exercise.workoutExerciseId, setIndex, 'weight', e.target.value)}
                                onfocus={() => clearNa(exercise.workoutExerciseId, setIndex, 'weight')}
                                placeholder={getPlaceholder(exercise.workoutExerciseId, 'weight', '0:00')}
                              />
                              <button
                                class="stopwatch-trigger"
                                onclick={() => openFocusMode(exercise.workoutExerciseId, setIndex, exercise)}
                                aria-label="Open stopwatch"
                                title="Open stopwatch"
                              >
                                ⏱
                              </button>
                            {:else}
                              <!-- Weight metric: show +/- steppers -->
                              <button class="stepper-btn" onclick={() => stepValue(exercise.workoutExerciseId, setIndex, 'weight', -5)}>-</button>
                              <input
                                type="text"
                                class="stepper-input"
                                value={isNa(exercise.workoutExerciseId, setIndex, 'weight') ? 'N/A' : set.weight}
                                oninput={(e) => handleFieldInput(exercise.workoutExerciseId, setIndex, 'weight', e.target.value)}
                                onfocus={() => clearNa(exercise.workoutExerciseId, setIndex, 'weight')}
                                placeholder={getPlaceholder(exercise.workoutExerciseId, 'weight', '0')}
                              />
                              <button class="stepper-btn" onclick={() => stepValue(exercise.workoutExerciseId, setIndex, 'weight', 5)}>+</button>
                            {/if}
                          </div>
                        </div>

                        <!-- RIR row -->
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0;">
                          <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="font-weight: 500; color: #333;">RIR</span>
                            <button
                              class="na-btn {isNa(exercise.workoutExerciseId, setIndex, 'rir') ? 'na-btn-active' : ''}"
                              onclick={() => toggleNa(exercise.workoutExerciseId, setIndex, 'rir')}
                              aria-label="Mark RIR as N/A"
                            >N/A</button>
                          </div>
                          <div class="stepper-row">
                            <button class="stepper-btn" onclick={() => stepValue(exercise.workoutExerciseId, setIndex, 'rir', -1)}>-</button>
                            <input
                              type="text"
                              class="stepper-input"
                              value={isNa(exercise.workoutExerciseId, setIndex, 'rir') ? 'N/A' : set.rir}
                              oninput={(e) => handleFieldInput(exercise.workoutExerciseId, setIndex, 'rir', e.target.value)}
                              onfocus={() => clearNa(exercise.workoutExerciseId, setIndex, 'rir')}
                              placeholder={getPlaceholder(exercise.workoutExerciseId, 'rir', '0')}
                            />
                            <button class="stepper-btn" onclick={() => stepValue(exercise.workoutExerciseId, setIndex, 'rir', 1)}>+</button>
                          </div>
                        </div>

                        <!-- Rest Timer (only if restSeconds > 0) -->
                        {#if exercise.restSeconds && exercise.restSeconds > 0}
                          {@const timerDisplay = getRestTimerDisplay(exercise.workoutExerciseId, exercise.restSeconds)}
                          <div class="rest-timer-container">
                            <div
                              class="rest-timer-pill rest-timer-{timerDisplay.mode}"
                              role="group"
                              aria-label="Rest timer"
                            >
                              <!-- Main timer area (idle:start, running:pause, paused:resume, done:acknowledge) -->
                              <button
                                class="rest-timer-main"
                                onclick={() => handleRestTimerTap(exercise.workoutExerciseId, exercise.restSeconds)}
                                onpointerdown={() => handleRestTimerPointerDown(exercise.workoutExerciseId, exercise.restSeconds)}
                                onpointerup={() => handleRestTimerPointerUp(exercise.workoutExerciseId)}
                                onpointerleave={() => handleRestTimerPointerLeave(exercise.workoutExerciseId)}
                                oncontextmenu={(e) => e.preventDefault()}
                              >
                                {#if timerDisplay.mode === 'finished'}
                                  <svg class="rest-done-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="20 6 9 17 4 12"></polyline>
                                  </svg>
                                {/if}
                                {timerDisplay.text}
                              </button>
                              <!-- Reset icon (only visible when not idle) -->
                              {#if timerDisplay.mode !== 'idle'}
                                <button
                                  class="rest-timer-reset"
                                  onclick={(e) => { e.stopPropagation(); resetRestTimer(exercise.workoutExerciseId, exercise.restSeconds); }}
                                  aria-label="Reset timer"
                                  title="Reset timer"
                                >
                                  ↺
                                </button>
                              {/if}
                            </div>
                            <!-- Sound toggle -->
                            <button
                              class="rest-timer-sound-toggle"
                              onclick={toggleRestSfx}
                              aria-label={restSfxEnabled ? 'Rest timer sound on' : 'Rest timer sound off'}
                              title={restSfxEnabled ? 'Sound on' : 'Sound off'}
                            >
                              {#if restSfxEnabled}
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                                </svg>
                              {:else}
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                                  <line x1="22" y1="9" x2="16" y2="15"></line>
                                  <line x1="16" y1="9" x2="22" y2="15"></line>
                                </svg>
                              {/if}
                            </button>
                          </div>
                        {/if}

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

                        <!-- Skip Remaining Sets button - only show if there are remaining sets with empty fields -->
                        {#if hasRemainingSetsWithEmptyFields(exercise.workoutExerciseId) && log.sets.length > 1}
                          <div style="display: flex; justify-content: center; padding-top: 12px; border-top: 1px solid #eee; margin-top: 8px;">
                            <button
                              class="skip-remaining-btn"
                              onclick={() => skipRemainingSets(exercise.workoutExerciseId)}
                              aria-label="Skip remaining sets"
                            >Skip Remaining Sets</button>
                          </div>
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
              <div style="flex: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <h3 style="margin: 0; font-size: 1.1em; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{exercise.name}</h3>
                  {#if libraryEx?.videoUrl?.trim()}
                    <button
                      type="button"
                      aria-label="Play video"
                      onclick={(e) => { e.stopPropagation(); openVideoModal(libraryEx); }}
                      style="background: #fff; border: 1px solid #9C27B0; color: #9C27B0; padding: 2px 6px; border-radius: 4px; font-size: 0.7em; cursor: pointer; flex-shrink: 0;"
                    >▶ Video</button>
                  {/if}
                </div>
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
        <button onclick={finishWorkout} disabled={isSavingFinish} style="padding: 12px 24px; background: {isSavingFinish ? '#90CAF9' : '#2196F3'}; color: white; border: none; cursor: {isSavingFinish ? 'not-allowed' : 'pointer'}; opacity: {isSavingFinish ? 0.7 : 1};">
          {isSavingFinish ? 'Saving…' : 'Finish Workout'}
        </button>
      {/if}
    </div>
  {:else}
    <p>No exercises in this section.</p>
  {/if}
{:else}
  <p>Loading workout...</p>
{/if}


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
              {#if set.customInputs}{#each Object.entries(set.customInputs) as [idx, val]}{#if val}{@const req = historyExercise?.customReqs?.filter(r => r.clientInput)?.[parseInt(idx)]}<div style="color: #9c27b0; font-size: 0.8em; margin: 0 0 4px 50px;">{req?.name || `Custom ${parseInt(idx)+1}`}: {val}{#if req?.value}&nbsp;(Target: {req.value}){/if}</div>{/if}{/each}{/if}
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

<!-- Saving Overlay (appears after 3s if still saving) -->
{#if isSavingFinish && showSavingHint && !showVerificationError}
  <div
    role="status"
    aria-live="polite"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2000;"
  >
    <div style="background: white; border-radius: 8px; padding: 24px 32px; max-width: 90%; width: 300px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); text-align: center;">
      <p style="margin: 0 0 8px 0; font-size: 1.1em; font-weight: 500;">Saving… keep this tab open.</p>
      <p style="margin: 0; font-size: 0.85em; color: #666;">This can take a moment on slow connections.</p>
    </div>
  </div>
{/if}

<!-- Verification Error Dialog -->
{#if showVerificationError}
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Save verification error"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2001;"
  >
    <div style="background: white; border-radius: 8px; padding: 20px; max-width: 90%; width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <h3 style="margin: 0 0 12px 0; font-size: 1.1em; color: #d32f2f;">Workout not saved</h3>
      <p style="margin: 0 0 16px 0; color: #666; font-size: 0.9em;">Some sets did not persist. Please try again.</p>
      <div style="display: flex; justify-content: flex-end;">
        <button
          onclick={dismissVerificationError}
          style="padding: 8px 16px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer;"
        >OK</button>
      </div>
    </div>
  </div>
{/if}

<!-- Zero Sets Confirmation Dialog -->
{#if showZeroSetsConfirm}
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Zero sets confirmation"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2001;"
    onclick={(e) => { if (e.target === e.currentTarget) cancelZeroSetsConfirm(); }}
    onkeydown={(e) => { if (e.key === 'Escape') cancelZeroSetsConfirm(); }}
  >
    <div style="background: white; border-radius: 8px; padding: 20px; max-width: 90%; width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <h3 style="margin: 0 0 12px 0; font-size: 1.1em;">You have 0 logged sets. Save this workout anyway?</h3>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button
          onclick={cancelZeroSetsConfirm}
          style="padding: 8px 16px; background: #fff; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;"
        >Cancel</button>
        <button
          onclick={confirmZeroSetsSave}
          style="padding: 8px 16px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer;"
        >Save anyway</button>
      </div>
    </div>
  </div>
{/if}

<!-- Video Confirm Dialog -->
{#if pendingVideoExercise}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Open video confirmation"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2001;"
    onclick={(e) => { if (e.target === e.currentTarget) cancelOpenVideo(); }}
    onkeydown={handleConfirmKeydown}
  >
    <div style="background: white; border-radius: 8px; padding: 20px; max-width: 90%; width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <h3 style="margin: 0 0 12px 0; font-size: 1.1em;">Open video?</h3>
      <p style="margin: 0 0 20px 0; color: #666; font-size: 0.9em;">This video may load content from an external site (e.g., YouTube).</p>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button
          onclick={cancelOpenVideo}
          style="padding: 8px 16px; background: #fff; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;"
        >Cancel</button>
        <button
          onclick={confirmOpenVideo}
          style="padding: 8px 16px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer;"
        >Continue</button>
      </div>
    </div>
  </div>
{/if}

<!-- Stopwatch Focus Mode -->
{#if focusMode}
  {@const sw = getStopwatch(focusMode.workoutExerciseId, focusMode.setIndex)}
  {@const allReqs = (focusMode.customReqs || []).filter(r => r.name && r.value)}
  <div
    class="focus-mode-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="Stopwatch focus mode"
  >
    <div class="focus-mode-content">
      <!-- Header with close button -->
      <div class="focus-mode-header">
        <h2 class="focus-mode-title">{focusMode.exerciseName}</h2>
        <button
          class="focus-mode-close"
          onclick={closeFocusMode}
          aria-label="Close focus mode"
        >✕</button>
      </div>

      <!-- Set indicator -->
      <div class="focus-mode-set-indicator">Set {focusMode.setIndex + 1}</div>

      <!-- Large timer display -->
      <div class="focus-mode-timer {sw.state}">
        {formatStopwatchTime(sw.elapsed)}
      </div>

      <!-- Target info (if assigned) -->
      {#if focusMode.targetTime || focusMode.targetRir}
        <div class="focus-mode-targets">
          {#if focusMode.targetTime}
            <span class="focus-mode-target">Target: {focusMode.targetTime}</span>
          {/if}
          {#if focusMode.targetRir}
            <span class="focus-mode-target">RIR: {focusMode.targetRir}</span>
          {/if}
        </div>
      {/if}

      <!-- Custom requirements (read-only, shows all including input-required) -->
      {#if allReqs.length > 0}
        <div class="focus-mode-reqs">
          {#each allReqs as req}
            <span class="focus-mode-req">{req.name}: {req.value}</span>
          {/each}
        </div>
      {/if}

      <!-- Controls -->
      <div class="focus-mode-controls">
        {#if sw.state === 'idle'}
          <button
            class="focus-mode-btn focus-mode-btn-primary"
            onclick={() => startStopwatch(focusMode.workoutExerciseId, focusMode.setIndex)}
          >
            Start
          </button>
        {:else if sw.state === 'running'}
          <button
            class="focus-mode-btn focus-mode-btn-primary"
            onclick={() => stopStopwatch(focusMode.workoutExerciseId, focusMode.setIndex)}
          >
            Stop
          </button>
        {:else if sw.state === 'stopped'}
          <div class="focus-mode-btn-row">
            <button
              class="focus-mode-btn focus-mode-btn-secondary"
              onclick={() => resumeStopwatch(focusMode.workoutExerciseId, focusMode.setIndex)}
            >
              Resume
            </button>
            <button
              class="focus-mode-btn focus-mode-btn-primary"
              onclick={() => finishStopwatch(focusMode.workoutExerciseId, focusMode.setIndex)}
            >
              Finish
            </button>
          </div>
        {/if}

        <!-- Reset button (when not idle) -->
        {#if sw.state !== 'idle'}
          <button
            class="focus-mode-btn focus-mode-btn-reset"
            onclick={() => resetStopwatch(focusMode.workoutExerciseId, focusMode.setIndex)}
          >
            ↺ Reset
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- Rest Done Global Toast -->
{#if activeRestDone}
  <div class="rest-done-toast" role="alert" aria-live="assertive">
    <div class="rest-done-toast-content">
      <svg class="rest-done-toast-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      <span class="rest-done-toast-text">Rest complete — {activeRestDone.exerciseName}</span>
      <button class="rest-done-toast-btn rest-done-toast-btn-view" onclick={viewRestDoneExercise}>
        View
      </button>
      <button class="rest-done-toast-btn" onclick={acknowledgeRestDone}>
        Acknowledge
      </button>
    </div>
  </div>
{/if}

<!-- Video Modal -->
{#if videoModalExercise}
  {@const ytId = getYouTubeId(videoModalExercise.videoUrl)}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Video player"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 2000;"
    onclick={(e) => { if (e.target === e.currentTarget) closeVideoModal(); }}
    onkeydown={handleVideoModalKeydown}
  >
    <div style="background: white; border-radius: 8px; max-width: 90%; width: 640px; max-height: 90vh; overflow: auto;">
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px; border-bottom: 1px solid #eee;">
        <h3 style="margin: 0;">{videoModalExercise.name}</h3>
        <button
          onclick={closeVideoModal}
          aria-label="Close"
          style="background: none; border: none; font-size: 1.5em; cursor: pointer; padding: 4px 8px;"
        >&times;</button>
      </div>
      <div style="padding: 16px;">
        {#if ytId}
          <div style="position: relative; padding-bottom: 56.25%; height: 0;">
            <iframe
              src="https://www.youtube.com/embed/{ytId}"
              title="Video player"
              frameborder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen
              style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border-radius: 4px;"
            ></iframe>
          </div>
        {:else}
          <p style="margin: 0 0 12px 0;">This video cannot be embedded.</p>
          <a
            href={videoModalExercise.videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            style="display: inline-block; padding: 10px 20px; background: #2196F3; color: white; text-decoration: none; border-radius: 4px;"
          >Open link</a>
        {/if}
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

  /* Rest Timer Styles */
  .rest-timer-container {
    display: flex;
    justify-content: center;
    padding: 8px 0;
  }

  .rest-timer-pill {
    display: inline-flex;
    align-items: center;
    border-radius: 8px;
    background: #f5f5f5;
    border: 1px solid #e0e0e0;
    overflow: hidden;
    transition: all 0.2s ease;
  }

  .rest-timer-main {
    padding: 8px 16px;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 500;
    color: #333;
    user-select: none;
    -webkit-user-select: none;
    transition: background 0.15s ease;
    white-space: nowrap;
  }

  .rest-timer-main:hover {
    background: rgba(0, 0, 0, 0.04);
  }

  .rest-timer-main:active {
    background: rgba(0, 0, 0, 0.08);
  }

  .rest-timer-reset {
    padding: 8px 12px;
    border: none;
    border-left: 1px solid #e0e0e0;
    background: transparent;
    cursor: pointer;
    font-size: 1em;
    color: #666;
    user-select: none;
    -webkit-user-select: none;
    transition: all 0.15s ease;
    min-width: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .rest-timer-reset:hover {
    background: rgba(0, 0, 0, 0.04);
    color: #333;
  }

  .rest-timer-reset:active {
    background: rgba(0, 0, 0, 0.08);
  }

  /* State-specific styling */
  .rest-timer-idle {
    background: #fafafa;
    border-color: #e0e0e0;
  }

  .rest-timer-idle .rest-timer-main {
    color: #555;
  }

  .rest-timer-running {
    background: #fff8e1;
    border-color: #ffb300;
  }

  .rest-timer-running .rest-timer-main {
    color: #e65100;
    font-weight: 600;
  }

  .rest-timer-running .rest-timer-reset {
    border-left-color: #ffcc80;
  }

  .rest-timer-paused {
    background: #f5f5f5;
    border-color: #bdbdbd;
  }

  .rest-timer-paused .rest-timer-main {
    color: #616161;
  }

  .rest-timer-paused .rest-timer-reset {
    border-left-color: #e0e0e0;
  }

  .rest-timer-finished {
    background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%);
    border-color: #4caf50;
    box-shadow: 0 2px 8px rgba(76, 175, 80, 0.25);
  }

  .rest-timer-finished .rest-timer-main {
    color: #2e7d32;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .rest-timer-finished .rest-done-check {
    color: #2e7d32;
    flex-shrink: 0;
  }

  .rest-timer-finished .rest-timer-reset {
    border-left-color: #81c784;
  }

  /* Rest Done Global Toast */
  .rest-done-toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1500;
    max-width: calc(100vw - 32px);
  }

  .rest-done-toast-content {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 20px;
    background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%);
    border: 1px solid #4caf50;
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(76, 175, 80, 0.3);
  }

  .rest-done-toast-icon {
    color: #2e7d32;
    flex-shrink: 0;
  }

  .rest-done-toast-text {
    color: #1b5e20;
    font-weight: 600;
    font-size: 0.95em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rest-done-toast-btn {
    padding: 8px 16px;
    border: none;
    border-radius: 8px;
    background: #4caf50;
    color: white;
    font-weight: 600;
    font-size: 0.9em;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s ease;
  }

  .rest-done-toast-btn:hover {
    background: #43a047;
  }

  .rest-done-toast-btn:active {
    background: #388e3c;
  }

  .rest-done-toast-btn-view {
    background: transparent;
    color: #2e7d32;
    border: 1px solid #4caf50;
  }

  .rest-done-toast-btn-view:hover {
    background: rgba(76, 175, 80, 0.1);
  }

  .rest-done-toast-btn-view:active {
    background: rgba(76, 175, 80, 0.2);
  }

  @media (max-width: 480px) {
    .rest-done-toast {
      bottom: 16px;
      left: 16px;
      right: 16px;
      transform: none;
      max-width: none;
    }

    .rest-done-toast-content {
      padding: 12px 16px;
      gap: 10px;
    }

    .rest-done-toast-text {
      font-size: 0.9em;
      flex: 1;
      min-width: 0;
    }

    .rest-done-toast-btn {
      padding: 8px 14px;
      font-size: 0.85em;
    }
  }

  /* Sound toggle button */
  .rest-timer-sound-toggle {
    width: 28px;
    height: 28px;
    margin-left: 6px;
    padding: 0;
    border: 1px solid #e0e0e0;
    background: #fafafa;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #666;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .rest-timer-sound-toggle:hover {
    background: #f0f0f0;
    border-color: #ccc;
    color: #333;
  }

  .rest-timer-sound-toggle:active {
    background: #e8e8e8;
  }

  .rest-timer-sound-toggle svg {
    display: block;
  }

  /* Desktop responsive sizing */
  @media (min-width: 768px) {
    .rest-timer-pill {
      border-radius: 10px;
    }

    .rest-timer-main {
      padding: 12px 28px;
      font-size: 1.1em;
    }

    .rest-timer-reset {
      padding: 12px 16px;
      font-size: 1.2em;
      min-width: 44px;
    }

    .rest-timer-sound-toggle {
      width: 32px;
      height: 32px;
      margin-left: 8px;
    }

    .rest-timer-sound-toggle svg {
      width: 18px;
      height: 18px;
    }
  }

  /* Stopwatch Trigger Button */
  .stopwatch-trigger {
    width: 44px;
    height: 44px;
    border: 1px solid #e0e0e0;
    background: #fafafa;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1.3em;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .stopwatch-trigger:hover {
    background: #f0f0f0;
    border-color: #667eea;
  }

  .stopwatch-trigger:active {
    background: #e8e8e8;
  }

  /* Focus Mode Overlay */
  .focus-mode-overlay {
    position: fixed;
    inset: 0;
    background: #1a1a2e;
    z-index: 2500;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .focus-mode-content {
    width: 100%;
    max-width: 400px;
    text-align: center;
    color: white;
  }

  .focus-mode-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .focus-mode-title {
    margin: 0;
    font-size: 1.3em;
    font-weight: 600;
    color: white;
  }

  .focus-mode-close {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: white;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 1.2em;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s ease;
  }

  .focus-mode-close:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  .focus-mode-set-indicator {
    font-size: 0.9em;
    color: rgba(255, 255, 255, 0.6);
    margin-bottom: 24px;
  }

  .focus-mode-timer {
    font-size: 5em;
    font-weight: 300;
    font-variant-numeric: tabular-nums;
    margin: 32px 0;
    letter-spacing: 2px;
    transition: color 0.2s ease;
  }

  .focus-mode-timer.idle {
    color: rgba(255, 255, 255, 0.5);
  }

  .focus-mode-timer.running {
    color: #ffb300;
  }

  .focus-mode-timer.stopped {
    color: white;
  }

  .focus-mode-targets {
    display: flex;
    justify-content: center;
    gap: 16px;
    margin-bottom: 16px;
  }

  .focus-mode-target {
    background: rgba(255, 255, 255, 0.1);
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 0.9em;
    color: rgba(255, 255, 255, 0.8);
  }

  .focus-mode-reqs {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-bottom: 24px;
  }

  .focus-mode-req {
    background: rgba(255, 255, 255, 0.08);
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 0.85em;
    color: rgba(255, 255, 255, 0.7);
  }

  .focus-mode-controls {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    margin-top: 32px;
  }

  .focus-mode-btn-row {
    display: flex;
    gap: 12px;
  }

  .focus-mode-btn {
    padding: 14px 32px;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1.1em;
    font-weight: 500;
    transition: all 0.15s ease;
    min-width: 120px;
  }

  .focus-mode-btn-primary {
    background: #667eea;
    color: white;
  }

  .focus-mode-btn-primary:hover {
    background: #5a6fd6;
  }

  .focus-mode-btn-primary:active {
    background: #4e5fc2;
  }

  .focus-mode-btn-secondary {
    background: rgba(255, 255, 255, 0.15);
    color: white;
  }

  .focus-mode-btn-secondary:hover {
    background: rgba(255, 255, 255, 0.25);
  }

  .focus-mode-btn-reset {
    background: transparent;
    color: rgba(255, 255, 255, 0.5);
    font-size: 0.9em;
    padding: 8px 16px;
    min-width: auto;
  }

  .focus-mode-btn-reset:hover {
    color: rgba(255, 255, 255, 0.8);
  }

  /* Desktop responsive sizing for Focus Mode */
  @media (min-width: 768px) {
    .focus-mode-content {
      max-width: 500px;
    }

    .focus-mode-title {
      font-size: 1.5em;
    }

    .focus-mode-timer {
      font-size: 7em;
      margin: 48px 0;
    }

    .focus-mode-btn {
      padding: 16px 40px;
      font-size: 1.2em;
      min-width: 140px;
    }
  }

  /* Session Timer */
  .session-timer {
    font-size: 1.1em;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: #555;
    background: #f5f5f5;
    padding: 6px 12px;
    border-radius: 6px;
    white-space: nowrap;
  }

  @media (min-width: 768px) {
    .session-timer {
      font-size: 1.3em;
      padding: 8px 16px;
    }
  }

  /* N/A Button Styles */
  .na-btn {
    padding: 2px 6px;
    font-size: 0.7em;
    font-weight: 500;
    border: 1px solid #ddd;
    border-radius: 4px;
    background: #fafafa;
    color: #888;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .na-btn:hover {
    border-color: #bbb;
    background: #f0f0f0;
  }

  .na-btn-active {
    background: #e3f2fd;
    border-color: #90caf9;
    color: #1565c0;
  }

  .na-btn-active:hover {
    background: #bbdefb;
    border-color: #64b5f6;
  }

  /* Skip Set Button */
  .skip-set-btn {
    padding: 2px 8px;
    font-size: 0.7em;
    font-weight: 500;
    border: 1px solid #ddd;
    border-radius: 4px;
    background: #fafafa;
    color: #666;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .skip-set-btn:hover {
    border-color: #bbb;
    background: #f0f0f0;
    color: #333;
  }

  .skip-set-btn:active {
    background: #e8e8e8;
  }

  /* Skip Remaining Sets Button */
  .skip-remaining-btn {
    padding: 6px 14px;
    font-size: 0.85em;
    font-weight: 500;
    border: 1px solid #ddd;
    border-radius: 6px;
    background: #fafafa;
    color: #666;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .skip-remaining-btn:hover {
    border-color: #bbb;
    background: #f0f0f0;
    color: #333;
  }

  .skip-remaining-btn:active {
    background: #e8e8e8;
  }

  /* Stepper Row (- value +) */
  .stepper-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .stepper-btn {
    width: 44px;
    height: 44px;
    border: none;
    background: transparent;
    font-size: 1.5em;
    color: #667eea;
    cursor: pointer;
  }

  .stepper-input {
    width: 60px;
    padding: 8px 0;
    border: none;
    background: transparent;
    font-size: 1.2em;
    text-align: center;
    outline: none;
    box-shadow: none !important;
    -webkit-appearance: none;
    appearance: none;
    border-radius: 0;
    text-decoration: none;
  }

  .stepper-input-time {
    width: 70px;
  }

  /* Mobile: tighter stepper spacing */
  @media (max-width: 600px) {
    .stepper-row {
      gap: 4px;
    }

    .stepper-btn {
      width: 40px;
      height: 40px;
      font-size: 1.4em;
    }

    .stepper-input {
      width: 55px;
      font-size: 1.1em;
    }

    .stepper-input-time {
      width: 65px;
    }
  }
</style>
