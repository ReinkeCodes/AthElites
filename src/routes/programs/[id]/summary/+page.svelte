<script>
  import { page } from '$app/stores';
  import { auth, db } from '$lib/firebase.js';
  import { doc, onSnapshot, getDoc, collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

  let program = $state(null);
  let day = $state(null);
  let currentUserId = $state(null);
  let todaysLogs = $state([]);
  let duration = $state(0);

  onMount(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const dayIndex = parseInt(urlParams.get('day') || '0');
    duration = parseInt(urlParams.get('duration') || '0');

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUserId = user.uid;
        await loadTodaysLogs();
      }
    });

    const programId = $page.params.id;
    onSnapshot(doc(db, 'programs', programId), (snapshot) => {
      if (snapshot.exists()) {
        program = { id: snapshot.id, ...snapshot.data() };
        day = program.days?.[dayIndex];
      }
    });
  });

  async function loadTodaysLogs() {
    if (!currentUserId) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const logsQuery = query(
      collection(db, 'workoutLogs'),
      where('userId', '==', currentUserId),
      where('programId', '==', $page.params.id),
      orderBy('loggedAt', 'desc'),
      limit(50)
    );

    try {
      const snapshot = await getDocs(logsQuery);
      todaysLogs = snapshot.docs
        .map(d => d.data())
        .filter(log => {
          const logDate = log.loggedAt?.toDate ? log.loggedAt.toDate() : new Date(log.loggedAt);
          return logDate >= today;
        });
    } catch (e) {
      console.log('Could not load logs:', e);
    }
  }
</script>

<div style="text-align: center; padding: 20px;">
  <h1 style="color: #4CAF50;">Workout Complete!</h1>

  {#if program && day}
    <h2>{day.name}</h2>
    <p style="color: #666;">{program.name}</p>
  {/if}

  {#if duration > 0}
    <div style="background: #f5f5f5; padding: 20px; border-radius: 10px; margin: 20px auto; max-width: 300px;">
      <p style="font-size: 2em; margin: 0; font-weight: bold;">{duration}</p>
      <p style="margin: 5px 0 0 0; color: #666;">minutes</p>
    </div>
  {/if}

  <h3>Today's Summary</h3>

  {#if todaysLogs.length === 0}
    <p style="color: #888;">No exercises logged.</p>
  {:else}
    <div style="text-align: left; max-width: 500px; margin: 0 auto;">
      {#each todaysLogs as log}
        <div style="border-bottom: 1px solid #eee; padding: 10px 0;">
          <strong>{log.exerciseName}</strong>
          <div style="color: #666;">
            {log.sets} sets × {log.reps}
            {#if log.weight} @ {log.weight}{/if}
            {#if log.rir} (RIR: {log.rir}){/if}
          </div>
          {#if log.notes}
            <div style="color: #888; font-style: italic; font-size: 0.9em;">{log.notes}</div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<nav style="text-align: center; margin-top: 30px;">
  <a href="/" style="display: inline-block; padding: 12px 24px; background: #4CAF50; color: white; text-decoration: none; border-radius: 5px; margin-right: 10px;">
    Home
  </a>
  <a href="/programs" style="display: inline-block; padding: 12px 24px; background: #2196F3; color: white; text-decoration: none; border-radius: 5px;">
    Programs
  </a>
</nav>
