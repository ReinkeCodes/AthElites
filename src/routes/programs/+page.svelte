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

  function getFilteredPrograms() {
    if (userRole === 'admin') {
      return programs;
    }
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

{#if userRole === 'admin'}
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

<h2>{userRole === 'admin' ? 'All Programs' : 'Your Programs'}</h2>
{#if getFilteredPrograms().length === 0}
  <p>{userRole === 'admin' ? 'No programs created yet.' : 'No programs assigned to you yet.'}</p>
{:else}
  {#each getFilteredPrograms() as program}
    <div style="border: 1px solid #ccc; padding: 15px; margin: 10px 0; border-radius: 5px;">
      <strong style="font-size: 1.2em;">{program.name}</strong>
      {#if program.description}
        <p style="margin: 5px 0; color: #666;">{program.description}</p>
      {/if}
      <p style="margin: 5px 0; font-size: 0.9em; color: #888;">
        {countDays(program)} day{countDays(program) !== 1 ? 's' : ''}
      </p>
      <div style="margin-top: 10px;">
        {#if userRole === 'admin'}
          <a href="/programs/{program.id}" style="margin-right: 10px;">Edit Program</a>
          <button onclick={() => deleteProgram(program.id)}>Delete</button>
        {:else}
          <a href="/programs/{program.id}/days">Start Workout</a>
        {/if}
      </div>
    </div>
  {/each}
{/if}

<nav style="margin-top: 20px;">
  <a href="/">← Home</a>
</nav>
