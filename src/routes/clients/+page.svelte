<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, query, where, getDocs, doc, getDoc, limit as firestoreLimit } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

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

      workoutSessions = allSessions.slice(0, 10);
    } catch (e) {
      console.log('Could not load sessions:', e);
      workoutSessions = [];
      sessions7Days = 0;
      sessions7DaysPrev = 0;
      sessions30Days = 0;
      sessions30DaysPrev = 0;
    }
    sessionsLoading = false;
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
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
      <div
        style="background: white; border: 1px solid #ddd; border-radius: 10px; padding: 15px; margin-bottom: 12px; cursor: default; transition: all 0.2s;"
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
