<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, query, where, getDocs, orderBy, doc, getDoc, deleteDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

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
  </div>

  {#if activeTab === 'workouts'}
    {#if selectedSession}
      <!-- Session Detail View -->
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
        <button onclick={() => selectedSession = null} style="padding: 8px 16px; background: #f5f5f5; border: 1px solid #ddd; cursor: pointer; border-radius: 5px;">
          ← Back to all workouts
        </button>
        <button onclick={() => deleteSession(selectedSession)} style="padding: 8px 16px; background: #ffebee; border: 1px solid #ef5350; color: #c62828; cursor: pointer; border-radius: 5px;">
          Delete Workout
        </button>
      </div>

      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; margin-bottom: 20px;">
        <h2 style="margin: 0 0 5px 0;">{selectedSession.dayName}</h2>
        <p style="margin: 0; opacity: 0.9;">{selectedSession.programName}</p>
        <p style="margin: 10px 0 0 0; font-size: 0.9em; opacity: 0.85;">
          {formatFullDate(selectedSession.finishedAt)}
          {#if selectedSession.durationMinutes}
            • {selectedSession.durationMinutes} minutes
          {/if}
        </p>
      </div>

      <h3>Exercises</h3>
      {#each getSessionLogs(selectedSession) as exercise}
        <div style="background: white; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px 15px; margin-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong style="font-size: 1.05em;">{exercise.exerciseName}</strong>
            <button
              onclick={(e) => { e.stopPropagation(); deleteExerciseLogs(selectedSession.id, exercise); }}
              style="background: none; border: none; color: #999; cursor: pointer; font-size: 1.1em; padding: 4px 8px; line-height: 1;"
              title="Delete all sets for this exercise"
            >×</button>
          </div>
          <div style="margin-top: 8px;">
            {#each exercise.sets as set}
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; margin-bottom: 4px; background: #f8f9fa; border-radius: 5px; font-size: 0.9em;">
                <span style="font-weight: bold; color: #667eea; min-width: 35px;">Set {set.setNumber}</span>
                <span style="color: #333;">
                  <strong>{set.reps || '-'}</strong> {set.repsMetric === 'distance' ? '' : 'reps'} @ <strong>{set.weight || '-'}</strong> {set.weightMetric === 'time' ? '' : 'lbs'}
                  {#if set.rir} <span style="color: #888;">(RIR: {set.rir})</span>{/if}
                </span>
              </div>
              {#if set.customInputs}{#each Object.entries(set.customInputs) as [idx, val]}{#if val}{@const reqs = getCustomReqs(set.programId, set.workoutExerciseId)}{@const req = reqs?.[parseInt(idx)]}<div style="color: #9c27b0; font-size: 0.8em; margin: 2px 0 0 45px;">{req?.name || `Custom ${parseInt(idx)+1}`}: {val}{#if req?.value} {req.value}{/if}</div>{/if}{/each}{/if}
              {#if set.notes && set.notes !== 'Did not complete'}
                <div style="color: #666; font-style: italic; font-size: 0.85em; margin: 0 0 6px 45px;">"{set.notes}"</div>
              {/if}
            {/each}
          </div>
        </div>
      {/each}

      {#if getSessionLogs(selectedSession).length === 0}
        <p style="color: #888;">No exercise logs found for this session.</p>
      {/if}

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

  {:else}
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
        {#if set.customInputs}{#each Object.entries(set.customInputs) as [idx, val]}{#if val}{@const reqs = getCustomReqs(set.programId, set.workoutExerciseId)}{@const req = reqs?.[parseInt(idx)]}<div style="color: #9c27b0; font-size: 0.85em; margin: 0 0 4px 57px;">{req?.name || `Custom ${parseInt(idx)+1}`}: {val}{#if req?.value} {req.value}{/if}</div>{/if}{/each}{/if}
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

