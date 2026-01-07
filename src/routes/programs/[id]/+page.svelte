<script>
  import { page } from '$app/stores';
  import { auth, db } from '$lib/firebase.js';
  import { doc, onSnapshot, updateDoc, getDoc, collection } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

  let program = $state(null);
  let newExercise = $state({ name: '', sets: '', reps: '', weight: '', notes: '' });
  let editingIndex = $state(null);
  let editExercise = $state({ name: '', sets: '', reps: '', weight: '', notes: '' });
  let userRole = $state(null);
  let clients = $state([]);

  onMount(() => {
    // Get user role
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        const userDoc = await getDoc(doc(db, 'user', user.uid));
        if (userDoc.exists()) {
          userRole = userDoc.data().role;
        }
      }
    });

    // Get program
    const programId = $page.params.id;
    onSnapshot(doc(db, 'programs', programId), (snapshot) => {
      if (snapshot.exists()) {
        program = { id: snapshot.id, ...snapshot.data() };
      }
    });

    // Get all clients (for admin to assign)
    onSnapshot(collection(db, 'user'), (snapshot) => {
      clients = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(u => u.role === 'client');
    });
  });

  async function addExercise(e) {
    e.preventDefault();
    if (!newExercise.name.trim()) return;
    const updatedExercises = [...(program.exercises || []), { ...newExercise }];
    await updateDoc(doc(db, 'programs', program.id), {
      exercises: updatedExercises
    });
    newExercise = { name: '', sets: '', reps: '', weight: '', notes: '' };
  }

  function startEdit(index) {
    editingIndex = index;
    editExercise = { ...program.exercises[index] };
  }

  function cancelEdit() {
    editingIndex = null;
    editExercise = { name: '', sets: '', reps: '', weight: '', notes: '' };
  }

  async function saveEdit() {
    const updatedExercises = [...program.exercises];
    updatedExercises[editingIndex] = { ...editExercise };
    await updateDoc(doc(db, 'programs', program.id), {
      exercises: updatedExercises
    });
    editingIndex = null;
    editExercise = { name: '', sets: '', reps: '', weight: '', notes: '' };
  }

  async function deleteExercise(index) {
    const updatedExercises = program.exercises.filter((_, i) => i !== index);
    await updateDoc(doc(db, 'programs', program.id), {
      exercises: updatedExercises
    });
  }

  async function toggleAssignment(clientId) {
    const currentAssigned = program.assignedTo || [];
    const newAssigned = currentAssigned.includes(clientId)
      ? currentAssigned.filter(id => id !== clientId)
      : [...currentAssigned, clientId];
    await updateDoc(doc(db, 'programs', program.id), {
      assignedTo: newAssigned
    });
  }
</script>

{#if program}
  <h1>{program.name}</h1>
  {#if program.theme}
    <p><em>{program.theme}</em></p>
  {/if}

  {#if userRole === 'admin'}
    <h2>Assign to Clients</h2>
    {#if clients.length === 0}
      <p>No clients yet. Have them sign up first.</p>
    {:else}
      {#each clients as client}
        <label style="display: block; margin: 5px 0;">
          <input
            type="checkbox"
            checked={program.assignedTo?.includes(client.id)}
            onchange={() => toggleAssignment(client.id)}
          />
          {client.email}
        </label>
      {/each}
    {/if}

    <h2>Add Exercise</h2>
    <form onsubmit={addExercise}>
      <input type="text" bind:value={newExercise.name} placeholder="Exercise name" />
      <input type="text" bind:value={newExercise.sets} placeholder="Sets" />
      <input type="text" bind:value={newExercise.reps} placeholder="Reps" />
      <input type="text" bind:value={newExercise.weight} placeholder="Weight" />
      <input type="text" bind:value={newExercise.notes} placeholder="Notes" />
      <button type="submit">Add</button>
    </form>
  {/if}

  <h2>Exercises</h2>
  {#if !program.exercises || program.exercises.length === 0}
    <p>No exercises yet.</p>
  {:else}
    {#each program.exercises as exercise, index}
      <div style="border: 1px solid #ccc; padding: 10px; margin: 10px 0;">
        {#if editingIndex === index && userRole === 'admin'}
          <input type="text" bind:value={editExercise.name} placeholder="Name" />
          <input type="text" bind:value={editExercise.sets} placeholder="Sets" />
          <input type="text" bind:value={editExercise.reps} placeholder="Reps" />
          <input type="text" bind:value={editExercise.weight} placeholder="Weight" />
          <input type="text" bind:value={editExercise.notes} placeholder="Notes" />
          <br />
          <button onclick={saveEdit}>Save</button>
          <button onclick={cancelEdit}>Cancel</button>
        {:else}
          <strong>{exercise.name}</strong><br />
          {exercise.sets} sets × {exercise.reps}
          {#if exercise.weight} @ {exercise.weight}{/if}
          {#if exercise.notes}<br /><em>{exercise.notes}</em>{/if}
          {#if userRole === 'admin'}
            <br />
            <button onclick={() => startEdit(index)}>Edit</button>
            <button onclick={() => deleteExercise(index)}>Delete</button>
          {/if}
        {/if}
      </div>
    {/each}
  {/if}
{:else}
  <p>Loading...</p>
{/if}

<nav>
  <a href="/programs">← Back to Programs</a>
</nav>
