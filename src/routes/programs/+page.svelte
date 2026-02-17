<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, addDoc, onSnapshot, deleteDoc, doc, getDoc, query, where } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

  let programs = $state([]);
  let newProgramName = $state('');
  let newProgramDescription = $state('');
  let userRole = $state(null);
  let currentUserId = $state(null);
  let activeView = $state('my'); // 'my' (Perform Workout) or 'all' (Modify Programs)
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

  // Delete confirmation modal state
  let deleteConfirmProgram = $state(null);

  // Unsubscribe functions for listeners
  let unsubscribes = [];

  function getFilteredPrograms() {
    let filtered;
    if (activeView === 'my' || userRole === 'client') {
      // Clients see: programs assigned to them OR programs they created
      // Check both assignedToUids (canonical) and assignedTo (legacy) for display
      filtered = programs.filter(p =>
        p.assignedToUids?.includes(currentUserId) ||
        p.assignedTo?.includes?.(currentUserId) ||
        p.assignedTo === currentUserId ||
        (p.createdByRole === 'client' && p.createdByUserId === currentUserId)
      );
    } else {
      // Admin/Coach "All Programs": exclude client-created programs
      filtered = programs.filter(p => p.createdByRole !== 'client');
    }
    // Sort alphabetically for display
    return sortProgramsAlphabetically(filtered);
  }

  function getMyPrograms() {
    // Check both assignedToUids (canonical) and assignedTo (legacy)
    const filtered = programs.filter(p =>
      p.assignedToUids?.includes(currentUserId) ||
      p.assignedTo?.includes?.(currentUserId) ||
      p.assignedTo === currentUserId
    );
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
    <!-- View Tabs -->
    <div style="display: flex; gap: 0; margin-bottom: 20px; border-bottom: 2px solid #eee;">
      <button
        onclick={() => activeView = 'my'}
        style="flex: 1; padding: 12px; border: none; background: {activeView === 'my' ? 'white' : '#f5f5f5'}; cursor: pointer; font-weight: {activeView === 'my' ? 'bold' : 'normal'}; border-bottom: {activeView === 'my' ? '3px solid #4CAF50' : 'none'}; margin-bottom: -2px;"
      >
        Perform Workout ({getMyPrograms().length})
      </button>
      <button
        onclick={() => activeView = 'all'}
        style="flex: 1; padding: 12px; border: none; background: {activeView === 'all' ? 'white' : '#f5f5f5'}; cursor: pointer; font-weight: {activeView === 'all' ? 'bold' : 'normal'}; border-bottom: {activeView === 'all' ? '3px solid #2196F3' : 'none'}; margin-bottom: -2px;"
      >
        Modify Programs
      </button>
    </div>
  {/if}

  {#if (userRole === 'admin' || userRole === 'coach') && activeView === 'all'}
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

<h2>{activeView === 'my' || userRole === 'client' ? 'Your Programs' : 'All Programs'}</h2>
{#if getFilteredPrograms().length === 0}
  <p>{activeView === 'my' || userRole === 'client' ? 'No programs assigned to you yet.' : 'No programs created yet.'}</p>
{:else}
  {#each getFilteredPrograms() as program}
    {#if (userRole === 'admin' || userRole === 'coach') && activeView === 'all'}
      <!-- Admin/Coach edit view: fully clickable card -->
      <a href="/programs/{program.id}" class="program-card" style="display: block; text-decoration: none; color: inherit; border: 1px solid {program.isClientCopy ? '#2196F3' : '#ccc'}; padding: 15px; margin: 10px 0; border-radius: 5px; {program.isClientCopy ? 'border-left: 4px solid #2196F3;' : ''} background: white; position: relative;">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 1;">
            <strong style="font-size: 1.2em;">{program.name}</strong>
            {#if program.isClientCopy}
              <span style="background: #e3f2fd; color: #1976D2; padding: 2px 8px; border-radius: 10px; font-size: 0.75em;">Custom</span>
            {/if}
          </div>
          <button
            onclick={(e) => { e.preventDefault(); e.stopPropagation(); deleteProgram(program.id); }}
            style="background: none; border: none; color: #999; font-size: 1.2em; cursor: pointer; padding: 4px 8px; line-height: 1;"
            title="Delete program"
          >×</button>
        </div>
        {#if program.description}
          <p style="margin: 5px 0; color: #666;">{program.description}</p>
        {/if}
        <p style="margin: 5px 0; font-size: 0.9em; color: #888;">
          {countDays(program)} day{countDays(program) !== 1 ? 's' : ''}
          {#if program.assignedTo?.length > 0}
            • {program.assignedTo.length} assigned
          {/if}
        </p>
      </a>
    {:else}
      <!-- Client/My view: card with conditional edit/delete for self-made programs -->
      <div class="program-card" style="display: block; border: 1px solid {isOwnClientProgram(program) ? '#4CAF50' : program.isClientCopy ? '#2196F3' : '#ccc'}; padding: 15px; margin: 10px 0; border-radius: 5px; {isOwnClientProgram(program) ? 'border-left: 4px solid #4CAF50;' : program.isClientCopy ? 'border-left: 4px solid #2196F3;' : ''} background: white; position: relative;">
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
            <!-- Edit/Delete icons for client-owned programs -->
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
    {/if}
  {/each}
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
</style>
