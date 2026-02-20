<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, query, where, getDocs, orderBy, doc, getDoc, deleteDoc, writeBatch, increment } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import SessionDetailModal from '$lib/components/SessionDetailModal.svelte';

  let currentUserId = $state(null);
  let userRole = $state(null);
  let allUsers = $state([]);
  let selectedUserId = $state(null);
  let workoutSessions = $state([]);
  let prStoreData = $state([]); // Rep-band PRs from Firestore PR store
  let allLogs = $state([]);
  let loading = $state(true);
  let activeTab = $state('workouts'); // 'workouts' or 'prs'

  // Derived target user for queries (admin can view other users)
  function getTargetUserId() {
    return (userRole === 'admin' && selectedUserId) ? selectedUserId : currentUserId;
  }

  // Sort users by first name for dropdown
  function getSortedUsers() {
    return allUsers.slice().sort((a, b) => {
      const aName = (a.displayName?.split(' ')[0] || a.email || '').toLowerCase();
      const bName = (b.displayName?.split(' ')[0] || b.email || '').toLowerCase();
      return aName.localeCompare(bName);
    });
  }
  let selectedSession = $state(null);
  let selectedExercise = $state(null);
  let exerciseSessions = $state([]);
  let selectedExerciseSession = $state(null);
  let exerciseSessionSets = $state([]);
  let programsCache = $state({});
  let selectedExerciseHistory = $state(null); // e1rm and repRanges for selected exercise

  // Performance Analysis state
  let analysisExerciseId = $state('');
  let analysisMetric = $state('weight'); // 'weight' | 'volume' | 'e1rm'
  let windowMode = $state('time'); // 'time' | 'sessions'
  let timeWindow = $state('all'); // 'week' | 'month' | 'year' | 'all'
  let sessionsWindow = $state(10); // 5 | 10 | 20 | 50
  let aggregationMode = $state('raw'); // 'raw' | 'average'
  let avgByTime = $state('month'); // 'week' | 'month' | 'year'
  let avgBySessions = $state(5); // 5 | 10 | 20 | 50
  let analysisCustomReqIdx = $state('');
  let dotLabelMetric = $state('none'); // 'none' | 'weight' | 'volume' | 'e1rm' | 'pct_e1rm'

  // Axis labels (derived)
  let yAxisLabel = $derived(analysisMetric === 'weight' ? 'Weight' : analysisMetric === 'volume' ? 'Volume' : analysisMetric === 'e1rm' ? 'Estimated 1RM' : analysisMetric === 'pct_e1rm' ? 'Intensity (%)' : (getCustomReqOptions().find(r => r.idx === analysisCustomReqIdx)?.name || 'Custom'));
  let xAxisLabel = $derived(windowMode === 'sessions' ? 'Session' : (timeWindow === 'week' ? 'Week' : timeWindow === 'month' ? 'Month' : timeWindow === 'year' ? 'Year' : 'Date'));

  async function loadProgram(programId) {
    if (!programId || programsCache[programId]) return;
    const snap = await getDoc(doc(db, 'programs', programId));
    if (snap.exists()) { programsCache[programId] = snap.data(); programsCache = { ...programsCache }; }
  }

  function getCustomReqs(programId, workoutExerciseId) {
    const p = programsCache[programId];
    if (!p?.publishedDays) return null;
    for (const d of p.publishedDays) for (const s of d.sections || []) for (const e of s.exercises || [])
      if (e.workoutExerciseId === workoutExerciseId) return e.customReqs?.filter(r => r.clientInput) || [];
    return null;
  }

  // Compute missing sets for a session (Full Tracking only)
  function getMissingSets(session) {
    if (!session?.programId || !session?.dayName) return [];
    const program = programsCache[session.programId];
    const dayTemplate = program?.publishedDays?.find(d => d.name === session.dayName);
    if (!dayTemplate?.sections) return [];

    // Get logs for this session
    const sessionLogs = allLogs.filter(log => log.completedWorkoutId === session.id);

    // Build map of logged set numbers per exercise key
    const loggedByExercise = {};
    sessionLogs.forEach(log => {
      const key = log.workoutExerciseId || log.exerciseId;
      if (!key) return;
      if (!loggedByExercise[key]) loggedByExercise[key] = new Set();
      loggedByExercise[key].add(log.setNumber || 1);
    });

    const missing = [];
    for (const section of dayTemplate.sections) {
      if (section.mode === 'checkbox') continue;
      for (const exercise of section.exercises || []) {
        const key = exercise.workoutExerciseId || exercise.exerciseId;
        const prescribedCount = parseInt(exercise.sets) || 3;
        const loggedSets = loggedByExercise[key] || new Set();
        // Count how many of sets 1..prescribedCount are NOT logged
        let missingCount = 0;
        for (let i = 1; i <= prescribedCount; i++) {
          if (!loggedSets.has(i)) missingCount++;
        }
        if (missingCount > 0) {
          missing.push({ name: exercise.name, count: missingCount });
        }
      }
    }
    return missing;
  }

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUserId = user.uid;

        // Fetch user role
        try {
          const userDoc = await getDoc(doc(db, 'user', user.uid));
          userRole = userDoc.exists() ? (userDoc.data().role || 'client') : 'client';
        } catch (e) {
          userRole = 'client';
        }

        // If admin, set default selection and load all users
        if (userRole === 'admin') {
          selectedUserId = user.uid;
          try {
            const usersSnap = await getDocs(collection(db, 'user'));
            allUsers = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          } catch (e) {
            console.log('Could not load users:', e);
          }
        }

        await Promise.all([loadWorkoutSessions(), loadAllLogs(), loadPRStoreData()]);
      }
      loading = false;
    });
  });

  // Reload data when admin changes selected user
  $effect(() => {
    if (userRole === 'admin' && selectedUserId && !loading) {
      loadWorkoutSessions();
      loadAllLogs();
      loadPRStoreData();
    }
  });

  async function loadWorkoutSessions() {
    const targetUserId = getTargetUserId();
    if (!targetUserId) return;

    try {
      const sessionsQuery = query(
        collection(db, 'workoutSessions'),
        where('userId', '==', targetUserId)
      );
      const snapshot = await getDocs(sessionsQuery);
      workoutSessions = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const dateA = a.finishedAt?.toDate ? a.finishedAt.toDate() : new Date(a.finishedAt);
          const dateB = b.finishedAt?.toDate ? b.finishedAt.toDate() : new Date(b.finishedAt);
          return dateB - dateA;
        });
    } catch (e) {
      console.log('Could not load sessions:', e);
    }
  }

  async function loadAllLogs() {
    const targetUserId = getTargetUserId();
    if (!targetUserId) return;

    try {
      const logsQuery = query(
        collection(db, 'workoutLogs'),
        where('userId', '==', targetUserId)
      );
      const snapshot = await getDocs(logsQuery);
      allLogs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      // Note: PRs are now loaded from Firestore PR store, not computed from logs
    } catch (e) {
      console.log('Could not load logs:', e);
    }
  }

  // Load all rep-band PRs from Firestore PR store
  // Path: user/{uid}/stats/prs/exercisePrs/{exerciseId}__{bandKey}
  async function loadPRStoreData() {
    const targetUserId = getTargetUserId();
    if (!targetUserId) return;

    try {
      const prsRef = collection(db, 'user', targetUserId, 'stats', 'prs', 'exercisePrs');
      const snapshot = await getDocs(prsRef);

      const prs = [];
      snapshot.docs.forEach(docSnap => {
        const data = docSnap.data();
        const docId = docSnap.id; // Format: {exerciseId}__{bandKey}
        const parts = docId.split('__');
        if (parts.length !== 2) return;

        const exerciseId = parts[0];
        const bandKey = parts[1]; // e.g., "1_5", "6_8", "9_12", "13_plus"

        // Convert bandKey back to display format
        let repBand = bandKey.replace('_plus', '+').replace('_', '-');

        prs.push({
          exerciseId,
          exerciseName: data.exerciseNameSnapshot || data.exerciseName || 'Unknown Exercise',
          repBand,
          weight: data.bestWeight,
          reps: data.bestReps,
          date: data.achievedAt,
          dayName: data.dayName || ''
        });
      });

      // Sort by exercise name, then by rep band
      prs.sort((a, b) => {
        const nameCompare = a.exerciseName.localeCompare(b.exerciseName);
        if (nameCompare !== 0) return nameCompare;
        // Sort bands: 1-5, 6-8, 9-12, 13+
        const bandOrder = { '1-5': 1, '6-8': 2, '9-12': 3, '13+': 4 };
        return (bandOrder[a.repBand] || 99) - (bandOrder[b.repBand] || 99);
      });

      prStoreData = prs;
    } catch (e) {
      console.log('Could not load PR store data:', e);
      prStoreData = [];
    }
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function formatFullDate(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function getSessionLogs(session) {
    // Filter logs by unique session ID (completedWorkoutId)
    const sessionLogs = allLogs.filter(log => log.completedWorkoutId === session.id);

    // Group sets by exercise for display within this session
    const groupedByExercise = {};
    sessionLogs.forEach(log => {
      const key = log.workoutExerciseId || log.exerciseId;
      if (!groupedByExercise[key]) {
        groupedByExercise[key] = {
          workoutExerciseId: log.workoutExerciseId,
          exerciseId: log.exerciseId,
          exerciseName: log.exerciseName,
          sets: []
        };
      }
      groupedByExercise[key].sets.push({
        id: log.id, // Include log ID for deletion
        setNumber: log.setNumber || 1,
        reps: log.reps,
        weight: log.weight,
        rir: log.rir,
        notes: log.notes,
        repsMetric: log.repsMetric || 'reps',
        weightMetric: log.weightMetric || 'weight',
        customInputs: log.customInputs,
        workoutExerciseId: log.workoutExerciseId,
        programId: log.programId
      });
    });

    // Sort sets within each exercise
    return Object.values(groupedByExercise).map(exercise => {
      exercise.sets.sort((a, b) => a.setNumber - b.setNumber);
      return exercise;
    });
  }

  function getPRsList() {
    // Return PRs from Firestore PR store (not computed from logs)
    return prStoreData;
  }

  // Get grouped PRs by exercise (for consolidated cards)
  function getGroupedPRs() {
    // Group PRs by exerciseId
    const groups = {};
    prStoreData.forEach(pr => {
      if (!groups[pr.exerciseId]) {
        groups[pr.exerciseId] = {
          exerciseId: pr.exerciseId,
          exerciseName: pr.exerciseName,
          bands: []
        };
      }
      groups[pr.exerciseId].bands.push(pr);
      // Update exercise name if this one is better (non-Unknown)
      if (pr.exerciseName && pr.exerciseName !== 'Unknown Exercise') {
        groups[pr.exerciseId].exerciseName = pr.exerciseName;
      }
    });

    // For each group, sort bands and compute hero
    const bandOrder = { '1-5': 1, '6-8': 2, '9-12': 3, '13+': 4 };

    return Object.values(groups).map(group => {
      // Sort bands in standard order
      group.bands.sort((a, b) => (bandOrder[a.repBand] || 99) - (bandOrder[b.repBand] || 99));

      // Compute hero: highest weight, then highest reps, then most recent
      let hero = group.bands[0];
      for (const band of group.bands) {
        if (band.weight > hero.weight) {
          hero = band;
        } else if (band.weight === hero.weight) {
          if (band.reps > hero.reps) {
            hero = band;
          } else if (band.reps === hero.reps) {
            // Tie-breaker: most recent
            const heroDate = hero.date?.toDate ? hero.date.toDate() : new Date(hero.date || 0);
            const bandDate = band.date?.toDate ? band.date.toDate() : new Date(band.date || 0);
            if (bandDate > heroDate) {
              hero = band;
            }
          }
        }
      }

      group.hero = hero;
      return group;
    }).sort((a, b) => a.exerciseName.localeCompare(b.exerciseName));
  }

  // Get rep band for a given rep count
  function getRepBand(reps) {
    const r = parseInt(reps) || 0;
    if (r >= 1 && r <= 5) return '1-5';
    if (r >= 6 && r <= 8) return '6-8';
    if (r >= 9 && r <= 12) return '9-12';
    if (r >= 13) return '13+';
    return null;
  }

  // Get rep band display label
  function getRepBandLabel(band) {
    const labels = {
      '1-5': '1–5 REP PR',
      '6-8': '6–8 REP PR',
      '9-12': '9–12 REP PR',
      '13+': '13+ REP PR'
    };
    return labels[band] || band;
  }

  // Get rep band color (gold for 13+ instead of orange)
  function getRepBandColor(band) {
    const colors = {
      '1-5': '#1565c0',   // blue
      '6-8': '#7b1fa2',   // purple
      '9-12': '#2e7d32',  // green
      '13+': '#b8860b'    // dark gold
    };
    return colors[band] || '#666';
  }

  // Get rep band background tint
  function getRepBandBg(band) {
    const bgs = {
      '1-5': '#e3f2fd',   // light blue
      '6-8': '#f3e5f5',   // light purple
      '9-12': '#e8f5e9',  // light green
      '13+': '#fef3c7'    // light gold
    };
    return bgs[band] || '#f5f5f5';
  }

  // Load rep-band PRs from Firestore PR store
  // Path: user/{uid}/stats/prs/exercisePrs/{exerciseId}__{repBandKey}
  // Returns: { '1-5': PR|null, '6-8': PR|null, '9-12': PR|null, '13+': PR|null }
  async function loadExerciseRepBandPrs(userId, exerciseId) {
    const bands = ['1-5', '6-8', '9-12', '13+'];
    const result = { '1-5': null, '6-8': null, '9-12': null, '13+': null };

    const readPromises = bands.map(band => {
      const bandKey = band.replace('-', '_').replace('+', '_plus');
      const docId = `${exerciseId}__${bandKey}`;
      const prRef = doc(db, 'user', userId, 'stats', 'prs', 'exercisePrs', docId);

      return getDoc(prRef)
        .then(snap => ({ band, snap, error: null }))
        .catch(err => ({ band, snap: null, error: err }));
    });

    const results = await Promise.all(readPromises);

    for (const { band, snap, error } of results) {
      if (error) {
        console.error(`Failed to read PR for band ${band}:`, error);
        continue;
      }
      if (snap && snap.exists()) {
        const data = snap.data();
        result[band] = {
          weight: data.bestWeight,
          reps: data.bestReps,
          date: data.achievedAt,
          notes: null // PR store doesn't include notes
        };
      }
    }

    return result;
  }

  async function openExerciseHistory(exerciseId, exerciseName) {
    selectedExercise = { exerciseId, exerciseName };

    // Clear stale data immediately to prevent orphan PR display
    selectedExerciseHistory = { e1rm: null, repRanges: { '1-5': null, '6-8': null, '9-12': null, '13+': null } };
    exerciseSessions = [];
    selectedExerciseSession = null;
    exerciseSessionSets = [];

    const targetUserId = getTargetUserId();

    // Load rep-band PRs from Firestore PR store (parallel with log processing)
    const repRangesPromise = loadExerciseRepBandPrs(targetUserId, exerciseId);

    // Get unique sessions for this exercise (last 10)
    const exerciseLogs = allLogs.filter(l => l.exerciseId === exerciseId && l.completedWorkoutId);

    const sessionMap = {};
    const programIds = new Set();

    // Calculate e1rm from logs (still needed, not stored in PR store)
    let best1RM = null;

    exerciseLogs.forEach(log => {
      if (log.programId) programIds.add(log.programId);
      if (!sessionMap[log.completedWorkoutId]) {
        sessionMap[log.completedWorkoutId] = { id: log.completedWorkoutId, date: log.loggedAt, dayName: log.dayName };
      }

      const weight = parseFloat(log.weight) || 0;
      const reps = parseInt(log.reps) || 0;
      if (weight <= 0 || reps <= 0) return;

      // Calculate estimated 1RM using Epley formula: weight × (1 + reps/30)
      const e1rm = weight * (1 + reps / 30);
      if (!best1RM || e1rm > best1RM.e1rm) {
        best1RM = { e1rm: Math.round(e1rm), weight, reps, date: log.loggedAt, notes: log.notes };
      }
    });

    // Wait for rep-band PRs from Firestore
    let repRanges = { '1-5': null, '6-8': null, '9-12': null, '13+': null };
    try {
      repRanges = await repRangesPromise;
    } catch (err) {
      console.error('Failed to load rep-band PRs:', err);
    }

    selectedExerciseHistory = { e1rm: best1RM, repRanges };

    programIds.forEach(pid => loadProgram(pid));
    exerciseSessions = Object.values(sessionMap)
      .sort((a, b) => {
        const da = a.date?.toDate ? a.date.toDate() : new Date(a.date);
        const db = b.date?.toDate ? b.date.toDate() : new Date(b.date);
        return db - da;
      })
      .slice(0, 10);
    if (exerciseSessions.length > 0) selectExerciseSession(exerciseSessions[0]);
  }

  function selectExerciseSession(session) {
    selectedExerciseSession = session;
    const sets = allLogs
      .filter(l => l.completedWorkoutId === session.id && l.exerciseId === selectedExercise.exerciseId)
      .sort((a, b) => (a.setNumber || 1) - (b.setNumber || 1));
    exerciseSessionSets = sets;
  }

  function closeExerciseHistory() {
    selectedExercise = null;
    exerciseSessions = [];
    selectedExerciseSession = null;
    exerciseSessionSets = [];
    selectedExerciseHistory = null;
  }

  // Helper: Delete session doc and ledger, adjusting aggregates as needed
  // Assumes logs are already deleted from Firestore and allLogs is updated
  async function deleteSessionAndLedger(sessionId) {
    const targetUserId = getTargetUserId();
    const ledgerRef = doc(db, 'user', targetUserId, 'stats', `sessionTonnage_${sessionId}`);
    const ledgerSnap = await getDoc(ledgerRef);

    if (ledgerSnap.exists()) {
      const ledgerData = ledgerSnap.data();
      const tonnage = Number(ledgerData?.tonnage || 0);
      const monthKey = ledgerData?.monthKey;
      const yearKey = ledgerData?.yearKey;

      const batch = writeBatch(db);

      // Only decrement aggregates if tonnage > 0 and keys are valid
      if (tonnage > 0 && monthKey && yearKey) {
        const monthRef = doc(db, 'user', targetUserId, 'stats', `tonnage_${monthKey}`);
        const yearRef = doc(db, 'user', targetUserId, 'stats', `tonnage_${yearKey}`);
        batch.update(monthRef, { tonnage: increment(-tonnage) });
        batch.update(yearRef, { tonnage: increment(-tonnage) });
      }

      // ALWAYS delete ledger and session
      batch.delete(ledgerRef);
      batch.delete(doc(db, 'workoutSessions', sessionId));

      await batch.commit();
    } else {
      // No ledger doc - legacy session, delete without aggregate correction
      console.warn('[AE] Legacy session delete: no sessionTonnage ledger found; aggregates unchanged (expected by design)', { sessionId });
      await deleteDoc(doc(db, 'workoutSessions', sessionId));
    }

    // Update UI state
    workoutSessions = workoutSessions.filter(s => s.id !== sessionId);
  }

  async function deleteSession(session) {
    if (!confirm(`Delete "${session.dayName}" workout from ${formatDate(session.finishedAt)}? This cannot be undone.`)) return;
    const targetUserId = getTargetUserId();
    try {
      // Delete all logs for this session from Firestore
      const logsQuery = query(collection(db, 'workoutLogs'), where('userId', '==', targetUserId), where('completedWorkoutId', '==', session.id));
      const logsSnap = await getDocs(logsQuery);

      // Collect IDs of logs being deleted
      const deletedLogIds = new Set(logsSnap.docs.map(d => d.id));

      await Promise.all(logsSnap.docs.map(d => deleteDoc(d.ref)));

      // Update local logs state
      allLogs = allLogs.filter(l => !deletedLogIds.has(l.id));

      // Delete session and ledger (handles aggregates)
      await deleteSessionAndLedger(session.id);

      selectedSession = null;

      // Recalculate PRs
      // PRs now loaded from Firestore PR store (write-forward only)
    } catch (e) { console.error('Delete failed:', e); alert('Failed to delete session'); }
  }

  // TASK 1: Delete all logs for a specific exercise within a session
  async function deleteExerciseLogs(sessionId, exercise) {
    const exerciseKey = exercise.workoutExerciseId || exercise.exerciseId;
    if (!confirm(`Delete all logged sets for "${exercise.exerciseName}"? This cannot be undone.`)) return;

    const targetUserId = getTargetUserId();

    try {
      // Check for tonnage ledger before deletion
      const ledgerRef = doc(db, 'user', targetUserId, 'stats', `sessionTonnage_${sessionId}`);
      const ledgerSnap = await getDoc(ledgerRef);
      const hasLedger = ledgerSnap.exists();
      let oldTonnage = 0;
      let monthKey = '';
      let yearKey = '';

      if (hasLedger) {
        const ledgerData = ledgerSnap.data();
        oldTonnage = ledgerData?.tonnage || 0;
        monthKey = ledgerData?.monthKey || '';
        yearKey = ledgerData?.yearKey || '';
      }

      // Find all log IDs for this exercise in this session
      const logIds = exercise.sets.map(s => s.id).filter(Boolean);

      // Delete from Firestore
      await Promise.all(logIds.map(id => deleteDoc(doc(db, 'workoutLogs', id))));

      // Update local state
      allLogs = allLogs.filter(l => !logIds.includes(l.id));

      // Check if session is now empty (no exercises remain)
      const remainingSessionLogs = allLogs.filter(l => l.completedWorkoutId === sessionId);
      if (remainingSessionLogs.length === 0) {
        // Session is empty - delete it entirely (handles ledger + aggregates)
        await deleteSessionAndLedger(sessionId);
        selectedSession = null;
        // PRs now loaded from Firestore PR store (write-forward only)
        return; // Skip tonnage delta since session is deleted
      }

      // Session still has exercises - do tonnage delta update
      if (hasLedger && monthKey && yearKey) {
        const newTonnage = computeSessionTonnageFromLogs(sessionId);
        try {
          await updateTonnageAfterSessionEdit(sessionId, oldTonnage, newTonnage, monthKey, yearKey);
        } catch (tonnageError) {
          console.error('Tonnage update failed:', tonnageError);
          // Don't fail the whole operation, just warn
        }
      } else if (!hasLedger) {
        console.warn('[AE] No tonnage ledger for session', sessionId, '- aggregates unchanged (legacy session)');
      }

      // Recalculate PRs
      // PRs now loaded from Firestore PR store (write-forward only)
    } catch (e) {
      console.error('Delete exercise logs failed:', e);
      alert('Failed to delete exercise logs');
    }
  }

  // TASK 2: Delete a single set log from PR modal
  async function deleteSetLog(setId) {
    if (!confirm('Delete this set? This cannot be undone.')) return;

    const targetUserId = getTargetUserId();
    const sessionId = selectedExerciseSession?.id;

    try {
      // Check for tonnage ledger before deletion (if we know the session)
      let hasLedger = false;
      let oldTonnage = 0;
      let monthKey = '';
      let yearKey = '';

      if (sessionId) {
        const ledgerRef = doc(db, 'user', targetUserId, 'stats', `sessionTonnage_${sessionId}`);
        const ledgerSnap = await getDoc(ledgerRef);
        hasLedger = ledgerSnap.exists();

        if (hasLedger) {
          const ledgerData = ledgerSnap.data();
          oldTonnage = ledgerData?.tonnage || 0;
          monthKey = ledgerData?.monthKey || '';
          yearKey = ledgerData?.yearKey || '';
        }
      }

      // Delete from Firestore
      await deleteDoc(doc(db, 'workoutLogs', setId));

      // Update local state
      allLogs = allLogs.filter(l => l.id !== setId);

      // Check if session is now empty (no sets remain across all exercises)
      if (sessionId) {
        const remainingSessionLogs = allLogs.filter(l => l.completedWorkoutId === sessionId);
        if (remainingSessionLogs.length === 0) {
          // Session is empty - delete it entirely (handles ledger + aggregates)
          await deleteSessionAndLedger(sessionId);
          closeExerciseHistory();
          // PRs now loaded from Firestore PR store (write-forward only)
          return; // Skip tonnage delta since session is deleted
        }
      }

      // Session still has sets - do tonnage delta update
      if (sessionId && hasLedger && monthKey && yearKey) {
        const newTonnage = computeSessionTonnageFromLogs(sessionId);
        try {
          await updateTonnageAfterSessionEdit(sessionId, oldTonnage, newTonnage, monthKey, yearKey);
        } catch (tonnageError) {
          console.error('Tonnage update failed:', tonnageError);
        }
      } else if (sessionId && !hasLedger) {
        console.warn('[AE] No tonnage ledger for session', sessionId, '- aggregates unchanged (legacy session)');
      }

      // Update exerciseSessionSets to reflect the deletion
      exerciseSessionSets = exerciseSessionSets.filter(s => s.id !== setId);

      // Recalculate PRs first
      // PRs now loaded from Firestore PR store (write-forward only)

      // Check if any logs remain for this exercise at all
      const remainingExerciseLogs = allLogs.filter(l => l.exerciseId === selectedExercise?.exerciseId);

      if (remainingExerciseLogs.length === 0) {
        // No logs remain for this exercise - close the modal
        closeExerciseHistory();
        return;
      }

      // If no sets remain in current session, find next available session
      if (exerciseSessionSets.length === 0) {
        // Rebuild exerciseSessions from remaining logs
        const sessionMap = {};
        remainingExerciseLogs.forEach(log => {
          if (log.completedWorkoutId && !sessionMap[log.completedWorkoutId]) {
            sessionMap[log.completedWorkoutId] = { id: log.completedWorkoutId, date: log.loggedAt, dayName: log.dayName };
          }
        });
        exerciseSessions = Object.values(sessionMap)
          .sort((a, b) => {
            const da = a.date?.toDate ? a.date.toDate() : new Date(a.date);
            const db = b.date?.toDate ? b.date.toDate() : new Date(b.date);
            return db - da;
          })
          .slice(0, 10);

        if (exerciseSessions.length > 0) {
          selectExerciseSession(exerciseSessions[0]);
        } else {
          selectedExerciseSession = null;
        }
      }

      // Recalculate selected exercise history
      if (selectedExercise) {
        recalculateSelectedExerciseHistory();
      }
    } catch (e) {
      console.error('Delete set failed:', e);
      alert('Failed to delete set');
    }
  }

  // Helper: Compute session tonnage from logs for a specific session
  function computeSessionTonnageFromLogs(sessionId) {
    const sessionLogs = allLogs.filter(l => l.completedWorkoutId === sessionId);
    let total = 0;
    for (const log of sessionLogs) {
      const weight = parseFloat(log.weight);
      const reps = parseFloat(log.reps);
      if (!isNaN(weight) && !isNaN(reps) && weight > 0 && reps > 0) {
        total += weight * reps;
      }
    }
    return total;
  }

  // Helper: Update tonnage ledger and aggregates after session edit
  async function updateTonnageAfterSessionEdit(sessionId, oldTonnage, newTonnage, monthKey, yearKey) {
    const delta = newTonnage - oldTonnage;
    if (delta === 0) return; // No change needed

    const targetUserId = getTargetUserId();
    const ledgerRef = doc(db, 'user', targetUserId, 'stats', `sessionTonnage_${sessionId}`);
    const monthRef = doc(db, 'user', targetUserId, 'stats', `tonnage_${monthKey}`);
    const yearRef = doc(db, 'user', targetUserId, 'stats', `tonnage_${yearKey}`);

    const batch = writeBatch(db);
    batch.update(ledgerRef, { tonnage: newTonnage, updatedAt: new Date() });
    batch.update(monthRef, { tonnage: increment(delta) });
    batch.update(yearRef, { tonnage: increment(delta) });
    await batch.commit();
  }

  // Helper: Recalculate e1rm and repRanges for selected exercise
  async function recalculateSelectedExerciseHistory() {
    if (!selectedExercise) return;

    const targetUserId = getTargetUserId();
    const exerciseLogs = allLogs.filter(l => l.exerciseId === selectedExercise.exerciseId && l.completedWorkoutId);

    // Load rep-band PRs from Firestore PR store
    let repRanges = { '1-5': null, '6-8': null, '9-12': null, '13+': null };
    try {
      repRanges = await loadExerciseRepBandPrs(targetUserId, selectedExercise.exerciseId);
    } catch (err) {
      console.error('Failed to load rep-band PRs:', err);
    }

    // Calculate e1rm from logs (still needed, not stored in PR store)
    let best1RM = null;
    exerciseLogs.forEach(log => {
      const weight = parseFloat(log.weight) || 0;
      const reps = parseInt(log.reps) || 0;
      if (weight <= 0 || reps <= 0) return;

      const e1rm = weight * (1 + reps / 30);
      if (!best1RM || e1rm > best1RM.e1rm) {
        best1RM = { e1rm: Math.round(e1rm), weight, reps, date: log.loggedAt, notes: log.notes };
      }
    });

    selectedExerciseHistory = { e1rm: best1RM, repRanges };
  }

  // Performance Analysis helpers
  function getLoggedExercises() {
    const exerciseMap = {};
    allLogs.forEach(log => {
      if (log.exerciseId && log.exerciseName && log.completedWorkoutId) {
        if (!exerciseMap[log.exerciseId]) {
          exerciseMap[log.exerciseId] = log.exerciseName;
        }
      }
    });
    return Object.entries(exerciseMap)
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function getCustomReqOptions() {
    if (!analysisExerciseId) return [];
    const exerciseLogs = allLogs.filter(l => l.exerciseId === analysisExerciseId && l.completedWorkoutId);
    const reqMap = {};
    exerciseLogs.forEach(log => {
      if (!log.customInputs) return;
      Object.entries(log.customInputs).forEach(([idx, val]) => {
        const numVal = parseFloat(val);
        if (!isNaN(numVal)) {
          // Try to get name from program cache
          const prog = programsCache[log.programId];
          const exTemplate = prog?.days?.flatMap(d => d.sections?.flatMap(s => s.exercises || []) || [])
            .find(e => e.workoutExerciseId === log.workoutExerciseId);
          const req = exTemplate?.customReqs?.filter(r => r.clientInput)?.[parseInt(idx)];
          const name = req?.name || `Custom ${parseInt(idx) + 1}`;
          if (!reqMap[idx]) reqMap[idx] = { idx, name, hasNumeric: true };
        }
      });
    });
    return Object.values(reqMap);
  }

  function getChartData() {
    if (!analysisExerciseId) return [];
    const exerciseLogs = allLogs.filter(l => l.exerciseId === analysisExerciseId && l.completedWorkoutId);

    // Group by session
    const sessionMap = {};
    exerciseLogs.forEach(log => {
      const sid = log.completedWorkoutId;
      if (!sessionMap[sid]) {
        sessionMap[sid] = { date: log.loggedAt, sets: [] };
      }
      sessionMap[sid].sets.push(log);
    });

    // Build sorted session list with precomputed sessionPeakE1RM for rolling calculations
    const sessions = Object.values(sessionMap).map(session => {
      // Compute sessionPeakE1RM for each session (needed for pct_e1rm rolling calculation)
      let sessionPeakE1RM = null;
      session.sets.forEach(s => {
        const w = parseFloat(s.weight) || 0;
        const r = parseInt(s.reps) || 0;
        if (w > 0 && r > 0) {
          const e = w * (1 + r / 30);
          if (sessionPeakE1RM === null || e > sessionPeakE1RM) sessionPeakE1RM = e;
        }
      });
      return { ...session, sessionPeakE1RM };
    });

    // Sort sessions chronologically
    sessions.sort((a, b) => {
      const da = a.date?.toDate ? a.date.toDate() : new Date(a.date);
      const db = b.date?.toDate ? b.date.toDate() : new Date(b.date);
      return da - db;
    });

    // Compute metric per session
    const points = [];
    sessions.forEach((session, idx) => {
      let value = null;
      if (analysisMetric === 'weight') {
        session.sets.forEach(s => {
          const w = parseFloat(s.weight) || 0;
          if (w > 0 && (value === null || w > value)) value = w;
        });
      } else if (analysisMetric === 'volume') {
        value = 0;
        session.sets.forEach(s => {
          const w = parseFloat(s.weight) || 0;
          const r = parseInt(s.reps) || 0;
          if (w > 0 && r > 0) value += w * r;
        });
        if (value === 0) value = null;
      } else if (analysisMetric === 'e1rm') {
        session.sets.forEach(s => {
          const w = parseFloat(s.weight) || 0;
          const r = parseInt(s.reps) || 0;
          if (w > 0 && r > 0) {
            const e = Math.round(w * (1 + r / 30));
            if (value === null || e > value) value = e;
          }
        });
      } else if (analysisMetric === 'pct_e1rm') {
        // Rolling peak: max sessionPeakE1RM from up to 10 previous sessions (excluding current)
        // Guardrail: require at least 2 prior valid e1RM sessions
        const allPrevSessions = sessions.slice(0, idx);
        const validPrevCount = allPrevSessions.filter(ps => ps.sessionPeakE1RM !== null && ps.sessionPeakE1RM > 0).length;
        if (validPrevCount >= 2) {
          const prevSessions = sessions.slice(Math.max(0, idx - 10), idx);
          let rollingPeakE1RM = null;
          prevSessions.forEach(ps => {
            if (ps.sessionPeakE1RM !== null && ps.sessionPeakE1RM > 0) {
              if (rollingPeakE1RM === null || ps.sessionPeakE1RM > rollingPeakE1RM) {
                rollingPeakE1RM = ps.sessionPeakE1RM;
              }
            }
          });
          // Current session's peak e1RM
          const currentPeakE1RM = session.sessionPeakE1RM;
          // Compute % only if both values exist
          if (currentPeakE1RM !== null && rollingPeakE1RM !== null) {
            value = Math.round(100 * currentPeakE1RM / rollingPeakE1RM * 10) / 10;
            // Store for tooltip
            session._pctSessionE1RM = Math.round(currentPeakE1RM);
            session._pctRollingE1RM = Math.round(rollingPeakE1RM);
          }
        }
      } else if (analysisMetric === 'custom' && analysisCustomReqIdx !== '') {
        session.sets.forEach(s => {
          if (s.customInputs && s.customInputs[analysisCustomReqIdx] !== undefined) {
            const v = parseFloat(s.customInputs[analysisCustomReqIdx]);
            if (!isNaN(v) && (value === null || v > value)) value = v;
          }
        });
      }

      // Compute dot label value (independent of main metric)
      let dotLabel = null;
      if (dotLabelMetric !== 'none') {
        if (dotLabelMetric === 'weight') {
          session.sets.forEach(s => {
            const w = parseFloat(s.weight) || 0;
            if (w > 0 && (dotLabel === null || w > dotLabel)) dotLabel = w;
          });
        } else if (dotLabelMetric === 'volume') {
          dotLabel = 0;
          session.sets.forEach(s => {
            const w = parseFloat(s.weight) || 0;
            const r = parseInt(s.reps) || 0;
            if (w > 0 && r > 0) dotLabel += w * r;
          });
          if (dotLabel === 0) dotLabel = null;
        } else if (dotLabelMetric === 'e1rm') {
          session.sets.forEach(s => {
            const w = parseFloat(s.weight) || 0;
            const r = parseInt(s.reps) || 0;
            if (w > 0 && r > 0) {
              const e = Math.round(w * (1 + r / 30));
              if (dotLabel === null || e > dotLabel) dotLabel = e;
            }
          });
        } else if (dotLabelMetric === 'pct_e1rm') {
          // For dot label, use same rolling peak calculation with 2-prior-sessions guardrail
          const allPrevSessions = sessions.slice(0, idx);
          const validPrevCount = allPrevSessions.filter(ps => ps.sessionPeakE1RM !== null && ps.sessionPeakE1RM > 0).length;
          if (validPrevCount >= 2) {
            const prevSessions = sessions.slice(Math.max(0, idx - 10), idx);
            let rollingPeakE1RM = null;
            prevSessions.forEach(ps => {
              if (ps.sessionPeakE1RM !== null && ps.sessionPeakE1RM > 0) {
                if (rollingPeakE1RM === null || ps.sessionPeakE1RM > rollingPeakE1RM) {
                  rollingPeakE1RM = ps.sessionPeakE1RM;
                }
              }
            });
            if (session.sessionPeakE1RM !== null && rollingPeakE1RM !== null) {
              dotLabel = Math.round(100 * session.sessionPeakE1RM / rollingPeakE1RM);
            }
          }
        }
      }

      if (value !== null) {
        const point = { date: session.date, value, dotLabel };
        // Include tooltip data for pct_e1rm metric
        if (analysisMetric === 'pct_e1rm' && session._pctSessionE1RM && session._pctRollingE1RM) {
          point.pctSessionE1RM = session._pctSessionE1RM;
          point.pctRollingE1RM = session._pctRollingE1RM;
        }
        points.push(point);
      }
    });

    return points;
  }

  function formatChartDate(d) {
    const date = d?.toDate ? d.toDate() : new Date(d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function applyWindow(points) {
    if (points.length === 0) return points;
    if (windowMode === 'time') {
      if (timeWindow === 'all') return points;
      const now = Date.now();
      const days = timeWindow === 'week' ? 7 : timeWindow === 'month' ? 30 : 365;
      const cutoff = now - days * 24 * 60 * 60 * 1000;
      return points.filter(p => {
        const d = p.date?.toDate ? p.date.toDate() : new Date(p.date);
        return d.getTime() >= cutoff;
      });
    } else {
      // By sessions: take last N
      return points.slice(-sessionsWindow);
    }
  }

  function applyAggregation(points) {
    if (aggregationMode === 'raw' || points.length === 0) return points;

    if (windowMode === 'time') {
      // Bucket by time period
      const buckets = {};
      points.forEach(p => {
        const d = p.date?.toDate ? p.date.toDate() : new Date(p.date);
        let key;
        if (avgByTime === 'week') {
          const year = d.getFullYear();
          const jan1 = new Date(year, 0, 1);
          const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
          key = `${year}-W${week}`;
        } else if (avgByTime === 'month') {
          key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        } else {
          key = `${d.getFullYear()}`;
        }
        if (!buckets[key]) buckets[key] = { values: [], dotLabels: [], firstDate: d };
        buckets[key].values.push(p.value);
        if (p.dotLabel !== null && p.dotLabel !== undefined) buckets[key].dotLabels.push(p.dotLabel);
        if (d < buckets[key].firstDate) buckets[key].firstDate = d;
      });
      return Object.values(buckets)
        .map(b => {
          const avgValue = Math.round(b.values.reduce((a, v) => a + v, 0) / b.values.length);
          const avgDotLabel = b.dotLabels.length > 0
            ? Math.round(b.dotLabels.reduce((a, v) => a + v, 0) / b.dotLabels.length)
            : null;
          return { date: b.firstDate, value: avgValue, dotLabel: avgDotLabel };
        })
        .sort((a, b) => a.date - b.date);
    } else {
      // Bucket by consecutive blocks of N sessions
      const result = [];
      for (let i = 0; i < points.length; i += avgBySessions) {
        const block = points.slice(i, i + avgBySessions);
        if (block.length === 0) continue;
        const avg = Math.round(block.reduce((a, p) => a + p.value, 0) / block.length);
        const dotLabels = block.filter(p => p.dotLabel !== null && p.dotLabel !== undefined).map(p => p.dotLabel);
        const avgDotLabel = dotLabels.length > 0
          ? Math.round(dotLabels.reduce((a, v) => a + v, 0) / dotLabels.length)
          : null;
        result.push({ date: block[block.length - 1].date, value: avg, dotLabel: avgDotLabel });
      }
      return result;
    }
  }
</script>

<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 10px;">
  <h1 style="margin: 0;">Workout History</h1>
  {#if userRole === 'admin'}
    <select
      value={selectedUserId}
      onchange={(e) => selectedUserId = e.target.value}
      style="padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.95em; min-width: 180px;"
    >
      {#if allUsers.length === 0}
        <option disabled>Loading users…</option>
      {:else}
        {#each getSortedUsers() as user}
          <option value={user.id}>{user.displayName || user.email}</option>
        {/each}
      {/if}
    </select>
  {/if}
</div>

{#if loading}
  <p>Loading your history...</p>
{:else if !currentUserId}
  <p>Please <a href="/login">log in</a> to see your workout history.</p>
{:else}
  <!-- Tabs -->
  <div style="display: flex; gap: 0; margin-bottom: 20px; border-bottom: 2px solid #eee;">
    <button
      onclick={() => { activeTab = 'workouts'; selectedSession = null; }}
      style="flex: 1; padding: 12px; border: none; background: {activeTab === 'workouts' ? 'white' : '#f5f5f5'}; cursor: pointer; font-weight: {activeTab === 'workouts' ? 'bold' : 'normal'}; border-bottom: {activeTab === 'workouts' ? '3px solid #667eea' : 'none'}; margin-bottom: -2px;"
    >
      Past Workouts
    </button>
    <button
      onclick={() => { activeTab = 'prs'; selectedSession = null; }}
      style="flex: 1; padding: 12px; border: none; background: {activeTab === 'prs' ? 'white' : '#f5f5f5'}; cursor: pointer; font-weight: {activeTab === 'prs' ? 'bold' : 'normal'}; border-bottom: {activeTab === 'prs' ? '3px solid #ff9800' : 'none'}; margin-bottom: -2px;"
    >
      Personal Records
    </button>
    <button
      onclick={() => { activeTab = 'analysis'; selectedSession = null; }}
      style="flex: 1; padding: 12px; border: none; background: {activeTab === 'analysis' ? 'white' : '#f5f5f5'}; cursor: pointer; font-weight: {activeTab === 'analysis' ? 'bold' : 'normal'}; border-bottom: {activeTab === 'analysis' ? '3px solid #9c27b0' : 'none'}; margin-bottom: -2px;"
    >
      Performance Analysis <span style="font-size: 1.1em; color: #d32f2f; font-weight: 600;">(Beta)</span>
    </button>
  </div>

  {#if activeTab === 'workouts'}
    {#if selectedSession}
      <SessionDetailModal
        session={selectedSession}
        groupedLogs={getSessionLogs(selectedSession)}
        onClose={() => selectedSession = null}
        onDeleteSession={() => deleteSession(selectedSession)}
        onDeleteExercise={deleteExerciseLogs}
        {getCustomReqs}
        missingSets={getMissingSets(selectedSession)}
        missingPlacement="bottom"
      />
    {:else}
      <!-- Sessions List -->
      {#if workoutSessions.length === 0}
        <p style="color: #888; text-align: center; padding: 40px 0;">No workouts completed yet. Start your first workout!</p>
      {:else}
        <p style="color: #888; margin-bottom: 15px;">{workoutSessions.length} workout{workoutSessions.length !== 1 ? 's' : ''} completed</p>

        {#each workoutSessions as session}
          <div
            onclick={() => { selectedSession = session; loadProgram(session.programId); }}
            style="background: white; border: 1px solid #ddd; border-radius: 10px; padding: 15px; margin-bottom: 12px; cursor: pointer; transition: all 0.2s;"
            onmouseenter={(e) => e.currentTarget.style.borderColor = '#667eea'}
            onmouseleave={(e) => e.currentTarget.style.borderColor = '#ddd'}
          >
            <div style="display: flex; justify-content: space-between; align-items: start;">
              <div>
                <strong style="font-size: 1.1em;">{session.dayName}</strong>
                <p style="margin: 3px 0 0 0; color: #666; font-size: 0.9em;">{session.programName}</p>
              </div>
              <div style="text-align: right;">
                <div style="color: #888; font-size: 0.85em;">{formatDate(session.finishedAt)}</div>
                {#if session.durationMinutes}
                  <div style="color: #667eea; font-size: 0.85em; margin-top: 2px;">{session.durationMinutes} min</div>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      {/if}
    {/if}

  {:else if activeTab === 'prs'}
    <!-- PRs Tab -->
    {#if getPRsList().length === 0}
      <p style="color: #888; text-align: center; padding: 40px 0;">No personal records yet. Complete some workouts to set your first PRs!</p>
    {:else}
      <!-- Explainer text -->
      <p class="pr-explainer">Highest weight achieved within each rep range.</p>

      <!-- Legend row -->
      <div class="pr-legend">
        <div class="pr-legend-item">
          <span class="pr-legend-dot" style="background: #1565c0;"></span>
          <span>Strength (1–5)</span>
        </div>
        <div class="pr-legend-item">
          <span class="pr-legend-dot" style="background: #7b1fa2;"></span>
          <span>Power (6–8)</span>
        </div>
        <div class="pr-legend-item">
          <span class="pr-legend-dot" style="background: #2e7d32;"></span>
          <span>Hypertrophy (9–12)</span>
        </div>
        <div class="pr-legend-item">
          <span class="pr-legend-dot" style="background: #b8860b;"></span>
          <span>Endurance (13+)</span>
        </div>
      </div>

      {@const groupedPRs = getGroupedPRs()}
      <p style="color: #888; margin-bottom: 15px;">{groupedPRs.length} exercise{groupedPRs.length !== 1 ? 's' : ''} with PRs</p>

      {#each groupedPRs as group}
        {@const heroColor = getRepBandColor(group.hero.repBand)}
        <div
          onclick={() => openExerciseHistory(group.exerciseId, group.exerciseName)}
          class="pr-card-consolidated"
        >
          <div class="pr-card-main">
            <!-- Left: Hero -->
            <div class="pr-card-hero">
              <div class="pr-card-name">{group.exerciseName}</div>
              <div class="pr-card-hero-stats">
                <div class="pr-card-weight">{group.hero.weight} <span class="pr-card-unit">lbs</span></div>
                <div class="pr-card-reps">{group.hero.reps} reps</div>
              </div>
              <div class="pr-card-session">
                {formatDate(group.hero.date)}{#if group.hero.dayName} • {group.hero.dayName}{/if}
              </div>
            </div>

            <!-- Right: Band Rail -->
            <div class="pr-band-rail">
              {#each group.bands as band}
                {@const bandColor = getRepBandColor(band.repBand)}
                <div class="pr-band-rail-item" style="border-left-color: {bandColor};">
                  <span class="pr-band-rail-label" style="color: {bandColor};">{band.repBand}</span>
                  <span class="pr-band-rail-value">{band.reps} × {band.weight} lbs</span>
                </div>
              {/each}
            </div>
          </div>

          <!-- Mobile: Band chips (shown at narrow widths) -->
          <div class="pr-band-chips-mobile">
            {#each group.bands as band}
              {@const bandColor = getRepBandColor(band.repBand)}
              {@const bandBg = getRepBandBg(band.repBand)}
              <div class="pr-band-chip-mobile" style="background: {bandBg}; color: {bandColor};">
                <span class="pr-band-chip-label">{band.repBand}</span>
                <span class="pr-band-chip-value">{band.reps}×{band.weight}</span>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {/if}

  {:else if activeTab === 'analysis'}
    <!-- Performance Analysis Tab -->
    <div style="margin-bottom: 15px;">
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px;">
        <div>
          <label style="font-size: 0.85em; color: #666; display: block; margin-bottom: 4px;">Exercise</label>
          <select bind:value={analysisExerciseId} style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px;">
            <option value="">Select exercise...</option>
            {#each getLoggedExercises() as ex}
              <option value={ex.id}>{ex.name}</option>
            {/each}
          </select>
        </div>
        <div>
          <label style="font-size: 0.85em; color: #666; display: block; margin-bottom: 4px;">Metric</label>
          <select bind:value={analysisMetric} style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px;">
            <option value="weight">Weight (max)</option>
            <option value="volume">Volume (total)</option>
            <option value="e1rm">Estimated 1RM</option>
            <option value="pct_e1rm">% of e1RM</option>
            <option value="custom">Custom Requirement</option>
          </select>
        </div>
      </div>

      {#if analysisMetric === 'custom'}
        <div style="margin-bottom: 15px;">
          <label style="font-size: 0.85em; color: #666; display: block; margin-bottom: 4px;">Requirement</label>
          <select bind:value={analysisCustomReqIdx} style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px;">
            <option value="">Select requirement...</option>
            {#each getCustomReqOptions() as req}
              <option value={req.idx}>{req.name}</option>
            {/each}
          </select>
        </div>
      {/if}

      <!-- Window controls -->
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px; flex-wrap: wrap;">
        <div style="display: flex; border: 1px solid #ddd; border-radius: 6px; overflow: hidden;">
          <button onclick={() => windowMode = 'time'} style="padding: 6px 12px; border: none; background: {windowMode === 'time' ? '#9c27b0' : '#f5f5f5'}; color: {windowMode === 'time' ? 'white' : '#333'}; cursor: pointer; font-size: 0.85em;">By Time</button>
          <button onclick={() => windowMode = 'sessions'} style="padding: 6px 12px; border: none; background: {windowMode === 'sessions' ? '#9c27b0' : '#f5f5f5'}; color: {windowMode === 'sessions' ? 'white' : '#333'}; cursor: pointer; font-size: 0.85em;">By Sessions</button>
        </div>
        {#if windowMode === 'time'}
          <select bind:value={timeWindow} style="padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.85em;">
            <option value="week">Last Week</option>
            <option value="month">Last Month</option>
            <option value="year">Last Year</option>
            <option value="all">All Time</option>
          </select>
        {:else}
          <select bind:value={sessionsWindow} style="padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.85em;">
            <option value={5}>Last 5 Sessions</option>
            <option value={10}>Last 10 Sessions</option>
            <option value={20}>Last 20 Sessions</option>
            <option value={50}>Last 50 Sessions</option>
          </select>
        {/if}
      </div>

      <!-- Aggregation controls -->
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px; flex-wrap: wrap;">
        <div style="display: flex; border: 1px solid #ddd; border-radius: 6px; overflow: hidden;">
          <button onclick={() => aggregationMode = 'raw'} style="padding: 6px 12px; border: none; background: {aggregationMode === 'raw' ? '#9c27b0' : '#f5f5f5'}; color: {aggregationMode === 'raw' ? 'white' : '#333'}; cursor: pointer; font-size: 0.85em;">Raw</button>
          <button onclick={() => aggregationMode = 'average'} style="padding: 6px 12px; border: none; background: {aggregationMode === 'average' ? '#9c27b0' : '#f5f5f5'}; color: {aggregationMode === 'average' ? 'white' : '#333'}; cursor: pointer; font-size: 0.85em;">Average</button>
        </div>
        {#if aggregationMode === 'average'}
          {#if windowMode === 'time'}
            <select bind:value={avgByTime} style="padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.85em;">
              <option value="week">Average by Week</option>
              <option value="month">Average by Month</option>
              <option value="year">Average by Year</option>
            </select>
          {:else}
            <select bind:value={avgBySessions} style="padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.85em;">
              <option value={5}>Average every 5</option>
              <option value={10}>Average every 10</option>
              <option value={20}>Average every 20</option>
              <option value={50}>Average every 50</option>
            </select>
          {/if}
        {/if}
      </div>

      <!-- Dot Label control -->
      <div style="margin-bottom: 15px;">
        <label style="font-size: 0.85em; color: #666; display: block; margin-bottom: 4px;">Dot Label</label>
        <select bind:value={dotLabelMetric} style="padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.85em;">
          <option value="none">None</option>
          <option value="weight">Weight</option>
          <option value="volume">Volume</option>
          <option value="e1rm">e1RM</option>
          <option value="pct_e1rm">% of e1RM</option>
        </select>
      </div>

      {#if !analysisExerciseId}
        <div style="text-align: center; padding: 40px 20px; color: #888;">
          <p>Select an exercise to view performance trends</p>
        </div>
      {:else if analysisMetric === 'custom' && analysisCustomReqIdx === ''}
        <div style="text-align: center; padding: 40px 20px; color: #888;">
          <p>Select a requirement to view trends</p>
        </div>
      {:else}
        {@const rawData = getChartData()}
        {@const windowedData = applyWindow(rawData)}
        {@const chartData = applyAggregation(windowedData)}
        {#if rawData.length === 0}
          <div style="text-align: center; padding: 40px 20px; color: #888;">
            <p>No data for this metric</p>
          </div>
        {:else if chartData.length === 0}
          <div style="text-align: center; padding: 40px 20px; color: #888;">
            <p>No data in this window</p>
          </div>
        {:else}
          {@const values = chartData.map(d => d.value)}
          {@const minVal = Math.min(...values)}
          {@const maxVal = Math.max(...values)}
          {@const range = maxVal - minVal || 1}
          {@const padding = range * 0.1}
          {@const yMin = Math.max(0, minVal - padding)}
          {@const yMax = maxVal + padding}
          {@const yRange = yMax - yMin}
          <div style="background: white; border: 1px solid #ddd; border-radius: 8px; padding: 15px;">
            <div style="font-weight: 600; margin-bottom: 10px; color: #333; display: flex; align-items: center; gap: 6px;">
              {#if analysisMetric === 'e1rm'}
                <span>Session Peak Estimated 1RM Over Time</span>
                <span class="tooltip-trigger" tabindex="0" style="cursor: help; color: #888; font-size: 0.85em;">
                  ⓘ
                  <span class="tooltip-text">Each point reflects the highest estimated 1-rep max achieved during that workout.</span>
                </span>
              {:else if analysisMetric === 'pct_e1rm'}
                <span>Intensity vs Rolling Peak (%) Over Time</span>
                <span class="tooltip-trigger" tabindex="0" style="cursor: help; color: #888; font-size: 0.85em;">
                  ⓘ
                  <span class="tooltip-text">Each session's peak compared to your best estimated lift from the previous 10 sessions at that time. Past values do not change when new records are set.</span>
                </span>
              {:else}
                <span>{analysisMetric === 'weight' ? 'Max Weight' : analysisMetric === 'volume' ? 'Total Volume' : (getCustomReqOptions().find(r => r.idx === analysisCustomReqIdx)?.name || 'Custom Requirement')} Over Time</span>
              {/if}
            </div>
            <svg viewBox="0 0 400 200" style="width: 100%; height: auto;">
              <!-- Y-axis label -->
              <text x="12" y="100" font-size="9" fill="#888" text-anchor="middle" transform="rotate(-90, 12, 100)">{yAxisLabel}</text>
              <!-- Grid lines -->
              {#each [0, 0.25, 0.5, 0.75, 1] as t}
                <line x1="40" y1={180 - t * 160} x2="390" y2={180 - t * 160} stroke="#eee" stroke-width="1"/>
                <text x="35" y={184 - t * 160} font-size="10" fill="#888" text-anchor="end">{Math.round(yMin + t * yRange)}</text>
              {/each}
              <!-- Line -->
              {#if chartData.length > 1}
                <polyline
                  fill="none"
                  stroke="#9c27b0"
                  stroke-width="2"
                  points={chartData.map((d, i) => {
                    const x = 40 + (i / (chartData.length - 1)) * 350;
                    const y = 180 - ((d.value - yMin) / yRange) * 160;
                    return `${x},${y}`;
                  }).join(' ')}
                />
              {/if}
              <!-- Points -->
              {#each chartData as d, i}
                {@const x = chartData.length === 1 ? 215 : 40 + (i / (chartData.length - 1)) * 350}
                {@const y = 180 - ((d.value - yMin) / yRange) * 160}
                <circle cx={x} cy={y} r="5" fill="#9c27b0" style="cursor: pointer;">
                  {#if analysisMetric === 'pct_e1rm' && d.pctSessionE1RM && d.pctRollingE1RM}
                    <title>Intensity: {d.value}%&#10;Session Peak e1RM: {d.pctSessionE1RM}&#10;Rolling Peak (prev 10): {d.pctRollingE1RM}</title>
                  {:else if analysisMetric === 'pct_e1rm'}
                    <title>Intensity: {d.value}% (averaged)</title>
                  {:else}
                    <title>{formatChartDate(d.date)}: {d.value}</title>
                  {/if}
                </circle>
                {#if dotLabelMetric !== 'none' && d.dotLabel !== null && d.dotLabel !== undefined}
                  <text x={x} y={y - 10} font-size="8" fill="#666" text-anchor="middle">{dotLabelMetric === 'pct_e1rm' ? `${d.dotLabel}%` : dotLabelMetric === 'volume' ? Math.round(d.dotLabel) : d.dotLabel}</text>
                {/if}
                {#if chartData.length <= 10}
                  <text x={x} y="195" font-size="8" fill="#888" text-anchor="middle">{formatChartDate(d.date)}</text>
                {/if}
              {/each}
              {#if chartData.length > 10}
                <text x="40" y="195" font-size="8" fill="#888" text-anchor="start">{formatChartDate(chartData[0].date)}</text>
                <text x="390" y="195" font-size="8" fill="#888" text-anchor="end">{formatChartDate(chartData[chartData.length - 1].date)}</text>
              {/if}
            </svg>
            <div style="text-align: center; color: #888; font-size: 0.75em; margin-top: 2px;">
              {xAxisLabel}
            </div>
            <div style="text-align: center; color: #888; font-size: 0.85em; margin-top: 3px;">
              {chartData.length} session{chartData.length !== 1 ? 's' : ''}
            </div>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
{/if}

{#if selectedExercise}
<div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px;" onclick={closeExerciseHistory}>
  <div style="background: white; border-radius: 12px; width: 100%; max-width: 500px; max-height: 80vh; overflow-y: auto;" onclick={(e) => e.stopPropagation()}>
    <div style="padding: 15px 20px; border-bottom: 1px solid #eee; position: sticky; top: 0; background: white;">
      <h3 style="margin: 0;">{selectedExercise.exerciseName}</h3>
    </div>
    <div style="padding: 15px 20px;">
      <!-- Estimated 1RM -->
      {#if selectedExerciseHistory?.e1rm}
        <div style="background: linear-gradient(135deg, #ff9800 0%, #f57c00 100%); color: white; padding: 15px; border-radius: 10px; margin-bottom: 15px; text-align: center;">
          <div style="font-size: 0.8em; opacity: 0.9; text-transform: uppercase; letter-spacing: 1px;">Estimated 1RM</div>
          <div style="font-size: 2em; font-weight: bold; margin: 5px 0;">{selectedExerciseHistory.e1rm.e1rm} lbs</div>
          <div style="font-size: 0.8em; opacity: 0.85;">Based on {selectedExerciseHistory.e1rm.reps} × {selectedExerciseHistory.e1rm.weight} lbs ({formatDate(selectedExerciseHistory.e1rm.date)})</div>
        </div>
      {/if}

      <!-- Rep Range PRs -->
      {#if selectedExerciseHistory?.repRanges && (selectedExerciseHistory.repRanges['1-5'] || selectedExerciseHistory.repRanges['6-8'] || selectedExerciseHistory.repRanges['9-12'] || selectedExerciseHistory.repRanges['13+'])}
        <div style="margin-bottom: 15px;">
          <div style="font-weight: 600; color: #333; margin-bottom: 10px; font-size: 0.9em;">Rep Range PRs</div>
          <div style="display: grid; gap: 8px;">
            {#if selectedExerciseHistory.repRanges['1-5']}
              <div style="background: #e3f2fd; padding: 10px 12px; border-radius: 8px; border-left: 4px solid #1565c0;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-weight: 600; color: #1565c0;">1-5 Reps (Strength)</span>
                  <span style="font-weight: bold; color: #333;">{selectedExerciseHistory.repRanges['1-5'].reps} × {selectedExerciseHistory.repRanges['1-5'].weight} lbs</span>
                </div>
                <div style="font-size: 0.8em; color: #666; margin-top: 4px;">{formatDate(selectedExerciseHistory.repRanges['1-5'].date)}</div>
                {#if selectedExerciseHistory.repRanges['1-5'].notes}
                  <div style="font-size: 0.8em; color: #888; font-style: italic; margin-top: 4px;">"{selectedExerciseHistory.repRanges['1-5'].notes}"</div>
                {/if}
              </div>
            {/if}
            {#if selectedExerciseHistory.repRanges['6-8']}
              <div style="background: #f3e5f5; padding: 10px 12px; border-radius: 8px; border-left: 4px solid #7b1fa2;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-weight: 600; color: #7b1fa2;">6-8 Reps (Power)</span>
                  <span style="font-weight: bold; color: #333;">{selectedExerciseHistory.repRanges['6-8'].reps} × {selectedExerciseHistory.repRanges['6-8'].weight} lbs</span>
                </div>
                <div style="font-size: 0.8em; color: #666; margin-top: 4px;">{formatDate(selectedExerciseHistory.repRanges['6-8'].date)}</div>
                {#if selectedExerciseHistory.repRanges['6-8'].notes}
                  <div style="font-size: 0.8em; color: #888; font-style: italic; margin-top: 4px;">"{selectedExerciseHistory.repRanges['6-8'].notes}"</div>
                {/if}
              </div>
            {/if}
            {#if selectedExerciseHistory.repRanges['9-12']}
              <div style="background: #e8f5e9; padding: 10px 12px; border-radius: 8px; border-left: 4px solid #2e7d32;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-weight: 600; color: #2e7d32;">9-12 Reps (Hypertrophy)</span>
                  <span style="font-weight: bold; color: #333;">{selectedExerciseHistory.repRanges['9-12'].reps} × {selectedExerciseHistory.repRanges['9-12'].weight} lbs</span>
                </div>
                <div style="font-size: 0.8em; color: #666; margin-top: 4px;">{formatDate(selectedExerciseHistory.repRanges['9-12'].date)}</div>
                {#if selectedExerciseHistory.repRanges['9-12'].notes}
                  <div style="font-size: 0.8em; color: #888; font-style: italic; margin-top: 4px;">"{selectedExerciseHistory.repRanges['9-12'].notes}"</div>
                {/if}
              </div>
            {/if}
            {#if selectedExerciseHistory.repRanges['13+']}
              <div style="background: #fef3c7; padding: 10px 12px; border-radius: 8px; border-left: 4px solid #b8860b;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-weight: 600; color: #b8860b;">13+ Reps (Endurance)</span>
                  <span style="font-weight: bold; color: #333;">{selectedExerciseHistory.repRanges['13+'].reps} × {selectedExerciseHistory.repRanges['13+'].weight} lbs</span>
                </div>
                <div style="font-size: 0.8em; color: #666; margin-top: 4px;">{formatDate(selectedExerciseHistory.repRanges['13+'].date)}</div>
                {#if selectedExerciseHistory.repRanges['13+'].notes}
                  <div style="font-size: 0.8em; color: #888; font-style: italic; margin-top: 4px;">"{selectedExerciseHistory.repRanges['13+'].notes}"</div>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      {#if exerciseSessions.length > 1}
      <div style="margin-bottom: 15px;">
        <label style="font-size: 0.85em; color: #666;">Select Session:</label>
        <select onchange={(e) => selectExerciseSession(exerciseSessions[e.target.selectedIndex])} style="width: 100%; padding: 8px; margin-top: 5px; border: 1px solid #ddd; border-radius: 6px;">
          {#each exerciseSessions as session, i}
            <option selected={session.id === selectedExerciseSession?.id}>{formatDate(session.date)} - {session.dayName}</option>
          {/each}
        </select>
      </div>
      {/if}
      {#if exerciseSessionSets.length > 0}
      <div style="font-weight: 600; margin-bottom: 10px; font-size: 0.9em;">Session Sets</div>
      {#each exerciseSessionSets as set}
        <div style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; margin-bottom: 6px; background: #f8f9fa; border-radius: 6px;">
          <span style="font-weight: bold; color: #667eea; min-width: 45px;">Set {set.setNumber || 1}</span>
          <span style="flex: 1;">{set.reps || '-'} × {set.weight || '-'} lbs</span>
          {#if set.rir}<span style="color: #888;">(RIR: {set.rir})</span>{/if}
          <button
            onclick={(e) => { e.stopPropagation(); deleteSetLog(set.id); }}
            style="background: none; border: none; color: #999; cursor: pointer; font-size: 1.1em; padding: 4px 8px; line-height: 1; margin-left: auto;"
            title="Delete this set"
          >×</button>
        </div>
        {#if set.customInputs}{#each Object.entries(set.customInputs) as [idx, val]}{#if val}{@const reqs = getCustomReqs(set.programId, set.workoutExerciseId)}{@const req = reqs?.[parseInt(idx)]}<div style="color: #9c27b0; font-size: 0.85em; margin: 0 0 4px 57px;">{req?.name || `Custom ${parseInt(idx)+1}`}: {val}{#if req?.value}&nbsp;(Target: {req.value}){/if}</div>{/if}{/each}{/if}
        {#if set.notes}<div style="color: #888; font-style: italic; font-size: 0.85em; margin: 0 0 8px 57px;">"{set.notes}"</div>{/if}
      {/each}
      {:else}
      <p style="color: #888;">No sets recorded.</p>
      {/if}
    </div>
    <div style="padding: 12px 20px; border-top: 1px solid #eee;">
      <button onclick={closeExerciseHistory} style="width: 100%; padding: 10px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer;">Close</button>
    </div>
  </div>
</div>
{/if}

<style>
  .tooltip-trigger {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .tooltip-trigger .tooltip-text {
    visibility: hidden;
    opacity: 0;
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: 6px;
    background: #333;
    color: white;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 0.75em;
    font-weight: 400;
    white-space: normal;
    width: 220px;
    text-align: center;
    z-index: 100;
    line-height: 1.4;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    transition: opacity 0.15s ease-in-out, visibility 0.15s ease-in-out;
  }

  .tooltip-trigger:hover .tooltip-text,
  .tooltip-trigger:focus .tooltip-text {
    visibility: visible;
    opacity: 1;
  }

  .tooltip-trigger:focus {
    outline: none;
  }

  /* PR Page Styles */
  .pr-explainer {
    color: #666;
    font-size: 0.9em;
    margin: 0 0 12px 0;
  }

  .pr-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 20px;
    margin-bottom: 20px;
    padding: 10px 0;
    border-bottom: 1px solid #eee;
  }

  .pr-legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8em;
    color: #555;
  }

  .pr-legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* Consolidated PR Card */
  .pr-card-consolidated {
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 12px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .pr-card-consolidated:hover {
    border-color: #ccc;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  }

  .pr-card-main {
    display: flex;
    gap: 16px;
  }

  .pr-card-hero {
    flex: 1;
    min-width: 0;
  }

  .pr-card-name {
    font-weight: 600;
    font-size: 1.05em;
    color: #333;
    margin-bottom: 8px;
  }

  .pr-card-hero-stats {
    margin-bottom: 6px;
  }

  .pr-card-weight {
    font-size: 1.8em;
    font-weight: 700;
    color: #1a1a1a;
    line-height: 1.1;
  }

  .pr-card-unit {
    font-size: 0.5em;
    font-weight: 500;
    color: #666;
  }

  .pr-card-reps {
    font-size: 0.95em;
    color: #555;
    margin-top: 2px;
  }

  .pr-card-session {
    font-size: 0.8em;
    color: #888;
  }

  /* Band Rail (right side) */
  .pr-band-rail {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-left: 12px;
    border-left: 1px solid #eee;
    min-width: 130px;
  }

  .pr-band-rail-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-left: 8px;
    border-left: 3px solid;
    font-size: 0.85em;
  }

  .pr-band-rail-label {
    font-weight: 600;
    min-width: 36px;
  }

  .pr-band-rail-value {
    color: #555;
    white-space: nowrap;
  }

  /* Mobile Band Chips (hidden by default, shown at narrow widths) */
  .pr-band-chips-mobile {
    display: none;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #eee;
  }

  .pr-band-chip-mobile {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 16px;
    font-size: 0.75em;
    font-weight: 500;
  }

  .pr-band-chip-label {
    font-weight: 600;
  }

  .pr-band-chip-value {
    opacity: 0.85;
  }

  /* Mobile: collapse rail to chips */
  @media (max-width: 480px) {
    .pr-card-main {
      flex-direction: column;
    }

    .pr-band-rail {
      display: none;
    }

    .pr-band-chips-mobile {
      display: flex;
    }
  }
</style>
