<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, addDoc, onSnapshot, deleteDoc, doc, getDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

  let programs = $state([]);
  let newProgramName = $state('');
  let newProgramTheme = $state('');
  let userRole = $state(null);
  let currentUserId = $state(null);

  // Filter programs: admins see all, clients only see assigned
  let filteredPrograms = $derived(
    userRole === 'admin'
      ? programs
      : programs.filter(p => p.assignedTo?.includes(currentUserId))
  );

  onMount(() => {
    // Get user role
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUserId = user.uid;
        const userDoc = await getDoc(doc(db, 'user', user.uid));
        if (userDoc.exists()) {
          userRole = userDoc.data().role;
        }
      }
    });

    // Get programs
    onSnapshot(collection(db, 'programs'), (snapshot) => {
      programs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    });
  });

  async function createProgram(e) {
    e.preventDefault();
    if (!newProgramName.trim()) return;
    await addDoc(collection(db, 'programs'), {
      name: newProgramName,
      theme: newProgramTheme,
      exercises: [],
      assignedTo: [],
      createdAt: new Date()
    });
    newProgramName = '';
    newProgramTheme = '';
  }

  async function deleteProgram(id) {
    if (confirm('Delete this program?')) {
      await deleteDoc(doc(db, 'programs', id));
    }
  }
</script>

<h1>Programs</h1>

{#if userRole === 'admin'}
  <form onsubmit={createProgram}>
    <input type="text" bind:value={newProgramName} placeholder="Program name (e.g. 8th Mesocycle)" />
    <input type="text" bind:value={newProgramTheme} placeholder="Theme (e.g. Upper Power)" />
    <button type="submit">Create Program</button>
  </form>
{/if}

<h2>Your Programs</h2>
{#if filteredPrograms.length === 0}
  <p>No programs assigned to you yet.</p>
{:else}
  {#each filteredPrograms as program}
    <div style="border: 1px solid #ccc; padding: 10px; margin: 10px 0;">
      <strong>{program.name}</strong>
      {#if program.theme}
        <span>— {program.theme}</span>
      {/if}
      <br />
      {#if userRole === 'admin'}
        <a href="/programs/{program.id}">View / Edit</a>
        <button onclick={() => deleteProgram(program.id)}>Delete</button>
      {:else}
        <a href="/programs/{program.id}">View</a>
      {/if}
    </div>
  {/each}
{/if}

<nav>
  <a href="/">← Home</a>
</nav>
