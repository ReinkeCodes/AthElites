<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, query, where, getDocs, orderBy } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

  let currentUserId = $state(null);
  let workoutSessions = $state([]);
  let exercisePRs = $state({});
  let allLogs = $state([]);
  let loading = $state(true);
  let activeTab = $state('workouts'); // 'workouts' or 'prs'
  let selectedSession = $state(null);

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUserId = user.uid;
        await Promise.all([loadWorkoutSessions(), loadAllLogs()]);
      }
      loading = false;
    });
  });

  async function loadWorkoutSessions() {
    if (!currentUserId) return;

    try {
      const sessionsQuery = query(
        collection(db, 'workoutSessions'),
        where('userId', '==', currentUserId)
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
    if (!currentUserId) return;

    try {
      const logsQuery = query(
        collection(db, 'workoutLogs'),
        where('userId', '==', currentUserId)
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
    const sessionDate = session.finishedAt?.toDate ? session.finishedAt.toDate() : new Date(session.finishedAt);
    const startOfDay = new Date(sessionDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(sessionDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Filter logs for this session
    const sessionLogs = allLogs.filter(log => {
      const logDate = log.loggedAt?.toDate ? log.loggedAt.toDate() : new Date(log.loggedAt);
      return log.programId === session.programId &&
             log.dayName === session.dayName &&
             logDate >= startOfDay &&
             logDate <= endOfDay;
    });

    // Group by exercise (since each set is now a separate entry)
    const groupedByExercise = {};
    sessionLogs.forEach(log => {
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
</script>

<h1>Workout History</h1>

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
      <button onclick={() => selectedSession = null} style="margin-bottom: 15px; padding: 8px 16px; background: #f5f5f5; border: 1px solid #ddd; cursor: pointer; border-radius: 5px;">
        ← Back to all workouts
      </button>

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
          <strong style="font-size: 1.05em;">{exercise.exerciseName}</strong>
          <div style="margin-top: 8px;">
            {#each exercise.sets as set}
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; margin-bottom: 4px; background: #f8f9fa; border-radius: 5px; font-size: 0.9em;">
                <span style="font-weight: bold; color: #667eea; min-width: 35px;">Set {set.setNumber}</span>
                <span style="color: #333;">
                  <strong>{set.reps || '-'}</strong> {set.repsMetric === 'distance' ? '' : 'reps'} @ <strong>{set.weight || '-'}</strong> {set.weightMetric === 'time' ? '' : 'lbs'}
                  {#if set.rir} <span style="color: #888;">(RIR: {set.rir})</span>{/if}
                </span>
              </div>
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
            onclick={() => selectedSession = session}
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
        <div style="background: white; border: 1px solid #e0e0e0; border-radius: 10px; padding: 15px; margin-bottom: 12px; border-left: 4px solid #ff9800;">
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

<nav style="margin-top: 30px;">
  <a href="/">← Home</a>
</nav>
