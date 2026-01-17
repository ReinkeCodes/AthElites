<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, addDoc, onSnapshot, deleteDoc, doc, getDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

  let programs = $state([]);
  let newProgramName = $state('');
  let newProgramDescription = $state('');
  let userRole = $state(null);
  let currentUserId = $state(null);
  let activeView = $state('all'); // 'all' or 'my'

  function getFilteredPrograms() {
    if (activeView === 'my' || userRole === 'client') {
      return programs.filter(p => p.assignedTo?.includes(currentUserId));
    }
    return programs;
  }

  function getMyPrograms() {
    return programs.filter(p => p.assignedTo?.includes(currentUserId));
  }

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUserId = user.uid;
        const userDoc = await getDoc(doc(db, 'user', user.uid));
        if (userDoc.exists()) {
          userRole = userDoc.data().role;
        }
      }
    });

    onSnapshot(collection(db, 'programs'), (snapshot) => {
      programs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    });
  });

  async function createProgram(e) {
    e.preventDefault();
    if (!newProgramName.trim()) return;
    await addDoc(collection(db, 'programs'), {
      name: newProgramName,
      description: newProgramDescription,
      days: [],
      assignedTo: [],
      createdAt: new Date()
    });
    newProgramName = '';
    newProgramDescription = '';
  }

  async function deleteProgram(id) {
    if (confirm('Delete this program and all its days?')) {
      await deleteDoc(doc(db, 'programs', id));
    }
  }

  function countDays(program) {
    return program.days?.length || 0;
  }
</script>

<h1>Programs</h1>

{#if userRole === 'admin' || userRole === 'coach'}
  <!-- View Tabs -->
  <div style="display: flex; gap: 0; margin-bottom: 20px; border-bottom: 2px solid #eee;">
    <button
      onclick={() => activeView = 'all'}
      style="flex: 1; padding: 12px; border: none; background: {activeView === 'all' ? 'white' : '#f5f5f5'}; cursor: pointer; font-weight: {activeView === 'all' ? 'bold' : 'normal'}; border-bottom: {activeView === 'all' ? '3px solid #2196F3' : 'none'}; margin-bottom: -2px;"
    >
      All Programs
    </button>
    <button
      onclick={() => activeView = 'my'}
      style="flex: 1; padding: 12px; border: none; background: {activeView === 'my' ? 'white' : '#f5f5f5'}; cursor: pointer; font-weight: {activeView === 'my' ? 'bold' : 'normal'}; border-bottom: {activeView === 'my' ? '3px solid #4CAF50' : 'none'}; margin-bottom: -2px;"
    >
      My Programs ({getMyPrograms().length})
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
      <!-- Client/My view: fully clickable card -->
      <a href="/programs/{program.id}/days" class="program-card" style="display: block; text-decoration: none; color: inherit; border: 1px solid {program.isClientCopy ? '#2196F3' : '#ccc'}; padding: 15px; margin: 10px 0; border-radius: 5px; {program.isClientCopy ? 'border-left: 4px solid #2196F3;' : ''} background: white;">
        <div style="display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: 5px;">
          <strong style="font-size: 1.2em;">{program.name}</strong>
          {#if program.isClientCopy}
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
    {/if}
  {/each}
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
