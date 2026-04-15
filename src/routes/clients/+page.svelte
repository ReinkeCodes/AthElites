<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, query, where, getDocs, doc, getDoc, limit as firestoreLimit } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import SessionDetailModal from '$lib/components/SessionDetailModal.svelte';
  import { listProgramCycles, normalizeExpiredCyclesIfNeeded, getEndOfDay } from '$lib/programCycleHelpers.js';

  let loading = $state(true);
  let currentUserId = $state(null);
  let allUsers = $state([]);
  let selectedUserId = $state(null);
  let workoutSessions = $state([]);
  let allUserSessions = $state([]); // All sessions for cycle stats
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

  // Program cycles state
  let clientCycles = $state([]);
  let cyclesLoading = $state(false);
  let clientLegacyPrograms = $state([]); // assigned programs with no cycle records

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
        // Restore selected client from URL (e.g. after returning via browser back)
        const clientParam = $page.url.searchParams.get('client');
        if (clientParam) {
          selectedUserId = clientParam;
        }
      } else {
        goto('/');
      }
    });
  });

  // Load sessions and cycles when admin selects a user
  $effect(() => {
    if (selectedUserId && !loading) {
      loadWorkoutSessions();
      loadClientCycles();
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

      // Store all sessions for cycle stats calculation
      allUserSessions = allSessions;

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
      allUserSessions = [];
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

  // =============================================================================
  // Program Cycle Functions
  // =============================================================================

  // Load cycles when user is selected (called alongside loadWorkoutSessions)
  async function loadClientCycles() {
    if (!selectedUserId) {
      clientCycles = [];
      clientLegacyPrograms = [];
      return;
    }
    cyclesLoading = true;
    try {
      const cycles = await listProgramCycles(selectedUserId);
      // Opportunistically normalize any cycles that are stored as active but effectively expired
      const normalizedCycles = await normalizeExpiredCyclesIfNeeded(selectedUserId, cycles);
      clientCycles = normalizedCycles;
      // Load legacy programs now that we know which programIds have cycles
      await loadLegacyPrograms(normalizedCycles);
    } catch (e) {
      console.log('Could not load client cycles:', e);
      clientCycles = [];
      clientLegacyPrograms = [];
    }
    cyclesLoading = false;
  }

  // Load programs assigned to the client that have no cycle records at all
  async function loadLegacyPrograms(cycles) {
    if (!selectedUserId) {
      clientLegacyPrograms = [];
      return;
    }
    try {
      const programsSnap = await getDocs(
        query(collection(db, 'programs'), where('assignedToUids', 'array-contains', selectedUserId))
      );
      const assignedPrograms = programsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Exclude any program that already has at least one cycle record for this client
      const programsWithCycles = new Set((cycles || []).map(c => c.programId));
      clientLegacyPrograms = assignedPrograms.filter(p => !programsWithCycles.has(p.id));
    } catch (e) {
      console.log('Could not load legacy programs:', e);
      clientLegacyPrograms = [];
    }
  }

  // Count all sessions for a program regardless of cycle window (used for legacy items)
  function getLegacySessionCount(programId) {
    return allUserSessions.filter(s => s.programId === programId && s.finishedAt).length;
  }

  // Check if a cycle is effectively active (status='active' AND endsAt not past inclusive end-of-day)
  function isEffectivelyActive(cycle) {
    if (cycle.status !== 'active') return false;
    const now = new Date();
    const endsAt = cycle.endsAt?.toDate ? cycle.endsAt.toDate() : new Date(cycle.endsAt);
    // Use inclusive end-of-day: cycle is active through the entire end date
    const endOfEndDay = getEndOfDay(endsAt);
    return now <= endOfEndDay;
  }

  // Get effective end date for a cycle (closedAt if present, otherwise endsAt)
  function getEffectiveEndDate(cycle) {
    if (cycle.closedAt) {
      return cycle.closedAt.toDate ? cycle.closedAt.toDate() : new Date(cycle.closedAt);
    }
    return cycle.endsAt?.toDate ? cycle.endsAt.toDate() : new Date(cycle.endsAt);
  }

  // Get active cycles, sorted by soonest ending first
  function getActiveCycles() {
    return clientCycles
      .filter(isEffectivelyActive)
      .sort((a, b) => {
        const aEnd = a.endsAt?.toDate ? a.endsAt.toDate() : new Date(a.endsAt);
        const bEnd = b.endsAt?.toDate ? b.endsAt.toDate() : new Date(b.endsAt);
        return aEnd - bEnd; // Soonest ending first
      });
  }

  // Get past cycles (not effectively active), sorted by most recently ended first, limit 3
  function getPastCycles() {
    return clientCycles
      .filter(c => !isEffectivelyActive(c))
      .sort((a, b) => {
        const aEnd = getEffectiveEndDate(a);
        const bEnd = getEffectiveEndDate(b);
        return bEnd - aEnd; // Most recently ended first
      })
      .slice(0, 3);
  }

  // Count sessions that fall within a cycle window
  function getCycleSessionCount(cycle, isActive) {
    const startedAt = cycle.startedAt?.toDate ? cycle.startedAt.toDate() : new Date(cycle.startedAt);
    const endDate = isActive ? new Date() : getEffectiveEndDate(cycle);

    return allUserSessions.filter(session => {
      if (session.programId !== cycle.programId) return false;
      if (!session.finishedAt) return false;
      const sessionDate = session.finishedAt.toDate ? session.finishedAt.toDate() : new Date(session.finishedAt);
      return sessionDate >= startedAt && sessionDate <= endDate;
    }).length;
  }

  // Calculate elapsed weeks for a cycle window
  function getElapsedWeeks(cycle, isActive) {
    const startedAt = cycle.startedAt?.toDate ? cycle.startedAt.toDate() : new Date(cycle.startedAt);
    const endDate = isActive ? new Date() : getEffectiveEndDate(cycle);
    const msElapsed = endDate - startedAt;
    const weeksElapsed = msElapsed / (7 * 24 * 60 * 60 * 1000);
    return Math.max(weeksElapsed, 0.1); // Avoid division by zero
  }

  // Calculate avg sessions per week (rounded to nearest tenth)
  function getCycleAvgPerWeek(cycle, isActive) {
    const sessionCount = getCycleSessionCount(cycle, isActive);
    const elapsedWeeks = getElapsedWeeks(cycle, isActive);
    const avg = sessionCount / elapsedWeeks;
    return Math.round(avg * 10) / 10;
  }

  // Calculate weeks remaining for active cycles (rounded to nearest tenth)
  function getWeeksRemaining(cycle) {
    const now = new Date();
    const endsAt = cycle.endsAt?.toDate ? cycle.endsAt.toDate() : new Date(cycle.endsAt);
    const msRemaining = endsAt - now;
    const weeksRemaining = msRemaining / (7 * 24 * 60 * 60 * 1000);
    return Math.round(Math.max(weeksRemaining, 0) * 10) / 10;
  }

  // Format cycle date for display
  function formatCycleDate(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Get display-friendly status label for past cycles
  function getCycleStatusLabel(cycle) {
    switch (cycle.status) {
      case 'completed': return 'Completed';
      case 'expired': return 'Expired';
      case 'removed': return 'Removed';
      case 'active': return 'Past Due'; // Was active but endsAt is in the past
      default: return cycle.status || 'Unknown';
    }
  }

  // Get status color for past cycles
  function getCycleStatusColor(cycle) {
    switch (cycle.status) {
      case 'completed': return '#16a34a';
      case 'expired': return '#dc2626';
      case 'removed': return '#888';
      case 'active': return '#ca8a04'; // Past due (was active but time elapsed)
      default: return '#888';
    }
  }

  // =============================================================================
  // Active cycle adherence helpers
  // =============================================================================

  // Format a number compactly: integer → no decimal, otherwise 1 decimal place
  function formatAdherenceNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const rounded = Math.round(n * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  // Expected sessions completed by now, based on elapsed fraction of cycle window
  function getCycleExpectedByNow(cycle) {
    if (cycle.workoutsPerWeekTarget == null) return null;
    const startedAt = cycle.startedAt?.toDate ? cycle.startedAt.toDate() : new Date(cycle.startedAt);
    const endsAt = cycle.endsAt?.toDate ? cycle.endsAt.toDate() : new Date(cycle.endsAt);
    const totalMs = getEndOfDay(endsAt) - startedAt;
    if (totalMs <= 0) return 0;
    const elapsedMs = Math.min(Date.now() - startedAt.getTime(), totalMs);
    const fraction = elapsedMs / totalMs;
    const expectedTotal = cycle.durationWeeks * cycle.workoutsPerWeekTarget;
    return Math.round(fraction * expectedTotal * 10) / 10;
  }

  // Adherence status chip label
  function getAdherenceStatus(sessionCount, expectedByNow) {
    if (expectedByNow === null) return null;
    const diff = sessionCount - expectedByNow;
    if (diff > 0.5) return 'Ahead';
    if (diff >= -0.5) return 'On Track';
    if (diff >= -1.5) return 'Slightly Behind';
    return 'Behind';
  }

  // Chip color pairs for each adherence status
  function adherenceChipStyle(status) {
    switch (status) {
      case 'Ahead':          return 'background:#dcfce7;color:#15803d;';
      case 'On Track':       return 'background:#dbeafe;color:#1565c0;';
      case 'Slightly Behind':return 'background:#fff3e0;color:#e65100;';
      case 'Behind':         return 'background:#ffebee;color:#c62828;';
      default:               return 'background:#f3f4f6;color:#6b7280;';
    }
  }
</script>

{#if loading}
  <p>Loading...</p>
{:else}
  <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 20px;">
    <h1 style="margin: 0;">Client Dashboard</h1>
    <select
      value={selectedUserId}
      onchange={(e) => {
        selectedUserId = e.target.value;
        if (e.target.value) {
          goto(`/clients?client=${e.target.value}`, { replaceState: true, noScroll: true, keepFocus: true });
        }
      }}
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

  <!-- Program Cycles Sections (below stat cards, above workouts) -->
  {#if selectedUserId && !cyclesLoading}
    {@const activeCycles = getActiveCycles()}
    {@const pastCycles = getPastCycles()}

    <!-- Active Program Cycles -->
    <div style="margin-bottom: 20px;">
      <h3 style="margin: 0 0 12px 0; font-size: 1em; color: #333;">Active Program Cycles</h3>
      {#if activeCycles.length === 0}
        <p style="color: #888; font-size: 0.9em; padding: 15px; background: #f9f9f9; border-radius: 8px; margin: 0;">No active cycles.</p>
      {:else}
        <div style="display: flex; flex-direction: column; gap: 10px;">
          {#each activeCycles as cycle}
            {@const sessionCount = getCycleSessionCount(cycle, true)}
            {@const avgPerWeek = getCycleAvgPerWeek(cycle, true)}
            {@const weeksRemaining = getWeeksRemaining(cycle)}
            {@const hasGoal = cycle.workoutsPerWeekTarget != null}
            {@const expectedByNow = getCycleExpectedByNow(cycle)}
            {@const adherenceStatus = getAdherenceStatus(sessionCount, expectedByNow)}
            {@const expectedTotal = hasGoal ? cycle.durationWeeks * cycle.workoutsPerWeekTarget : null}
            <div style="background: white; border: 1px solid #ddd; border-radius: 8px; padding: 12px 15px;">
              <div style="display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: 10px;">

                <!-- Left: title + chip · dates · expected total -->
                <div style="flex: 1; min-width: 150px;">
                  <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    <strong style="font-size: 0.95em; color: #333;">{cycle.programNameSnapshot || 'Unknown Program'}</strong>
                    {#if hasGoal && adherenceStatus}
                      <span style="padding: 2px 7px; border-radius: 10px; font-size: 0.72em; font-weight: 500; {adherenceChipStyle(adherenceStatus)}">{adherenceStatus}</span>
                    {/if}
                  </div>
                  <div style="margin-top: 4px; font-size: 0.85em; color: #666;">
                    Ends {formatCycleDate(cycle.endsAt)} · {weeksRemaining} wk{weeksRemaining !== 1 ? 's' : ''} remaining
                  </div>
                  {#if hasGoal}
                    <div style="margin-top: 2px; font-size: 0.8em; color: #999;">Expected total: {formatAdherenceNum(expectedTotal)}</div>
                  {:else}
                    <div style="margin-top: 3px; font-size: 0.78em; color: #bbb; font-style: italic;">No adherence goal yet</div>
                  {/if}
                </div>

                <!-- Right: 2×2 metrics grid · button (button vertically centered against grid) -->
                <div style="display: flex; gap: 12px; align-items: center; flex-shrink: 0;">
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 2px 16px;">
                    <div style="text-align: center;">
                      <div style="font-size: 1.1em; font-weight: 600; color: #333;">{sessionCount}</div>
                      <div style="font-size: 0.75em; color: #888;">Sessions</div>
                    </div>
                    <div style="text-align: center;">
                      <div style="font-size: 1.1em; font-weight: 600; color: #667eea;">{avgPerWeek}</div>
                      <div style="font-size: 0.75em; color: #888;">Avg/wk</div>
                    </div>
                    {#if hasGoal}
                      <div style="text-align: center; padding-top: 5px;">
                        <div style="font-size: 0.85em; font-weight: 500; color: #777;">{formatAdherenceNum(expectedByNow)}</div>
                        <div style="font-size: 0.7em; color: #aaa;">Exp. by now</div>
                      </div>
                      <div style="text-align: center; padding-top: 5px;">
                        <div style="font-size: 0.85em; font-weight: 500; color: #777;">{formatAdherenceNum(cycle.workoutsPerWeekTarget)}/wk</div>
                        <div style="font-size: 0.7em; color: #aaa;">Goal/wk</div>
                      </div>
                    {/if}
                  </div>
                  <button
                    onclick={() => goto(`/programs/${cycle.programId}`)}
                    style="padding: 6px 12px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 0.85em; white-space: nowrap;"
                  >
                    Open Program
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Past Program Cycles -->
    <div style="margin-bottom: 20px;">
      <h3 style="margin: 0 0 12px 0; font-size: 1em; color: #333;">Past Program Cycles</h3>
      {#if pastCycles.length === 0 && clientLegacyPrograms.length === 0}
        <p style="color: #888; font-size: 0.9em; padding: 15px; background: #f9f9f9; border-radius: 8px; margin: 0;">No past cycles.</p>
      {:else}
        <div style="display: flex; flex-direction: column; gap: 10px;">
          {#each pastCycles as cycle}
            {@const sessionCount = getCycleSessionCount(cycle, false)}
            {@const avgPerWeek = getCycleAvgPerWeek(cycle, false)}
            {@const effectiveEnd = getEffectiveEndDate(cycle)}
            <div style="background: white; border: 1px solid #ddd; border-radius: 8px; padding: 12px 15px;">
              <div style="display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: 8px;">
                <div style="flex: 1; min-width: 150px;">
                  <strong style="font-size: 0.95em; color: #333;">{cycle.programNameSnapshot || 'Unknown Program'}</strong>
                  <div style="margin-top: 4px; font-size: 0.85em; color: #666;">
                    Ended {formatCycleDate(effectiveEnd)}
                  </div>
                </div>
                <div style="display: flex; gap: 15px; align-items: center; flex-wrap: wrap;">
                  <div style="text-align: center; min-width: 50px;">
                    <div style="font-size: 1.1em; font-weight: 600; color: #333;">{sessionCount}</div>
                    <div style="font-size: 0.75em; color: #888;">Sessions</div>
                  </div>
                  <div style="text-align: center; min-width: 50px;">
                    <div style="font-size: 1.1em; font-weight: 600; color: #667eea;">{avgPerWeek}</div>
                    <div style="font-size: 0.75em; color: #888;">Avg/wk</div>
                  </div>
                  <div style="text-align: center; min-width: 60px;">
                    <div style="font-size: 0.85em; font-weight: 500; color: {getCycleStatusColor(cycle)};">{getCycleStatusLabel(cycle)}</div>
                    <div style="font-size: 0.75em; color: #888;">Status</div>
                  </div>
                  <button
                    onclick={() => goto(`/programs/${cycle.programId}`)}
                    style="padding: 6px 12px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 0.85em;"
                  >
                    Open Program
                  </button>
                </div>
              </div>
            </div>
          {/each}

          {#each clientLegacyPrograms as program}
            {@const sessionCount = getLegacySessionCount(program.id)}
            <div style="background: white; border: 1px solid #ddd; border-radius: 8px; padding: 12px 15px;">
              <div style="display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: 8px;">
                <div style="flex: 1; min-width: 150px;">
                  <strong style="font-size: 0.95em; color: #333;">{program.name || 'Unknown Program'}</strong>
                  <div style="margin-top: 4px; font-size: 0.85em; color: #888;">Legacy program</div>
                </div>
                <div style="display: flex; gap: 15px; align-items: center; flex-wrap: wrap;">
                  <div style="text-align: center; min-width: 50px;">
                    <div style="font-size: 1.1em; font-weight: 600; color: #333;">{sessionCount}</div>
                    <div style="font-size: 0.75em; color: #888;">Sessions</div>
                  </div>
                  <button
                    onclick={() => goto(`/programs/${program.id}`)}
                    style="padding: 6px 12px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 0.85em;"
                  >
                    Open Program
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else if selectedUserId && cyclesLoading}
    <p style="color: #888; font-size: 0.9em; margin-bottom: 20px;">Loading cycles...</p>
  {/if}

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
