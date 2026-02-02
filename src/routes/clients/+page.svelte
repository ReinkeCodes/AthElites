<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, query, where, getDocs, doc, getDoc, limit as firestoreLimit } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import SessionDetailModal from '$lib/components/SessionDetailModal.svelte';

  let loading = $state(true);
  let currentUserId = $state(null);
  let allUsers = $state([]);
  let selectedUserId = $state(null);
  let workoutSessions = $state([]);
  let sessionsLoading = $state(false);
  let sessions7Days = $state(null);
  let sessions7DaysPrev = $state(null);
  let sessions30Days = $state(null);
  let sessions30DaysPrev = $state(null);
  let programCache = $state({});
  let prescribedSetsMap = $state({});
  let loggedSetsMap = $state({});
  let selectedSession = $state(null);
  let selectedSessionLogs = $state([]);
  let sessionLogsLoading = $state(false);

  // Compute total prescribed sets for Full Tracking exercises only
  function computePrescribedSets(dayTemplate) {
    if (!dayTemplate?.sections) return null;
    let total = 0;
    for (const section of dayTemplate.sections) {
      if (section.mode === 'checkbox') continue;
      for (const exercise of section.exercises || []) {
        total += parseInt(exercise.sets) || 3;
      }
    }
    return total;
  }

  // Get Full Tracking exercise identifiers from template (for filtering logs)
  function getFullTrackingIds(dayTemplate) {
    const ids = { workoutExerciseIds: new Set(), exerciseIds: new Set() };
    if (!dayTemplate?.sections) return ids;
    for (const section of dayTemplate.sections) {
      if (section.mode === 'checkbox') continue;
      for (const exercise of section.exercises || []) {
        if (exercise.workoutExerciseId) ids.workoutExerciseIds.add(exercise.workoutExerciseId);
        if (exercise.exerciseId) ids.exerciseIds.add(exercise.exerciseId);
      }
    }
    return ids;
  }

  // Sort users by first name for dropdown
  function getSortedUsers() {
    return allUsers.slice().sort((a, b) => {
      const aName = (a.displayName?.split(' ')[0] || a.email || '').toLowerCase();
      const bName = (b.displayName?.split(' ')[0] || b.email || '').toLowerCase();
      return aName.localeCompare(bName);
    });
  }

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        goto('/login');
        return;
      }
      currentUserId = user.uid;
      const userDoc = await getDoc(doc(db, 'user', user.uid));
      if (userDoc.exists() && userDoc.data().role === 'admin') {
        // Load all users for picker
        try {
          const usersSnap = await getDocs(collection(db, 'user'));
          allUsers = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (e) {
          console.log('Could not load users:', e);
        }
        loading = false;
      } else {
        goto('/');
      }
    });
  });

  // Load sessions when admin selects a user
  $effect(() => {
    if (selectedUserId && !loading) {
      loadWorkoutSessions();
    }
  });

  async function loadWorkoutSessions() {
    if (!selectedUserId) return;
    sessionsLoading = true;
    prescribedSetsMap = {};
    loggedSetsMap = {};

    try {
      const sessionsQuery = query(
        collection(db, 'workoutSessions'),
        where('userId', '==', selectedUserId)
      );
      const snapshot = await getDocs(sessionsQuery);
      const allSessions = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const dateA = a.finishedAt?.toDate ? a.finishedAt.toDate() : new Date(a.finishedAt);
          const dateB = b.finishedAt?.toDate ? b.finishedAt.toDate() : new Date(b.finishedAt);
          return dateB - dateA;
        });

      // Compute session counts for different windows
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

      let current7 = 0, prev7 = 0, current30 = 0, prev30 = 0;
      allSessions.forEach(s => {
        if (!s.finishedAt) return;
        const date = s.finishedAt.toDate ? s.finishedAt.toDate() : new Date(s.finishedAt);
        if (date >= sevenDaysAgo) current7++;
        else if (date >= fourteenDaysAgo) prev7++;
        if (date >= thirtyDaysAgo) current30++;
        else if (date >= sixtyDaysAgo) prev30++;
      });
      sessions7Days = current7;
      sessions7DaysPrev = prev7;
      sessions30Days = current30;
      sessions30DaysPrev = prev30;

      // Fetch programs for prescribed sets computation (cached)
      const last10 = allSessions.slice(0, 10);
      const programIds = [...new Set(last10.map(s => s.programId).filter(Boolean))];
      const toFetch = programIds.filter(pid => !programCache[pid]);
      await Promise.all(toFetch.map(async pid => {
        try {
          const snap = await getDoc(doc(db, 'programs', pid));
          if (snap.exists()) programCache[pid] = { id: snap.id, ...snap.data() };
        } catch (e) { /* ignore fetch errors */ }
      }));
      programCache = { ...programCache };

      // Compute prescribed sets and Full Tracking IDs for each session
      const setsMap = {};
      const templateMap = {};
      for (const session of last10) {
        const program = programCache[session.programId];
        const dayTemplate = program?.publishedDays?.find(d => d.name === session.dayName);
        setsMap[session.id] = computePrescribedSets(dayTemplate);
        templateMap[session.id] = getFullTrackingIds(dayTemplate);
      }
      prescribedSetsMap = setsMap;

      // Query workoutLogs for last 10 sessions to compute logged sets
      const loggedMap = {};
      const sessionIds = last10.map(s => s.id).filter(Boolean);
      if (sessionIds.length > 0) {
        try {
          // Firestore 'in' supports up to 30 items, so we're safe with 10
          const logsQuery = query(
            collection(db, 'workoutLogs'),
            where('completedWorkoutId', 'in', sessionIds)
          );
          const logsSnap = await getDocs(logsQuery);
          // Group logs by session and count distinct (exerciseGroupKey, setNumber)
          const logsBySession = {};
          logsSnap.docs.forEach(d => {
            const log = d.data();
            const sid = log.completedWorkoutId;
            if (!logsBySession[sid]) logsBySession[sid] = [];
            logsBySession[sid].push(log);
          });
          for (const session of last10) {
            const logs = logsBySession[session.id] || [];
            const ftIds = templateMap[session.id];
            const seen = new Set();
            for (const log of logs) {
              const key = log.workoutExerciseId || log.exerciseId;
              if (!key) continue;
              // Check if this log is for a Full Tracking exercise
              const isFullTracking = ftIds.workoutExerciseIds.has(log.workoutExerciseId) ||
                (!log.workoutExerciseId && ftIds.exerciseIds.has(log.exerciseId));
              if (!isFullTracking) continue;
              const setNum = log.setNumber || 1;
              seen.add(`${key}|${setNum}`);
            }
            loggedMap[session.id] = seen.size;
          }
        } catch (e) {
          console.log('Could not load workout logs:', e);
        }
      }
      loggedSetsMap = loggedMap;

      workoutSessions = last10;
    } catch (e) {
      console.log('Could not load sessions:', e);
      workoutSessions = [];
      sessions7Days = 0;
      sessions7DaysPrev = 0;
      sessions30Days = 0;
      sessions30DaysPrev = 0;
      prescribedSetsMap = {};
      loggedSetsMap = {};
    }
    sessionsLoading = false;
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // Get completion info for a session (percent, text, color, glow)
  function getCompletionInfo(sessionId) {
    const prescribed = prescribedSetsMap[sessionId];
    const logged = loggedSetsMap[sessionId] ?? 0;
    if (!prescribed || prescribed === 0) {
      return { text: '-', color: '#888', glow: 'none' };
    }
    const pct = Math.min(100, Math.max(0, Math.round((logged / prescribed) * 100)));
    if (pct > 80) {
      return { text: `${pct}% Completed`, color: '#16a34a', glow: '0 0 12px rgba(22, 163, 74, 0.35)' };
    } else if (pct >= 50) {
      return { text: `${pct}% Completed`, color: '#ca8a04', glow: '0 0 12px rgba(202, 138, 4, 0.35)' };
    } else {
      return { text: `${pct}% Completed`, color: '#dc2626', glow: '0 0 12px rgba(220, 38, 38, 0.35)' };
    }
  }

  // Group logs by exercise for display (mirrors History page logic)
  function groupLogsByExercise(logs) {
    const grouped = {};
    logs.forEach(log => {
      const key = log.workoutExerciseId || log.exerciseId;
      if (!grouped[key]) {
        grouped[key] = {
          workoutExerciseId: log.workoutExerciseId,
          exerciseId: log.exerciseId,
          exerciseName: log.exerciseName,
          sets: []
        };
      }
      grouped[key].sets.push({
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
    return Object.values(grouped).map(exercise => {
      exercise.sets.sort((a, b) => a.setNumber - b.setNumber);
      return exercise;
    });
  }

  // Open session detail modal and load logs for that session only
  async function openSessionDetail(session) {
    selectedSession = session;
    sessionLogsLoading = true;
    selectedSessionLogs = [];
    try {
      const logsQuery = query(
        collection(db, 'workoutLogs'),
        where('completedWorkoutId', '==', session.id)
      );
      const logsSnap = await getDocs(logsQuery);
      selectedSessionLogs = logsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.log('Could not load session logs:', e);
      selectedSessionLogs = [];
    }
    sessionLogsLoading = false;
  }

  function closeSessionDetail() {
    selectedSession = null;
    selectedSessionLogs = [];
  }

  // Close modal when user changes
  $effect(() => {
    if (selectedUserId) {
      closeSessionDetail();
    }
  });

  // Compute missing sets for a session (Full Tracking only)
  function getMissingSets(session, logs) {
    if (!session?.programId || !session?.dayName) return [];
    const program = programCache[session.programId];
    const dayTemplate = program?.publishedDays?.find(d => d.name === session.dayName);
    if (!dayTemplate?.sections) return [];

    // Build map of logged set numbers per exercise key
    const loggedByExercise = {};
    logs.forEach(log => {
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
</script>

{#if loading}
  <p>Loading...</p>
{:else}
  <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 20px;">
    <h1 style="margin: 0;">Client Dashboard</h1>
    <select
      value={selectedUserId}
      onchange={(e) => selectedUserId = e.target.value}
      style="padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.95em; min-width: 180px;"
    >
      {#if allUsers.length === 0}
        <option disabled>Loading users…</option>
      {:else}
        <option value="" disabled selected={!selectedUserId}>Select a client</option>
        {#each getSortedUsers() as user}
          <option value={user.id}>{user.displayName || user.email}</option>
        {/each}
      {/if}
    </select>
  </div>

  <!-- Stat Cards -->
  <div style="display: flex; gap: 15px; margin-bottom: 20px;">
    <div style="flex: 1; background: white; border: 1px solid #ddd; border-radius: 10px; padding: 20px;">
      <div style="color: #666; font-size: 0.9em; margin-bottom: 8px;">Sessions logged (last 7 days)</div>
      <div style="font-size: 2em; font-weight: bold; color: {sessions7Days > sessions7DaysPrev ? '#16a34a' : sessions7Days < sessions7DaysPrev ? '#dc2626' : '#000'};">
        {#if !selectedUserId}
          <span style="color: #000;">—</span>
        {:else if sessionsLoading}
          <span style="color: #000;">...</span>
        {:else}
          {sessions7Days}
        {/if}
      </div>
    </div>
    <div style="flex: 1; background: white; border: 1px solid #ddd; border-radius: 10px; padding: 20px;">
      <div style="color: #666; font-size: 0.9em; margin-bottom: 8px;">Sessions logged (last 30 days)</div>
      <div style="font-size: 2em; font-weight: bold; color: {sessions30Days > sessions30DaysPrev ? '#16a34a' : sessions30Days < sessions30DaysPrev ? '#dc2626' : '#000'};">
        {#if !selectedUserId}
          <span style="color: #000;">—</span>
        {:else if sessionsLoading}
          <span style="color: #000;">...</span>
        {:else}
          {sessions30Days}
        {/if}
      </div>
    </div>
  </div>

  {#if !selectedUserId}
    <p style="color: #888; text-align: center; padding: 20px 0;">Select a client to view their recent workouts.</p>
  {:else if sessionsLoading}
    <p style="color: #888;">Loading sessions...</p>
  {:else if workoutSessions.length === 0}
    <p style="color: #888; text-align: center; padding: 40px 0;">No workouts completed yet for this client.</p>
  {:else}
    <p style="color: #888; margin-bottom: 15px;">Last {workoutSessions.length} workout{workoutSessions.length !== 1 ? 's' : ''}</p>

    {#each workoutSessions as session}
      {@const completion = getCompletionInfo(session.id)}
      <div
        onclick={() => openSessionDetail(session)}
        style="background: white; border: 1px solid #ddd; border-radius: 10px; padding: 15px; margin-bottom: 12px; cursor: pointer; transition: all 0.2s; box-shadow: {completion.glow};"
        onmouseenter={(e) => e.currentTarget.style.borderColor = '#667eea'}
        onmouseleave={(e) => e.currentTarget.style.borderColor = '#ddd'}
      >
        <div style="display: flex; justify-content: space-between; align-items: start;">
          <div>
            <strong style="font-size: 1.1em;">{session.dayName}</strong>
            <p style="margin: 3px 0 0 0; color: #666; font-size: 0.9em;">{session.programName}</p>
          </div>
          <div style="text-align: right;">
            <div style="display: flex; align-items: center; gap: 10px; justify-content: flex-end;">
              <span style="color: {completion.color}; font-size: 0.85em; font-weight: 500;">{completion.text}</span>
              <span style="color: #888; font-size: 0.85em;">{formatDate(session.finishedAt)}</span>
            </div>
            {#if session.durationMinutes}
              <div style="color: #667eea; font-size: 0.85em; margin-top: 2px;">{session.durationMinutes} min</div>
            {/if}
          </div>
        </div>
        <div style="margin-top: 8px; color: #888; font-size: 0.85em;">
          Prescribed Sets: {prescribedSetsMap[session.id] ?? '—'} &nbsp;&nbsp; Logged Sets: {loggedSetsMap[session.id] ?? '—'}
        </div>
      </div>
    {/each}
  {/if}
{/if}

{#if selectedSession}
<div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px;" onclick={closeSessionDetail}>
  <div style="background: white; border-radius: 12px; width: 100%; max-width: 600px; max-height: 90vh; overflow-y: auto; padding: 20px;" onclick={(e) => e.stopPropagation()}>
    {#if sessionLogsLoading}
      <p style="color: #888; text-align: center; padding: 20px 0;">Loading session details...</p>
    {:else}
      <SessionDetailModal
        session={selectedSession}
        groupedLogs={groupLogsByExercise(selectedSessionLogs)}
        onClose={closeSessionDetail}
        missingSets={getMissingSets(selectedSession, selectedSessionLogs)}
      />
    {/if}
  </div>
</div>
{/if}
