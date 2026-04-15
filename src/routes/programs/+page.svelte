<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, addDoc, onSnapshot, deleteDoc, doc, getDoc, getDocs, query, where, updateDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount, tick } from 'svelte';
  import { beforeNavigate, afterNavigate } from '$app/navigation';
  import { listProgramCycles, normalizeExpiredCyclesIfNeeded, getEndOfDay } from '$lib/programCycleHelpers.js';

  let programs = $state([]);
  let newProgramName = $state('');
  let newProgramDescription = $state('');
  let userRole = $state(null);
  let currentUserId = $state(null);
  let loading = $state(true);
  let roleError = $state(null);

  // Toast notification state
  let toastMessage = $state('');
  let toastType = $state('error'); // 'error' or 'success'

  function showToast(message, type = 'error') {
    toastMessage = message;
    toastType = type;
    setTimeout(() => { toastMessage = ''; }, 6000);
  }

  // Client program creation state
  let clientNewProgramName = $state('');
  let clientNewProgramDescription = $state('');
  let showClientCreateForm = $state(false);

  // Client program cycle state (for current/archived grouping)
  let clientCycles = $state([]);
  let cyclesLoading = $state(false);
  let clientSessions = $state([]); // completed sessions for the logged-in client

  // Admin/coach program cycle state (for status indicators)
  let allProgramCycles = $state([]);
  let statusLoading = $state(false);

  // Section open/collapsed state — persisted to sessionStorage so navigating back restores it
  const SECTION_STATE_KEY = 'programs_section_state';
  let performOpen = $state(true);  // default: expanded
  let libraryOpen = $state(false); // default: collapsed
  let savedScrollY = $state(null); // null = nothing to restore

  // Capture fresh scrollY right before leaving this page
  beforeNavigate(() => {
    saveSectionState();
  });

  // afterNavigate fires after SvelteKit has applied its own scroll-to-top behavior.
  // Setting savedScrollY here means the $effect below will always run after that reset.
  afterNavigate(() => {
    try {
      const saved = sessionStorage.getItem(SECTION_STATE_KEY);
      if (saved) {
        const { scrollY } = JSON.parse(saved);
        if (typeof scrollY === 'number') savedScrollY = scrollY;
      }
    } catch {}
  });

  // Apply scroll once programs are in the DOM (loading = false).
  // By the time this fires, SvelteKit's scroll-to-top has already run (afterNavigate guarantee).
  $effect(() => {
    if (savedScrollY !== null && !loading) {
      const y = savedScrollY;
      savedScrollY = null;
      tick().then(() => window.scrollTo({ top: y, behavior: 'instant' }));
    }
  });

  function saveSectionState() {
    try {
      sessionStorage.setItem(SECTION_STATE_KEY, JSON.stringify({
        perform: performOpen,
        library: libraryOpen,
        scrollY: window.scrollY
      }));
    } catch {}
  }

  function handlePerformToggle(e) {
    performOpen = e.currentTarget.open;
    saveSectionState();
  }

  function handleLibraryToggle(e) {
    libraryOpen = e.currentTarget.open;
    saveSectionState();
  }

  // Derived: programs the logged-in admin/coach has any self-cycle on.
  // Computed reactively so it can be referenced directly in markup without {@const}.
  let myPerformablePrograms = $derived(
    (() => {
      const myProgramIds = new Set(
        allProgramCycles.filter(c => c.userId === currentUserId).map(c => c.programId)
      );
      return getFilteredPrograms().filter(p => myProgramIds.has(p.id));
    })()
  );

  // Delete confirmation modal state
  let deleteConfirmProgram = $state(null);

  // Rename program state
  let editingProgramId = $state(null);
  let editingProgramName = $state('');
  let renameError = $state('');

  // Unsubscribe functions for listeners
  let unsubscribes = [];

  function getFilteredPrograms() {
    let filtered;
    if (userRole === 'client') {
      // Clients see: programs assigned to them OR programs they created
      // Check both assignedToUids (canonical) and assignedTo (legacy) for display
      filtered = programs.filter(p =>
        p.assignedToUids?.includes(currentUserId) ||
        p.assignedTo?.includes?.(currentUserId) ||
        p.assignedTo === currentUserId ||
        (p.createdByRole === 'client' && p.createdByUserId === currentUserId)
      );
    } else {
      // Admin/Coach: all non-client-created programs
      filtered = programs.filter(p => p.createdByRole !== 'client');
    }
    // Sort alphabetically for display
    return sortProgramsAlphabetically(filtered);
  }

  // Check if program is client-owned by current user
  function isOwnClientProgram(program) {
    return program.createdByRole === 'client' && program.createdByUserId === currentUserId;
  }

  // Setup program listeners based on user role
  function setupProgramListeners(uid, role) {
    // Clean up any existing listeners
    unsubscribes.forEach(unsub => unsub());
    unsubscribes = [];

    if (role === 'client') {
      // TASK C: Split queries for clients - owned + assigned
      let ownedPrograms = [];
      let assignedPrograms = [];

      // Query 1: Programs owned by this client
      const ownedQuery = query(
        collection(db, 'programs'),
        where('createdByUserId', '==', uid)
      );

      // Query 2: Programs assigned to this client (uses canonical assignedToUids field)
      const assignedQuery = query(
        collection(db, 'programs'),
        where('assignedToUids', 'array-contains', uid)
      );

      const unsub1 = onSnapshot(ownedQuery,
        (snapshot) => {
          ownedPrograms = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
          // Merge and dedupe
          const merged = [...ownedPrograms, ...assignedPrograms];
          const uniqueMap = new Map(merged.map(p => [p.id, p]));
          programs = Array.from(uniqueMap.values());
          loading = false;
        },
        (error) => {
          console.error('OWNED_QUERY permission error:', error.code, error.message);
          showToast(`OWNED_QUERY permission error: ${error.code} - ${error.message}`);
          loading = false;
        }
      );

      const unsub2 = onSnapshot(assignedQuery,
        (snapshot) => {
          assignedPrograms = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
          // Merge and dedupe
          const merged = [...ownedPrograms, ...assignedPrograms];
          const uniqueMap = new Map(merged.map(p => [p.id, p]));
          programs = Array.from(uniqueMap.values());
          loading = false;
        },
        (error) => {
          console.error('ASSIGNED_QUERY permission error:', error.code, error.message);
          showToast(`ASSIGNED_QUERY permission error: ${error.code} - ${error.message}`);
          loading = false;
        }
      );

      unsubscribes.push(unsub1, unsub2);
    } else if (role === 'admin' || role === 'coach') {
      // Coach/Admin: can read all programs (unfiltered)
      const unsub = onSnapshot(collection(db, 'programs'),
        (snapshot) => {
          programs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
          loading = false;
        },
        (error) => {
          console.error('Firestore error (all programs):', error.code, error.message);
          showToast(`Permission error: ${error.code} - ${error.message}`);
          loading = false;
        }
      );
      unsubscribes.push(unsub);
    } else {
      // Unknown role - do not query, show error
      console.error('Unknown or missing role:', role);
      showToast(`Unable to load programs: unknown role "${role}"`);
      loading = false;
    }
  }

  onMount(() => {
    // Restore section state saved before last navigation away
    try {
      const saved = sessionStorage.getItem(SECTION_STATE_KEY);
      if (saved) {
        const { perform, library } = JSON.parse(saved);
        if (typeof perform === 'boolean') performOpen = perform;
        if (typeof library === 'boolean') libraryOpen = library;
      }
    } catch {}

    const authUnsub = onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUserId = user.uid;

        // TASK B: Fetch role BEFORE querying programs
        try {
          const userDoc = await getDoc(doc(db, 'user', user.uid));
          if (userDoc.exists()) {
            const role = userDoc.data().role;
            if (role) {
              userRole = role;
              roleError = null;
              // Now that role is confirmed, setup listeners
              setupProgramListeners(user.uid, role);
              // Load cycles for client program grouping
              if (role === 'client') {
                loadClientCycles(user.uid);
                loadClientSessions(user.uid);
              }
              // Load all cycles for admin/coach status indicators
              if (role === 'admin' || role === 'coach') {
                loadAllCycles();
              }
            } else {
              // Role field exists but is null/undefined
              roleError = 'User role not set. Please contact your coach.';
              showToast(roleError);
              loading = false;
            }
          } else {
            // User document doesn't exist
            roleError = 'User profile not found. Please contact support.';
            showToast(roleError);
            loading = false;
          }
        } catch (e) {
          console.error('Failed to fetch user role:', e.code, e.message);
          roleError = `Failed to load user profile: ${e.message}`;
          showToast(roleError);
          loading = false;
        }
      } else {
        // Not logged in
        currentUserId = null;
        userRole = null;
        programs = [];
        loading = false;
      }
    });

    // Cleanup on unmount
    return () => {
      authUnsub();
      unsubscribes.forEach(unsub => unsub());
    };
  });

  async function createProgram(e) {
    e.preventDefault();
    if (!newProgramName.trim()) return;
    try {
      await addDoc(collection(db, 'programs'), {
        name: newProgramName,
        description: newProgramDescription,
        days: [],
        assignedToUids: [], // Canonical field for queries
        assignedTo: [], // Backward compat
        createdAt: new Date()
      });
      newProgramName = '';
      newProgramDescription = '';
      showToast('Program created!', 'success');
    } catch (error) {
      console.error('Create program error:', error.code, error.message);
      showToast(`Failed to create program: ${error.code} - ${error.message}`);
    }
  }

  // TASK D: Client program creation with explicit ownership fields
  async function createClientProgram(e) {
    e.preventDefault();
    if (!clientNewProgramName.trim() || !currentUserId) return;

    // Log payload for debugging (TEMP)
    const payload = {
      name: clientNewProgramName,
      description: clientNewProgramDescription,
      days: [],
      publishedDays: [],
      assignedToUids: [currentUserId], // Canonical field for queries
      assignedTo: [currentUserId], // Backward compat
      createdByRole: 'client',
      createdByUserId: currentUserId,
      createdAt: new Date()
    };
    console.log('Client create program payload:', payload);

    try {
      await addDoc(collection(db, 'programs'), payload);
      clientNewProgramName = '';
      clientNewProgramDescription = '';
      showClientCreateForm = false;
      showToast('Program created!', 'success');
    } catch (error) {
      console.error('CREATE_PROGRAM permission error:', error.code, error.message);
      showToast(`CREATE_PROGRAM permission error: ${error.code} - ${error.message}`);
    }
  }

  async function deleteProgram(id) {
    if (confirm('Delete this program and all its days?')) {
      try {
        await deleteDoc(doc(db, 'programs', id));
        showToast('Program deleted', 'success');
      } catch (error) {
        console.error('Delete program error:', error.code, error.message);
        showToast(`Failed to delete program: ${error.code} - ${error.message}`);
      }
    }
  }

  // Delete with confirmation modal for client programs
  function confirmDeleteClientProgram(program) {
    deleteConfirmProgram = program;
  }

  async function executeDeleteClientProgram() {
    if (deleteConfirmProgram) {
      try {
        await deleteDoc(doc(db, 'programs', deleteConfirmProgram.id));
        deleteConfirmProgram = null;
        showToast('Program deleted', 'success');
      } catch (error) {
        console.error('Delete client program error:', error.code, error.message);
        showToast(`Failed to delete program: ${error.code} - ${error.message}`);
        deleteConfirmProgram = null;
      }
    }
  }

  function cancelDeleteClientProgram() {
    deleteConfirmProgram = null;
  }

  // Start editing a program name
  function startRenameProgram(program) {
    editingProgramId = program.id;
    editingProgramName = program.name || '';
    renameError = '';
  }

  // Cancel renaming
  function cancelRenameProgram() {
    editingProgramId = null;
    editingProgramName = '';
    renameError = '';
  }

  // Save renamed program
  async function saveRenameProgram(program) {
    const newName = editingProgramName.trim();

    // Validate
    if (!newName) {
      renameError = 'Name cannot be empty';
      return;
    }

    // No change - just exit edit mode
    if (newName === (program.name || '').trim()) {
      cancelRenameProgram();
      return;
    }

    try {
      const programRef = doc(db, 'programs', program.id);
      await updateDoc(programRef, {
        name: newName,
        updatedAt: new Date()
      });
      cancelRenameProgram();
      showToast('Program renamed', 'success');
    } catch (error) {
      console.error('Rename program error:', error.code, error.message);
      showToast(`Failed to rename: ${error.code} - ${error.message}`);
    }
  }

  function countDays(program) {
    return program.days?.length || 0;
  }

  // Sort programs alphabetically by name (case-insensitive, empty names last)
  function sortProgramsAlphabetically(programList) {
    return [...programList].sort((a, b) => {
      const nameA = (a.name || '').trim().toLowerCase();
      const nameB = (b.name || '').trim().toLowerCase();
      // Empty names go last
      if (!nameA && !nameB) return 0;
      if (!nameA) return 1;
      if (!nameB) return -1;
      return nameA.localeCompare(nameB);
    });
  }

  // =============================================================================
  // Client cycle helpers (for current/archived grouping on the client Programs page)
  // =============================================================================

  async function loadClientCycles(uid) {
    cyclesLoading = true;
    try {
      const cycles = await listProgramCycles(uid);
      const normalized = await normalizeExpiredCyclesIfNeeded(uid, cycles);
      clientCycles = normalized;
    } catch (e) {
      console.log('Could not load client cycles:', e);
      clientCycles = [];
    }
    cyclesLoading = false;
  }

  async function loadClientSessions(uid) {
    try {
      const snap = await getDocs(
        query(collection(db, 'workoutSessions'), where('userId', '==', uid))
      );
      clientSessions = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.finishedAt);
    } catch (e) {
      clientSessions = [];
    }
  }

  function isEffectivelyActive(cycle) {
    if (cycle.status !== 'active') return false;
    const now = new Date();
    const endsAt = cycle.endsAt?.toDate ? cycle.endsAt.toDate() : new Date(cycle.endsAt);
    return now <= getEndOfDay(endsAt);
  }

  // Programs where the client has at least one effectively active cycle
  function getClientCurrentPrograms() {
    const activeProgramIds = new Set(
      clientCycles.filter(isEffectivelyActive).map(c => c.programId)
    );
    return getFilteredPrograms().filter(p => activeProgramIds.has(p.id));
  }

  // All client-visible programs that are NOT in current
  function getClientArchivedPrograms() {
    const activeProgramIds = new Set(
      clientCycles.filter(isEffectivelyActive).map(c => c.programId)
    );
    return getFilteredPrograms().filter(p => !activeProgramIds.has(p.id));
  }

  // =============================================================================
  // Client-facing adherence helpers (Current Cycle Programs cards)
  // =============================================================================

  // Find the effectively active cycle for a given programId
  function getActiveCycleForProgram(programId) {
    return clientCycles.find(c => c.programId === programId && isEffectivelyActive(c)) || null;
  }

  // Count completed sessions within the cycle window (same logic as dashboard)
  function getClientCycleSessionCount(cycle) {
    const startedAt = cycle.startedAt?.toDate ? cycle.startedAt.toDate() : new Date(cycle.startedAt);
    const now = new Date();
    return clientSessions.filter(s => {
      if (s.programId !== cycle.programId) return false;
      const sessionDate = s.finishedAt.toDate ? s.finishedAt.toDate() : new Date(s.finishedAt);
      return sessionDate >= startedAt && sessionDate <= now;
    }).length;
  }

  // Expected sessions completed by now (same formula as dashboard getCycleExpectedByNow)
  function getClientExpectedByNow(cycle) {
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

  // Same thresholds as dashboard, mapped to client-facing labels
  function getClientAdherenceStatus(sessionCount, expectedByNow) {
    if (expectedByNow === null) return null;
    const diff = sessionCount - expectedByNow;
    if (diff > 0.5) return 'Ahead';
    if (diff >= -0.5) return 'On Track';
    if (diff >= -1.5) return 'A Little Behind';
    return 'Needs Attention';
  }

  function getAdherenceHelperText(status) {
    switch (status) {
      case 'Ahead':           return "You're ahead of pace.";
      case 'On Track':        return 'Keep your current pace.';
      case 'A Little Behind': return 'One more session this week would help.';
      case 'Needs Attention': return "Let's work back toward your weekly goal.";
      default: return '';
    }
  }

  // Compact number formatting: integers without .0, else 1 decimal
  function formatAdherenceNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const rounded = Math.round(n * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  function clientChipStyle(status) {
    switch (status) {
      case 'Ahead':           return 'background:#dcfce7;color:#15803d;';
      case 'On Track':        return 'background:#dbeafe;color:#1565c0;';
      case 'A Little Behind': return 'background:#fff3e0;color:#e65100;';
      case 'Needs Attention': return 'background:#ffebee;color:#c62828;';
      default:                return 'background:#f3f4f6;color:#6b7280;';
    }
  }

  // =============================================================================
  // Admin/Coach status indicator helpers
  // =============================================================================

  async function loadAllCycles() {
    statusLoading = true;
    try {
      // Load every user's programCycles subcollection in parallel.
      // Admin already has read access to user documents and their subcollections
      // (same access the clients dashboard uses via listProgramCycles).
      // This avoids a collectionGroup query which requires additional Firestore rule config.
      const usersSnap = await getDocs(collection(db, 'user'));
      const userIds = usersSnap.docs.map(d => d.id);
      const cycleArrays = await Promise.all(
        userIds.map(uid => listProgramCycles(uid).catch(() => []))
      );
      allProgramCycles = cycleArrays.flat();
    } catch (e) {
      console.log('Could not load program cycles for status indicators:', e);
      allProgramCycles = [];
    }
    statusLoading = false;
  }

  // Primary status: current / archived / none — based on client cycle usage only.
  // The logged-in admin/coach's self cycles are intentionally excluded here;
  // they surface separately via isMineActive.
  function getPrimaryStatus(program) {
    const clientCycles = allProgramCycles.filter(
      c => c.programId === program.id && c.userId !== currentUserId
    );

    // Current: at least one client has an effectively active cycle
    if (clientCycles.some(isEffectivelyActive)) return 'current';

    // Archived: past client cycle history OR legacy assigned/no-cycle history
    const hasLegacyAssignment = (program.assignedToUids?.length > 0) ||
      (Array.isArray(program.assignedTo) ? program.assignedTo.length > 0 : !!program.assignedTo);
    if (clientCycles.length > 0 || hasLegacyAssignment) return 'archived';

    return 'none';
  }

  // Secondary "Mine" indicator: logged-in admin/coach has an active self-cycle on this program
  function isMineActive(programId) {
    return allProgramCycles.some(
      c => c.programId === programId && c.userId === currentUserId && isEffectivelyActive(c)
    );
  }

  // Programs the logged-in admin/coach has any self-cycle on (active or past)
  function getMyPerformablePrograms() {
    const myProgramIds = new Set(
      allProgramCycles
        .filter(c => c.userId === currentUserId)
        .map(c => c.programId)
    );
    return getFilteredPrograms().filter(p => myProgramIds.has(p.id));
  }

  // Self-cycle status for the "Programs I Can Perform" section
  // 'current' = has an effectively active self-cycle
  // 'archived' = has self-cycles but none are currently active
  function getMySelfStatus(programId) {
    const selfCycles = allProgramCycles.filter(
      c => c.programId === programId && c.userId === currentUserId
    );
    if (selfCycles.length === 0) return 'none';
    if (selfCycles.some(isEffectivelyActive)) return 'current';
    return 'archived';
  }
</script>

<h1>Programs</h1>

{#if loading}
  <p style="color: #888; text-align: center; padding: 40px 0;">Loading programs...</p>
{:else if roleError}
  <div style="background: #ffebee; border: 1px solid #f44336; color: #c62828; padding: 15px; border-radius: 8px; margin: 20px 0;">
    <strong>Error:</strong> {roleError}
  </div>
{:else}
  {#if userRole === 'admin' || userRole === 'coach'}
  <h2>Create Program</h2>
  <form onsubmit={createProgram} style="margin-bottom: 20px;">
    <div style="margin-bottom: 10px;">
      <input type="text" bind:value={newProgramName} placeholder="Program name (e.g. 8-Week Strength)" style="width: 100%; padding: 8px;" />
    </div>
    <div style="margin-bottom: 10px;">
      <textarea bind:value={newProgramDescription} placeholder="Description (optional)" style="width: 100%; padding: 8px;"></textarea>
    </div>
    <button type="submit">Create Program</button>
  </form>
{/if}

{#if userRole === 'client'}
  <!-- Client two-section layout: Current Cycle Programs / Archived Programs -->
  {#if cyclesLoading}
    <p style="color: #888; text-align: center; padding: 20px 0;">Loading programs...</p>
  {:else}
    {@const currentPrograms = getClientCurrentPrograms()}
    {@const archivedPrograms = getClientArchivedPrograms()}

    <!-- Current Cycle Programs -->
    <h2 style="margin-bottom: 12px;">Current Cycle Programs</h2>
    {#if currentPrograms.length === 0}
      <p style="color: #888; padding: 15px; background: #f9f9f9; border-radius: 8px; margin-bottom: 12px;">No active programs right now.</p>
    {:else}
      {#each currentPrograms as program}
        {@const activeCycle = getActiveCycleForProgram(program.id)}
        <div class="program-card" style="display: block; border: 1px solid {isOwnClientProgram(program) ? '#4CAF50' : program.isClientCopy ? '#2196F3' : '#ccc'}; padding: 15px; margin: 10px 0; border-radius: 5px; {isOwnClientProgram(program) ? 'border-left: 4px solid #4CAF50;' : program.isClientCopy ? 'border-left: 4px solid #2196F3;' : ''} background: white; position: relative;">
          <div class="cycle-card-row" style="display: flex; align-items: flex-start; gap: 12px;">

            <!-- Left: title / status / helper / days -->
            <a href="/programs/{program.id}/days" style="flex: 1; text-decoration: none; color: inherit; cursor: pointer; min-width: 0;">
              {#if activeCycle}
                {@const sessionCount = getClientCycleSessionCount(activeCycle)}
                {@const expectedByNow = getClientExpectedByNow(activeCycle)}
                {@const hasGoal = activeCycle.workoutsPerWeekTarget != null}
                {@const adherenceStatus = hasGoal ? getClientAdherenceStatus(sessionCount, expectedByNow) : null}

                <!-- Title + status chip -->
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <strong style="font-size: 1.2em;">{program.name}</strong>
                  {#if isOwnClientProgram(program)}
                    <span style="background: #e8f5e9; color: #388E3C; padding: 2px 8px; border-radius: 10px; font-size: 0.75em;">Self-made</span>
                  {:else if program.isClientCopy}
                    <span style="background: #e3f2fd; color: #1976D2; padding: 2px 8px; border-radius: 10px; font-size: 0.75em;">Custom</span>
                  {/if}
                  {#if hasGoal && adherenceStatus}
                    <span style="padding: 2px 8px; border-radius: 10px; font-size: 0.72em; font-weight: 500; {clientChipStyle(adherenceStatus)}">{adherenceStatus}</span>
                  {/if}
                </div>

                {#if program.description}
                  <p style="margin: 4px 0 0 0; color: #666; font-size: 0.9em;">{program.description}</p>
                {/if}

                {#if hasGoal && adherenceStatus}
                  <!-- Helper message -->
                  <p style="margin: 4px 0 0 0; font-size: 0.82em; color: #777; font-style: italic;">{getAdherenceHelperText(adherenceStatus)}</p>
                {:else if !hasGoal}
                  <p style="margin: 4px 0 0 0; font-size: 0.78em; color: #bbb; font-style: italic;">No weekly goal set yet</p>
                {/if}

                <!-- Workouts available (lighter, secondary) -->
                <p style="margin: 5px 0 0 0; font-size: 0.88em; color: #aaa;">
                  {countDays(program)} Workout{countDays(program) !== 1 ? 's' : ''} available
                </p>
              {:else}
                <!-- No active cycle: original layout -->
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <strong style="font-size: 1.2em;">{program.name}</strong>
                  {#if isOwnClientProgram(program)}
                    <span style="background: #e8f5e9; color: #388E3C; padding: 2px 8px; border-radius: 10px; font-size: 0.75em;">Self-made</span>
                  {:else if program.isClientCopy}
                    <span style="background: #e3f2fd; color: #1976D2; padding: 2px 8px; border-radius: 10px; font-size: 0.75em;">Custom</span>
                  {/if}
                </div>
                {#if program.description}
                  <p style="margin: 5px 0; color: #666;">{program.description}</p>
                {/if}
                <p style="margin: 5px 0; font-size: 0.9em; color: #888;">
                  {countDays(program)} day{countDays(program) !== 1 ? 's' : ''}
                </p>
              {/if}
            </a>

            <!-- Right: metric scoreboard + edit/delete -->
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px; flex-shrink: 0;">
              {#if activeCycle}
                {@const sessionCount2 = getClientCycleSessionCount(activeCycle)}
                {@const expectedByNow2 = getClientExpectedByNow(activeCycle)}
                {@const hasGoal2 = activeCycle.workoutsPerWeekTarget != null}
                {#if hasGoal2}
                  <!-- Three-metric scoreboard -->
                  <div class="cycle-metrics" style="margin-top: 6px;">
                    <div style="font-size: 0.65em; font-weight: 500; color: #bbb; text-align: right; margin-bottom: 5px; letter-spacing: 0.02em;">Metrics This Cycle</div>
                    <div style="display: flex; gap: 14px; align-items: flex-end;">
                      <div style="text-align: center;">
                        <div style="font-size: 0.72em; font-weight: 600; color: #888; line-height: 1.2;">Goal</div>
                        <div style="font-size: 0.58em; color: #ccc; line-height: 1.1;">per week</div>
                        <div style="font-size: 1em; font-weight: 600; color: #444; line-height: 1.3; margin-top: 3px;">{formatAdherenceNum(activeCycle.workoutsPerWeekTarget)}</div>
                      </div>
                      <div style="text-align: center;">
                        <div style="font-size: 0.72em; font-weight: 600; color: #888; line-height: 1.2;">Expected</div>
                        <div style="font-size: 0.58em; color: #ccc; line-height: 1.1;">sessions</div>
                        <div style="font-size: 1em; font-weight: 600; color: #444; line-height: 1.3; margin-top: 3px;">{formatAdherenceNum(expectedByNow2)}</div>
                      </div>
                      <div style="text-align: center;">
                        <div style="font-size: 0.72em; font-weight: 600; color: #888; line-height: 1.2;">Completed</div>
                        <div style="font-size: 0.58em; color: #ccc; line-height: 1.1;">sessions</div>
                        <div style="font-size: 1em; font-weight: 600; color: #444; line-height: 1.3; margin-top: 3px;">{sessionCount2}</div>
                      </div>
                    </div>
                  </div>
                {/if}
              {/if}
              {#if isOwnClientProgram(program)}
                <div style="display: flex; gap: 6px; align-items: center;">
                  <a
                    href="/programs/{program.id}"
                    onclick={(e) => e.stopPropagation()}
                    style="background: none; border: none; color: #64B5F6; font-size: 1.1em; cursor: pointer; padding: 4px; line-height: 1; text-decoration: none;"
                    title="Edit program"
                  >✎</a>
                  <button
                    onclick={(e) => { e.preventDefault(); e.stopPropagation(); confirmDeleteClientProgram(program); }}
                    style="background: none; border: none; color: #ef5350; font-size: 1.1em; cursor: pointer; padding: 4px; line-height: 1;"
                    title="Delete program"
                  >✕</button>
                </div>
              {/if}
            </div>

          </div>
        </div>
      {/each}
    {/if}

    <!-- Archived Programs -->
    {#if archivedPrograms.length > 0}
      <h2 style="margin-top: 30px; margin-bottom: 12px; color: #888; font-size: 1.1em;">Archived Programs</h2>
      {#each archivedPrograms as program}
        <div class="program-card" style="display: block; border: 1px solid #e0e0e0; padding: 15px; margin: 10px 0; border-radius: 5px; background: #fafafa; position: relative; opacity: 0.75;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <a href="/programs/{program.id}/days" style="flex: 1; text-decoration: none; color: inherit; cursor: pointer;">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <strong style="font-size: 1.2em;">{program.name}</strong>
                {#if isOwnClientProgram(program)}
                  <span style="background: #e8f5e9; color: #388E3C; padding: 2px 8px; border-radius: 10px; font-size: 0.75em;">Self-made</span>
                {:else if program.isClientCopy}
                  <span style="background: #e3f2fd; color: #1976D2; padding: 2px 8px; border-radius: 10px; font-size: 0.75em;">Custom</span>
                {/if}
              </div>
              {#if program.description}
                <p style="margin: 5px 0; color: #666;">{program.description}</p>
              {/if}
              <p style="margin: 5px 0; font-size: 0.9em; color: #888;">
                {countDays(program)} day{countDays(program) !== 1 ? 's' : ''}
              </p>
            </a>
            {#if isOwnClientProgram(program)}
              <div style="display: flex; gap: 6px; align-items: center;">
                <a
                  href="/programs/{program.id}"
                  onclick={(e) => e.stopPropagation()}
                  style="background: none; border: none; color: #64B5F6; font-size: 1.1em; cursor: pointer; padding: 4px; line-height: 1; text-decoration: none;"
                  title="Edit program"
                >✎</a>
                <button
                  onclick={(e) => { e.preventDefault(); e.stopPropagation(); confirmDeleteClientProgram(program); }}
                  style="background: none; border: none; color: #ef5350; font-size: 1.1em; cursor: pointer; padding: 4px; line-height: 1;"
                  title="Delete program"
                >✕</button>
              </div>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  {/if}
{:else}
  <!-- Admin/Coach: two-section layout -->

  <!-- Section 1: Programs I Can Perform (expanded by default) -->
  <details open={performOpen} ontoggle={handlePerformToggle} style="margin-bottom: 24px;">
    <summary style="cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 2px solid #e0e0e0; margin-bottom: 14px; user-select: none;">
      <span style="font-size: 1.15em; font-weight: 600; color: #222;">Programs I Can Perform</span>
      <span style="font-size: 0.82em; color: #999; font-weight: 400;">{myPerformablePrograms.length} program{myPerformablePrograms.length !== 1 ? 's' : ''}</span>
    </summary>
    {#if myPerformablePrograms.length === 0}
      <p style="color: #aaa; font-size: 0.92em; padding: 10px 0;">No programs assigned to you yet. Use <em>All Programs</em> below to edit and assign yourself a cycle.</p>
    {:else}
      {#each myPerformablePrograms as program}
        {@const selfStatus = getMySelfStatus(program.id)}
        <a
          href="/programs/{program.id}/days"
          class="program-card"
          style="display: block; text-decoration: none; color: inherit; border: 1px solid {selfStatus === 'current' ? '#bbf7d0' : '#e5e7eb'}; padding: 12px 14px; margin: 8px 0; border-radius: 5px; background: {selfStatus === 'current' ? '#f0fdf4' : '#fafafa'};"
        >
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <strong style="font-size: 1.05em;">{program.name}</strong>
            {#if selfStatus === 'current'}
              <span style="background: #dcfce7; color: #15803d; padding: 2px 7px; border-radius: 10px; font-size: 0.72em; font-weight: 500;">Current</span>
            {:else}
              <span style="background: #f3f4f6; color: #6b7280; padding: 2px 7px; border-radius: 10px; font-size: 0.72em; font-weight: 500;">Archived</span>
            {/if}
          </div>
          {#if program.description}
            <p style="margin: 4px 0 0 0; color: #666; font-size: 0.87em;">{program.description}</p>
          {/if}
          <p style="margin: 3px 0 0 0; font-size: 0.8em; color: #999;">
            {countDays(program)} day{countDays(program) !== 1 ? 's' : ''}
          </p>
        </a>
      {/each}
    {/if}
  </details>

  <!-- Section 2: All Programs (collapsed by default) -->
  <details open={libraryOpen} ontoggle={handleLibraryToggle}>
    <summary style="cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 2px solid #e0e0e0; margin-bottom: 14px; user-select: none;">
      <span style="font-size: 1.15em; font-weight: 600; color: #222;">All Programs</span>
      <span style="font-size: 0.82em; color: #999; font-weight: 400;">{getFilteredPrograms().length} program{getFilteredPrograms().length !== 1 ? 's' : ''}</span>
    </summary>
    {#if getFilteredPrograms().length === 0}
      <p style="color: #888;">No programs created yet.</p>
    {:else}
      {#each getFilteredPrograms() as program}
        {@const primaryStatus = getPrimaryStatus(program)}
        {#if editingProgramId === program.id}
          <!-- Inline rename form -->
          <div class="program-card" style="border: 1px solid #2196F3; padding: 15px; margin: 10px 0; border-radius: 5px; background: #f5faff;">
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
              <input
                type="text"
                bind:value={editingProgramName}
                style="flex: 1; min-width: 150px; padding: 8px; border: 1px solid {renameError ? '#f44336' : '#ccc'}; border-radius: 4px; font-size: 1em;"
                placeholder="Program name"
                onkeydown={(e) => e.key === 'Enter' && saveRenameProgram(program)}
              />
              <button
                onclick={() => saveRenameProgram(program)}
                style="padding: 8px 16px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;"
              >Save</button>
              <button
                onclick={cancelRenameProgram}
                style="padding: 8px 16px; background: #f5f5f5; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;"
              >Cancel</button>
            </div>
            {#if renameError}
              <p style="margin: 8px 0 0 0; color: #f44336; font-size: 0.85em;">{renameError}</p>
            {/if}
          </div>
        {:else}
          <!-- Library card: Edit button, rename/delete, no Perform, no Mine chip -->
          <div class="program-card" style="border: 1px solid #ddd; padding: 14px 15px; margin: 10px 0; border-radius: 5px; background: white;">
            <div style="display: flex; justify-content: space-between; align-items: start; gap: 10px;">
              <div style="flex: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                  <strong style="font-size: 1.1em;">{program.name}</strong>
                  {#if primaryStatus === 'current'}
                    <span style="background: #dcfce7; color: #15803d; padding: 2px 7px; border-radius: 10px; font-size: 0.72em; font-weight: 500;">Current</span>
                  {:else if primaryStatus === 'archived'}
                    <span style="background: #f3f4f6; color: #6b7280; padding: 2px 7px; border-radius: 10px; font-size: 0.72em; font-weight: 500;">Archived</span>
                  {:else}
                    <span style="background: #f9fafb; color: #9ca3af; padding: 2px 7px; border-radius: 10px; font-size: 0.72em; border: 1px solid #e5e7eb;">No Active Cycle</span>
                  {/if}
                </div>
                {#if program.description}
                  <p style="margin: 4px 0 0 0; color: #666; font-size: 0.88em;">{program.description}</p>
                {/if}
                <p style="margin: 3px 0 0 0; font-size: 0.82em; color: #999;">
                  {countDays(program)} day{countDays(program) !== 1 ? 's' : ''}
                  {#if (program.assignedToUids?.length || 0) > 0}
                    · {program.assignedToUids.length} assigned
                  {:else if Array.isArray(program.assignedTo) && program.assignedTo.length > 0}
                    · {program.assignedTo.length} assigned
                  {/if}
                </p>
              </div>
              <!-- Utility actions: rename + delete -->
              <div style="display: flex; gap: 2px; align-items: center; flex-shrink: 0;">
                <button
                  onclick={() => startRenameProgram(program)}
                  style="background: none; border: none; color: #888; font-size: 0.9em; cursor: pointer; padding: 4px 7px; line-height: 1; border-radius: 4px;"
                  title="Rename program"
                >✎</button>
                <button
                  onclick={() => deleteProgram(program.id)}
                  style="background: none; border: none; color: #bbb; font-size: 1.1em; cursor: pointer; padding: 4px 7px; line-height: 1; border-radius: 4px;"
                  title="Delete program"
                >×</button>
              </div>
            </div>
            <div style="margin-top: 11px;">
              <a
                href="/programs/{program.id}"
                style="padding: 6px 14px; background: #f5f5f5; border: 1px solid #ddd; color: #444; text-decoration: none; border-radius: 4px; font-size: 0.87em;"
              >Edit</a>
            </div>
          </div>
        {/if}
      {/each}
    {/if}
  </details>
{/if}

<!-- Client Create Program Section -->
{#if userRole === 'client'}
  <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
    {#if !showClientCreateForm}
      <button
        onclick={() => showClientCreateForm = true}
        style="width: 100%; padding: 12px; background: #f5f5f5; border: 2px dashed #ccc; border-radius: 8px; color: #666; cursor: pointer; font-size: 1em;"
      >
        + Create Your Own Program
      </button>
    {:else}
      <div style="background: #fafafa; padding: 15px; border-radius: 8px; border: 1px solid #e0e0e0;">
        <h3 style="margin: 0 0 15px 0; font-size: 1.1em;">Create New Program</h3>
        <form onsubmit={createClientProgram}>
          <div style="margin-bottom: 10px;">
            <input
              type="text"
              bind:value={clientNewProgramName}
              placeholder="Program name"
              style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;"
            />
          </div>
          <div style="margin-bottom: 15px;">
            <textarea
              bind:value={clientNewProgramDescription}
              placeholder="Description (optional)"
              style="width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; min-height: 60px;"
            ></textarea>
          </div>
          <div style="display: flex; gap: 10px;">
            <button
              type="submit"
              style="flex: 1; padding: 10px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;"
            >Create</button>
            <button
              type="button"
              onclick={() => { showClientCreateForm = false; clientNewProgramName = ''; clientNewProgramDescription = ''; }}
              style="padding: 10px 20px; background: #f5f5f5; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;"
            >Cancel</button>
          </div>
        </form>
      </div>
    {/if}
  </div>
{/if}
{/if}

<!-- Delete Confirmation Modal -->
{#if deleteConfirmProgram}
  <div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;">
    <div style="background: white; padding: 25px; border-radius: 8px; max-width: 400px; width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <h3 style="margin: 0 0 15px 0; color: #d32f2f;">Delete Program?</h3>
      <p style="margin: 0 0 20px 0; color: #666;">
        Are you sure you want to delete <strong>"{deleteConfirmProgram.name}"</strong>?
      </p>
      <p style="margin: 0 0 20px 0; color: #f44336; font-size: 0.9em;">
        ⚠️ This program cannot be recovered once deleted.
      </p>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button
          onclick={cancelDeleteClientProgram}
          style="padding: 10px 20px; background: #f5f5f5; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;"
        >Cancel</button>
        <button
          onclick={executeDeleteClientProgram}
          style="padding: 10px 20px; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer;"
        >Delete</button>
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
  .program-card {
    transition: filter 0.15s ease;
  }
  .program-card:hover {
    filter: brightness(0.97);
  }
  .program-card:active {
    filter: brightness(0.94);
  }

  /* On narrow / portrait widths, wrap the card row so metrics drop below main content */
  @media (max-width: 480px) {
    .cycle-card-row {
      flex-wrap: wrap;
    }
    /* Right column (metrics + edit buttons) becomes full-width, left-aligned */
    .cycle-card-row > :last-child {
      width: 100%;
      align-items: flex-start;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #f0f0f0;
    }
    /* Umbrella header left-aligned on narrow */
    .cycle-metrics > div:first-child {
      text-align: left;
    }
  }
</style>
