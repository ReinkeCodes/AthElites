<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, query, where, orderBy, limit, getDocs, getDoc, doc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

  let currentUser = $state(null);
  let userRole = $state(null);
  let recentSessions = $state([]);
  let assignedPrograms = $state([]);
  let loading = $state(true);

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      currentUser = user;
      if (user) {
        const userDoc = await getDoc(doc(db, 'user', user.uid));
        if (userDoc.exists()) {
          userRole = userDoc.data().role;
        }
        await loadRecentSessions();
        await loadAssignedPrograms();
      }
      loading = false;
    });
  });

  async function loadRecentSessions() {
    if (!currentUser) return;

    try {
      const sessionsQuery = query(
        collection(db, 'workoutSessions'),
        where('userId', '==', currentUser.uid),
        orderBy('finishedAt', 'desc'),
        limit(5)
      );
      const snapshot = await getDocs(sessionsQuery);
      recentSessions = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.log('Could not load sessions:', e);
    }
  }

  async function loadAssignedPrograms() {
    if (!currentUser) return;

    try {
      const programsSnapshot = await getDocs(collection(db, 'programs'));
      assignedPrograms = programsSnapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(p => p.assignedTo?.includes(currentUser.uid));
    } catch (e) {
      console.log('Could not load programs:', e);
    }
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString();
  }
</script>

<h1>AthElites</h1>

{#if loading}
  <p>Loading...</p>
{:else if !currentUser}
  <div style="text-align: center; padding: 40px 0;">
    <h2>Welcome to AthElites</h2>
    <p style="color: #666; margin-bottom: 20px;">Your personal training companion</p>
    <a href="/login" style="display: inline-block; padding: 12px 24px; background: #4CAF50; color: white; text-decoration: none; border-radius: 5px;">
      Login / Sign Up
    </a>
  </div>
{:else}
  <!-- Quick Actions -->
  <div style="display: grid; gap: 10px; margin-bottom: 30px;">
    {#if assignedPrograms.length > 0}
      <a href="/programs" style="display: block; padding: 20px; background: #4CAF50; color: white; text-decoration: none; border-radius: 8px; text-align: center;">
        <strong style="font-size: 1.2em;">Start Workout</strong>
        <p style="margin: 5px 0 0 0; opacity: 0.9;">{assignedPrograms.length} program{assignedPrograms.length !== 1 ? 's' : ''} available</p>
      </a>
    {:else if userRole === 'admin'}
      <a href="/programs" style="display: block; padding: 20px; background: #2196F3; color: white; text-decoration: none; border-radius: 8px; text-align: center;">
        <strong style="font-size: 1.2em;">Manage Programs</strong>
        <p style="margin: 5px 0 0 0; opacity: 0.9;">Create and assign workouts</p>
      </a>
      <a href="/exercises" style="display: block; padding: 20px; background: #ff9800; color: white; text-decoration: none; border-radius: 8px; text-align: center;">
        <strong style="font-size: 1.2em;">Exercise Library</strong>
        <p style="margin: 5px 0 0 0; opacity: 0.9;">Manage exercises</p>
      </a>
    {:else}
      <p style="color: #888; text-align: center; padding: 20px;">No programs assigned yet. Check back later!</p>
    {/if}
  </div>

  <!-- Recent Workouts -->
  <h2>Recent Workouts</h2>
  {#if recentSessions.length === 0}
    <p style="color: #888;">No workouts completed yet. Start your first workout!</p>
  {:else}
    <div style="display: grid; gap: 10px;">
      {#each recentSessions as session}
        <div style="border: 1px solid #ddd; padding: 15px; border-radius: 8px; background: #f9f9f9;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong>{session.dayName}</strong>
              <p style="margin: 3px 0 0 0; color: #666; font-size: 0.9em;">{session.programName}</p>
            </div>
            <div style="text-align: right;">
              <span style="color: #888; font-size: 0.85em;">{formatDate(session.finishedAt)}</span>
              {#if session.durationMinutes}
                <p style="margin: 3px 0 0 0; color: #666; font-size: 0.85em;">{session.durationMinutes} min</p>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/if}