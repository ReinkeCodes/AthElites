<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, query, where, getDocs, orderBy, doc, getDoc, deleteDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import SessionDetailModal from '$lib/components/SessionDetailModal.svelte';

  let currentUserId = $state(null);
  let userRole = $state(null);
  let allUsers = $state([]);
  let selectedUserId = $state(null);
  let workoutSessions = $state([]);
  let exercisePRs = $state({});
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

        await Promise.all([loadWorkoutSessions(), loadAllLogs()]);
      }
      loading = false;
    });
  });

  // Reload data when admin changes selected user
  $effect(() => {
    if (userRole === 'admin' && selectedUserId && !loading) {
      loadWorkoutSessions();
      loadAllLogs();
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

      // Calculate PRs per exercise
      const prs = {};
      allLogs.forEach(log => {
        const weight = parseFloat(log.weight) || 0;
        const exerciseId = log.exerciseId;
        const exerciseName = log.exerciseName;

        if (!prs[exerciseId] || weight > prs[exerciseId].weight) {
          prs[exerciseId] = {
            exerciseName,
            weight,
            reps: log.reps,
            sets: log.sets,
            date: log.loggedAt,
            programName: log.programName,
            dayName: log.dayName
          };
        }
      });
      exercisePRs = prs;
    } catch (e) {
      console.log('Could not load logs:', e);
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
    return Object.entries(exercisePRs)
      .map(([id, pr]) => ({ exerciseId: id, ...pr }))
      .sort((a, b) => a.exerciseName.localeCompare(b.exerciseName));
  }

  function openExerciseHistory(exerciseId, exerciseName) {
    selectedExercise = { exerciseId, exerciseName };

    // Clear stale data immediately to prevent orphan PR display
    selectedExerciseHistory = { e1rm: null, repRanges: { '1-5': null, '6-8': null, '9-12': null } };
    exerciseSessions = [];
    selectedExerciseSession = null;
    exerciseSessionSets = [];

    // Get unique sessions for this exercise (last 10)
    const exerciseLogs = allLogs.filter(l => l.exerciseId === exerciseId && l.completedWorkoutId);

    // If no logs exist, ensure clean state (no orphan PRs)
    if (exerciseLogs.length === 0) {
      selectedExerciseHistory = { e1rm: null, repRanges: { '1-5': null, '6-8': null, '9-12': null } };
      return;
    }

    const sessionMap = {};
    const programIds = new Set();

    // Calculate e1rm and rep range PRs (same logic as workout page)
    let best1RM = null;
    const repRanges = {
      '1-5': null,
      '6-8': null,
      '9-12': null
    };

    exerciseLogs.forEach(log => {
      if (log.programId) programIds.add(log.programId);
      if (!sessionMap[log.completedWorkoutId]) {
        sessionMap[log.completedWorkoutId] = { id: log.completedWorkoutId, date: log.loggedAt, dayName: log.dayName };
      }

      // Calculate PRs
      const weight = parseFloat(log.weight) || 0;
      const reps = parseInt(log.reps) || 0;
      if (weight <= 0 || reps <= 0) return;

      // Calculate estimated 1RM using Epley formula: weight × (1 + reps/30)
      const e1rm = weight * (1 + reps / 30);
      if (!best1RM || e1rm > best1RM.e1rm) {
        best1RM = { e1rm: Math.round(e1rm), weight, reps, date: log.loggedAt, notes: log.notes };
      }

      // Categorize by rep range
      let range = null;
      if (reps >= 1 && reps <= 5) range = '1-5';
      else if (reps >= 6 && reps <= 8) range = '6-8';
      else if (reps >= 9 && reps <= 12) range = '9-12';

      if (range) {
        if (!repRanges[range] || weight > repRanges[range].weight) {
          repRanges[range] = { weight, reps, date: log.loggedAt, notes: log.notes };
        }
      }
    });

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

  async function deleteSession(session) {
    if (!confirm(`Delete "${session.dayName}" workout from ${formatDate(session.finishedAt)}? This cannot be undone.`)) return;
    const targetUserId = getTargetUserId();
    try {
      // Delete all logs for this session from Firestore
      const logsQuery = query(collection(db, 'workoutLogs'), where('userId', '==', targetUserId), where('completedWorkoutId', '==', session.id));
      const logsSnap = await getDocs(logsQuery);

      // Collect IDs of logs being deleted (more reliable than filtering by completedWorkoutId)
      const deletedLogIds = new Set(logsSnap.docs.map(d => d.id));

      await Promise.all(logsSnap.docs.map(d => deleteDoc(d.ref)));
      // Delete the session
      await deleteDoc(doc(db, 'workoutSessions', session.id));

      // Refresh UI - filter by actual deleted log IDs for reliability
      workoutSessions = workoutSessions.filter(s => s.id !== session.id);
      allLogs = allLogs.filter(l => !deletedLogIds.has(l.id));
      selectedSession = null;

      // Recalculate PRs from remaining logs (matches loadAllLogs logic exactly)
      // If no logs remain for an exercise, it won't be in prs and will disappear from PR tab
      const prs = {};
      allLogs.forEach(log => {
        const weight = parseFloat(log.weight) || 0;
        const exerciseId = log.exerciseId;
        const exerciseName = log.exerciseName;

        if (!prs[exerciseId] || weight > prs[exerciseId].weight) {
          prs[exerciseId] = {
            exerciseName,
            weight,
            reps: log.reps,
            sets: log.sets,
            date: log.loggedAt,
            programName: log.programName,
            dayName: log.dayName
          };
        }
      });
      exercisePRs = prs;
    } catch (e) { console.error('Delete failed:', e); alert('Failed to delete session'); }
  }

  // TASK 1: Delete all logs for a specific exercise within a session
  async function deleteExerciseLogs(sessionId, exercise) {
    const exerciseKey = exercise.workoutExerciseId || exercise.exerciseId;
    if (!confirm(`Delete all logged sets for "${exercise.exerciseName}"? This cannot be undone.`)) return;

    try {
      // Find all log IDs for this exercise in this session
      const logIds = exercise.sets.map(s => s.id).filter(Boolean);

      // Delete from Firestore
      await Promise.all(logIds.map(id => deleteDoc(doc(db, 'workoutLogs', id))));

      // Update local state
      allLogs = allLogs.filter(l => !logIds.includes(l.id));

      // Recalculate PRs
      recalculatePRs();
    } catch (e) {
      console.error('Delete exercise logs failed:', e);
      alert('Failed to delete exercise logs');
    }
  }

  // TASK 2: Delete a single set log from PR modal
  async function deleteSetLog(setId) {
    if (!confirm('Delete this set? This cannot be undone.')) return;

    try {
      // Delete from Firestore
      await deleteDoc(doc(db, 'workoutLogs', setId));

      // Update local state
      allLogs = allLogs.filter(l => l.id !== setId);

      // Update exerciseSessionSets to reflect the deletion
      exerciseSessionSets = exerciseSessionSets.filter(s => s.id !== setId);

      // Recalculate PRs first
      recalculatePRs();

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

  // Helper: Recalculate PRs from allLogs
  function recalculatePRs() {
    const prs = {};
    allLogs.forEach(log => {
      const weight = parseFloat(log.weight) || 0;
      const exerciseId = log.exerciseId;
      const exerciseName = log.exerciseName;

      if (!prs[exerciseId] || weight > prs[exerciseId].weight) {
        prs[exerciseId] = {
          exerciseName,
          weight,
          reps: log.reps,
          sets: log.sets,
          date: log.loggedAt,
          programName: log.programName,
          dayName: log.dayName
        };
      }
    });
    exercisePRs = prs;
  }

  // Helper: Recalculate e1rm and repRanges for selected exercise
  function recalculateSelectedExerciseHistory() {
    if (!selectedExercise) return;

    const exerciseLogs = allLogs.filter(l => l.exerciseId === selectedExercise.exerciseId && l.completedWorkoutId);

    if (exerciseLogs.length === 0) {
      selectedExerciseHistory = { e1rm: null, repRanges: { '1-5': null, '6-8': null, '9-12': null } };
      return;
    }

    let best1RM = null;
    const repRanges = { '1-5': null, '6-8': null, '9-12': null };

    exerciseLogs.forEach(log => {
      const weight = parseFloat(log.weight) || 0;
      const reps = parseInt(log.reps) || 0;
      if (weight <= 0 || reps <= 0) return;

      const e1rm = weight * (1 + reps / 30);
      if (!best1RM || e1rm > best1RM.e1rm) {
        best1RM = { e1rm: Math.round(e1rm), weight, reps, date: log.loggedAt, notes: log.notes };
      }

      let range = null;
      if (reps >= 1 && reps <= 5) range = '1-5';
      else if (reps >= 6 && reps <= 8) range = '6-8';
      else if (reps >= 9 && reps <= 12) range = '9-12';

      if (range && (!repRanges[range] || weight > repRanges[range].weight)) {
        repRanges[range] = { weight, reps, date: log.loggedAt, notes: log.notes };
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

    // Compute metric per session
    const points = [];
    Object.values(sessionMap).forEach(session => {
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
        let peakWeight = null;
        let peakE1rm = null;
        session.sets.forEach(s => {
          const w = parseFloat(s.weight) || 0;
          const r = parseInt(s.reps) || 0;
          if (w > 0) { if (peakWeight === null || w > peakWeight) peakWeight = w; }
          if (w > 0 && r > 0) { const e = w * (1 + r / 30); if (peakE1rm === null || e > peakE1rm) peakE1rm = e; }
        });
        if (peakWeight && peakE1rm) value = Math.round(100 * peakWeight / peakE1rm * 10) / 10;
      } else if (analysisMetric === 'custom' && analysisCustomReqIdx !== '') {
        session.sets.forEach(s => {
          if (s.customInputs && s.customInputs[analysisCustomReqIdx] !== undefined) {
            const v = parseFloat(s.customInputs[analysisCustomReqIdx]);
            if (!isNaN(v) && (value === null || v > value)) value = v;
          }
        });
      }
      if (value !== null) {
        points.push({ date: session.date, value });
      }
    });

    // Sort chronologically
    points.sort((a, b) => {
      const da = a.date?.toDate ? a.date.toDate() : new Date(a.date);
      const db = b.date?.toDate ? b.date.toDate() : new Date(b.date);
      return da - db;
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
        if (!buckets[key]) buckets[key] = { values: [], firstDate: d };
        buckets[key].values.push(p.value);
        if (d < buckets[key].firstDate) buckets[key].firstDate = d;
      });
      return Object.values(buckets)
        .map(b => ({ date: b.firstDate, value: Math.round(b.values.reduce((a, v) => a + v, 0) / b.values.length) }))
        .sort((a, b) => a.date - b.date);
    } else {
      // Bucket by consecutive blocks of N sessions
      const result = [];
      for (let i = 0; i < points.length; i += avgBySessions) {
        const block = points.slice(i, i + avgBySessions);
        if (block.length === 0) continue;
        const avg = Math.round(block.reduce((a, p) => a + p.value, 0) / block.length);
        result.push({ date: block[block.length - 1].date, value: avg });
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
      <p style="color: #888; margin-bottom: 15px;">{getPRsList().length} exercise{getPRsList().length !== 1 ? 's' : ''} with PRs</p>

      {#each getPRsList() as pr}
        <div onclick={() => openExerciseHistory(pr.exerciseId, pr.exerciseName)} style="background: white; border: 1px solid #e0e0e0; border-radius: 10px; padding: 15px; margin-bottom: 12px; border-left: 4px solid #ff9800; cursor: pointer;" onmouseenter={(e) => e.currentTarget.style.borderColor = '#ff9800'} onmouseleave={(e) => e.currentTarget.style.borderColor = '#e0e0e0'}>
          <div style="display: flex; justify-content: space-between; align-items: start;">
            <div>
              <strong style="font-size: 1.1em;">{pr.exerciseName}</strong>
              <div style="margin-top: 8px; background: linear-gradient(135deg, #ff9800 0%, #f57c00 100%); color: white; padding: 8px 12px; border-radius: 6px; display: inline-block;">
                <span style="font-size: 1.2em; font-weight: bold;">{pr.weight} lbs</span>
                <span style="opacity: 0.9;"> × {pr.reps} reps</span>
              </div>
            </div>
            <div style="text-align: right; font-size: 0.85em; color: #888;">
              <div>{formatDate(pr.date)}</div>
              <div style="margin-top: 3px;">{pr.dayName}</div>
            </div>
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
            <div style="font-weight: 600; margin-bottom: 10px; color: #333;">
              {analysisMetric === 'weight' ? 'Max Weight' : analysisMetric === 'volume' ? 'Total Volume' : analysisMetric === 'e1rm' ? 'Estimated 1RM' : analysisMetric === 'pct_e1rm' ? '% of e1RM' : (getCustomReqOptions().find(r => r.idx === analysisCustomReqIdx)?.name || 'Custom Requirement')} Over Time
            </div>
            <svg viewBox="0 0 400 200" style="width: 100%; height: auto;">
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
                <circle cx={x} cy={y} r="5" fill="#9c27b0"/>
                {#if chartData.length <= 10}
                  <text x={x} y="195" font-size="8" fill="#888" text-anchor="middle">{formatChartDate(d.date)}</text>
                {/if}
              {/each}
              {#if chartData.length > 10}
                <text x="40" y="195" font-size="8" fill="#888" text-anchor="start">{formatChartDate(chartData[0].date)}</text>
                <text x="390" y="195" font-size="8" fill="#888" text-anchor="end">{formatChartDate(chartData[chartData.length - 1].date)}</text>
              {/if}
            </svg>
            <div style="text-align: center; color: #888; font-size: 0.85em; margin-top: 5px;">
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
          <div style="font-size: 0.8em; opacity: 0.85;">Based on {selectedExerciseHistory.e1rm.weight}×{selectedExerciseHistory.e1rm.reps} ({formatDate(selectedExerciseHistory.e1rm.date)})</div>
        </div>
      {/if}

      <!-- Rep Range PRs -->
      {#if selectedExerciseHistory?.repRanges && (selectedExerciseHistory.repRanges['1-5'] || selectedExerciseHistory.repRanges['6-8'] || selectedExerciseHistory.repRanges['9-12'])}
        <div style="margin-bottom: 15px;">
          <div style="font-weight: 600; color: #333; margin-bottom: 10px; font-size: 0.9em;">Rep Range PRs</div>
          <div style="display: grid; gap: 8px;">
            {#if selectedExerciseHistory.repRanges['1-5']}
              <div style="background: #e3f2fd; padding: 10px 12px; border-radius: 8px; border-left: 4px solid #1565c0;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-weight: 600; color: #1565c0;">1-5 Reps (Strength)</span>
                  <span style="font-weight: bold; color: #333;">{selectedExerciseHistory.repRanges['1-5'].weight} × {selectedExerciseHistory.repRanges['1-5'].reps}</span>
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
                  <span style="font-weight: bold; color: #333;">{selectedExerciseHistory.repRanges['6-8'].weight} × {selectedExerciseHistory.repRanges['6-8'].reps}</span>
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
                  <span style="font-weight: bold; color: #333;">{selectedExerciseHistory.repRanges['9-12'].weight} × {selectedExerciseHistory.repRanges['9-12'].reps}</span>
                </div>
                <div style="font-size: 0.8em; color: #666; margin-top: 4px;">{formatDate(selectedExerciseHistory.repRanges['9-12'].date)}</div>
                {#if selectedExerciseHistory.repRanges['9-12'].notes}
                  <div style="font-size: 0.8em; color: #888; font-style: italic; margin-top: 4px;">"{selectedExerciseHistory.repRanges['9-12'].notes}"</div>
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
          <span style="flex: 1;">{set.reps || '-'} × {set.weight || '-'}</span>
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

