<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, query, where, orderBy, limit, getDocs, getDoc, doc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { browser } from '$app/environment';
  import { isDraftStale, getDraftAgeText, isValidDayIndex, isDraftExpired } from '$lib/workoutDraft.js';

  let currentUser = $state(null);
  let userRole = $state(null);
  let recentSessions = $state([]);
  let assignedPrograms = $state([]);
  let loading = $state(true);

  // Toast notification state
  let toastMessage = $state('');
  let toastType = $state('error');

  // Active draft state
  let activeDraft = $state(null);
  let showDiscardConfirm = $state(false);
  let showContinueModal = $state(false);
  let expiredMessage = $state(''); // Brief message when draft auto-discarded

  function loadActiveDraft() {
    if (!browser || !currentUser) return;
    try {
      const key = `activeWorkoutDraft:${currentUser.uid}`;
      const raw = localStorage.getItem(key);
      if (raw) {
        activeDraft = JSON.parse(raw);
      } else {
        activeDraft = null;
      }
    } catch (e) {
      activeDraft = null;
    }
  }

  function clearActiveDraft() {
    if (!browser || !currentUser) return;
    localStorage.removeItem(`activeWorkoutDraft:${currentUser.uid}`);
    activeDraft = null;
    showDiscardConfirm = false;
    showContinueModal = false;
  }

  function handleContinueClick() {
    // Check if draft is expired (>14 days) - auto-discard without modal
    if (activeDraft && isDraftExpired(activeDraft)) {
      clearActiveDraft();
      expiredMessage = 'Your active workout expired after 14 days and was discarded.';
      setTimeout(() => { expiredMessage = ''; }, 5000);
      return;
    }
    // Not expired - show normal modal
    showContinueModal = true;
  }

  function handleContinueResume() {
    showContinueModal = false;
    if (activeDraft) {
      goto(`/programs/${activeDraft.programId}/workout/${activeDraft.dayIndex}`);
    }
  }

  function handleContinueDiscard() {
    clearActiveDraft();
    // Modal closes via clearActiveDraft, stay on Home
  }

  function getDraftLabel() {
    if (!activeDraft) return '';
    const programName = activeDraft.programName || 'Workout';
    const dayName = activeDraft.dayName || `Day ${(activeDraft.dayIndex || 0) + 1}`;
    return `${programName} — ${dayName}`;
  }

  function showToast(message, type = 'error') {
    toastMessage = message;
    toastType = type;
    setTimeout(() => { toastMessage = ''; }, 6000);
  }

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      currentUser = user;
      if (user) {
        // Resume last path on initial app load only (not on every Home click)
        if (browser && !sessionStorage.getItem('ael:resumed')) {
          sessionStorage.setItem('ael:resumed', '1');
          const lastPath = localStorage.getItem('ael:lastPath');
          if (lastPath && lastPath !== '/login' && lastPath !== '/') {
            goto(lastPath);
            return;
          }
        }
        try {
          const userDoc = await getDoc(doc(db, 'user', user.uid));
          if (userDoc.exists()) {
            userRole = userDoc.data().role;
          } else {
            console.error('User document not found');
            showToast('User profile not found. Please contact support.');
          }
        } catch (e) {
          console.error('Failed to fetch user role:', e.code, e.message);
          showToast(`Failed to load profile: ${e.message}`);
        }
        await loadRecentSessions();
        await loadAssignedPrograms();
        loadActiveDraft();
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
      console.error('Could not load sessions:', e.code, e.message);
      showToast(`Failed to load sessions: ${e.code} - ${e.message}`);
    }
  }

  async function loadAssignedPrograms() {
    if (!currentUser) return;

    try {
      // Use split queries based on role to avoid permission errors
      if (userRole === 'client') {
        // Client: query owned + assigned programs separately
        const ownedQuery = query(
          collection(db, 'programs'),
          where('createdByUserId', '==', currentUser.uid)
        );
        // Use canonical assignedToUids field for array-contains query
        const assignedQuery = query(
          collection(db, 'programs'),
          where('assignedToUids', 'array-contains', currentUser.uid)
        );

        const [ownedSnapshot, assignedSnapshot] = await Promise.all([
          getDocs(ownedQuery),
          getDocs(assignedQuery)
        ]);

        // Merge and dedupe
        const ownedPrograms = ownedSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        const assignedProgramsList = assignedSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        const merged = [...ownedPrograms, ...assignedProgramsList];
        const uniqueMap = new Map(merged.map(p => [p.id, p]));
        assignedPrograms = Array.from(uniqueMap.values());
      } else if (userRole === 'admin' || userRole === 'coach') {
        // Admin/Coach can query all programs
        const programsSnapshot = await getDocs(collection(db, 'programs'));
        assignedPrograms = programsSnapshot.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(p =>
            p.assignedToUids?.includes(currentUser.uid) ||
            p.assignedTo?.includes?.(currentUser.uid) ||
            p.assignedTo === currentUser.uid
          );
      } else {
        // Unknown role - don't query
        console.error('Unknown role, cannot load programs:', userRole);
        assignedPrograms = [];
      }
    } catch (e) {
      console.error('Could not load programs:', e.code, e.message);
      showToast(`Permission error: ${e.code} - ${e.message}`);
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
  <!-- Active Draft Buttons -->
  {#if activeDraft}
    <div style="display: grid; gap: 10px; margin-bottom: 20px; padding: 15px; background: #e3f2fd; border-radius: 10px; border: 2px solid #2196F3;">
      <p style="margin: 0 0 5px 0; color: #1565c0; font-weight: 500; font-size: 0.9em;">Unfinished workout: {getDraftLabel()}</p>
      <button onclick={handleContinueClick} style="display: block; width: 100%; padding: 15px; background: #2196F3; color: white; border: none; border-radius: 8px; text-align: center; font-weight: bold; cursor: pointer; font-size: 1em;">
        Continue active workout
      </button>
      <button onclick={() => showDiscardConfirm = true} style="padding: 10px; background: transparent; color: #d32f2f; border: 1px solid #d32f2f; border-radius: 6px; cursor: pointer; font-size: 0.9em;">
        Discard active session
      </button>
    </div>
  {/if}

  <!-- Expired Draft Message (shown briefly after auto-discard) -->
  {#if expiredMessage}
    <div style="margin-bottom: 20px; padding: 12px 15px; background: #fff3e0; border: 1px solid #ff9800; border-radius: 8px; color: #e65100; font-size: 0.9em;">
      {expiredMessage}
    </div>
  {/if}

  <!-- Quick Actions -->
  <div style="display: grid; gap: 10px; margin-bottom: 30px;">
    {#if assignedPrograms.length > 0}
      <a href="/programs" class="action-btn" style="display: block; padding: 20px; background: #4CAF50; color: white; text-decoration: none; border-radius: 8px; text-align: center;">
        <strong style="font-size: 1.2em;">Start Workout</strong>
        <p style="margin: 5px 0 0 0; opacity: 0.9;">{assignedPrograms.length} program{assignedPrograms.length !== 1 ? 's' : ''} available</p>
      </a>
    {:else if userRole === 'admin'}
      <a href="/programs" class="action-btn" style="display: block; padding: 20px; background: #2196F3; color: white; text-decoration: none; border-radius: 8px; text-align: center;">
        <strong style="font-size: 1.2em;">Manage Programs</strong>
        <p style="margin: 5px 0 0 0; opacity: 0.9;">Create and assign workouts</p>
      </a>
      <a href="/exercises" class="action-btn" style="display: block; padding: 20px; background: #ff9800; color: white; text-decoration: none; border-radius: 8px; text-align: center;">
        <strong style="font-size: 1.2em;">Exercise Library</strong>
        <p style="margin: 5px 0 0 0; opacity: 0.9;">Manage exercises</p>
      </a>
    {:else}
      <p style="color: #888; text-align: center; padding: 20px;">No programs assigned yet. Check back later!</p>
    {/if}
  </div>

  <!-- History & PRs -->
  <a href="/history" class="action-btn" style="display: block; padding: 15px; background: #f5f5f5; border-radius: 8px; text-align: center; text-decoration: none; color: #333; margin-bottom: 10px;">
    <strong>History & PRs</strong>
  </a>

  <!-- Profile -->
  <a href="/profile" class="action-btn" style="display: block; padding: 15px; background: #f5f5f5; border-radius: 8px; text-align: center; text-decoration: none; color: #333; margin-bottom: 20px;">
    <strong>Profile</strong>
  </a>

  <!-- Recent Workouts -->
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
    <h2 style="margin: 0;">Recent Workouts</h2>
    <a href="/history" style="font-size: 0.9em; color: #667eea;">View All</a>
  </div>
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

<!-- Continue Active Workout Modal (Resume/Discard choice) -->
{#if showContinueModal && activeDraft}
  {@const isStale = isDraftStale(activeDraft)}
  {@const ageText = getDraftAgeText(activeDraft)}
  {@const isCorrupted = !isValidDayIndex(activeDraft.dayIndex)}
  <div
    role="dialog"
    aria-modal="true"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2001;"
    onclick={(e) => { if (e.target === e.currentTarget) showContinueModal = false; }}
  >
    <div style="background: white; border-radius: 8px; padding: 20px; max-width: 90%; width: 340px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      {#if isCorrupted}
        <h3 style="margin: 0 0 12px 0; font-size: 1.1em; color: #d32f2f;">Corrupted workout draft</h3>
        <p style="margin: 0 0 20px 0; color: #666; font-size: 0.9em;">This active workout is missing its day reference and can't be resumed. Discard to start fresh.</p>
        <div style="display: flex; gap: 10px; justify-content: flex-end;">
          <button onclick={() => showContinueModal = false} style="padding: 8px 16px; background: #fff; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;">Cancel</button>
          <button onclick={handleContinueDiscard} style="padding: 8px 16px; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer;">Discard</button>
        </div>
      {:else}
        <h3 style="margin: 0 0 12px 0; font-size: 1.1em;">Pick up where you left off?</h3>
        <p style="margin: 0 0 {isStale ? '10px' : '20px'} 0; color: #666; font-size: 0.9em;">You have an unfinished workout: <strong>{getDraftLabel()}</strong>. Resume it, or discard to start fresh.</p>
        {#if isStale}
          <p style="margin: 0 0 20px 0; color: #e65100; font-size: 0.85em; background: #fff3e0; padding: 8px 12px; border-radius: 4px;">This workout is from {ageText} and may be out of date.</p>
        {/if}
        <div style="display: flex; gap: 10px; justify-content: flex-end;">
          <button onclick={handleContinueDiscard} style="padding: 8px 16px; background: {isStale ? '#d32f2f' : '#fff'}; color: {isStale ? 'white' : '#d32f2f'}; border: 1px solid #d32f2f; border-radius: 4px; cursor: pointer;">Discard</button>
          <button onclick={handleContinueResume} style="padding: 8px 16px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer;">Resume</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- Discard Confirmation Modal -->
{#if showDiscardConfirm}
  <div
    role="dialog"
    aria-modal="true"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2001;"
    onclick={(e) => { if (e.target === e.currentTarget) showDiscardConfirm = false; }}
  >
    <div style="background: white; border-radius: 8px; padding: 20px; max-width: 90%; width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <h3 style="margin: 0 0 12px 0; font-size: 1.1em;">Discard active workout?</h3>
      <p style="margin: 0 0 20px 0; color: #666; font-size: 0.9em;">This will permanently delete your unfinished workout on this device.</p>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button onclick={() => showDiscardConfirm = false} style="padding: 8px 16px; background: #fff; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;">Cancel</button>
        <button onclick={clearActiveDraft} style="padding: 8px 16px; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer;">Discard</button>
      </div>
    </div>
  </div>
{/if}

<!-- Toast notification -->
{#if toastMessage}
  <div style="position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: {toastType === 'error' ? '#f44336' : '#4CAF50'}; color: white; padding: 12px 24px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 2000; max-width: 90%; text-align: center;">
    {toastMessage}
  </div>
{/if}

<style>
  .action-btn {
    transition: filter 0.15s ease;
  }
  .action-btn:hover {
    filter: brightness(0.95);
  }
  .action-btn:active {
    filter: brightness(0.9);
  }
</style>