<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, addDoc, onSnapshot, deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

  let exercises = $state([]);
  let userRole = $state(null);

  // New exercise form
  let newName = $state('');
  let newType = $state('Compound');
  let customType = $state('');
  let newNotes = $state('');

  // Filter/sort
  let sortBy = $state('alphabetical');
  let filterType = $state('all');

  // Default types + custom types from Firebase
  const defaultTypes = ['Compound', 'Isolation', 'Warm-up', 'Stretch', 'Cardio', 'Mobility', 'Core'];
  let customTypes = $state([]);

  // Combined list for dropdowns (computed)
  function getAllTypes() {
    return [...defaultTypes, ...customTypes, 'Other'];
  }

  // Filtered and sorted exercises (computed)
  function getFilteredExercises() {
    let result = [...exercises];

    // Filter by type
    if (filterType !== 'all') {
      result = result.filter(e => e.type === filterType);
    }

    // Sort
    if (sortBy === 'alphabetical') {
      result.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sortBy === 'date') {
      result.sort((a, b) => {
        const dateA = a.createdAt?.toDate?.() || new Date(0);
        const dateB = b.createdAt?.toDate?.() || new Date(0);
        return dateB - dateA;
      });
    } else if (sortBy === 'type') {
      result.sort((a, b) => (a.type || '').localeCompare(b.type || ''));
    }

    return result;
  }

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        const userDoc = await getDoc(doc(db, 'user', user.uid));
        if (userDoc.exists()) {
          userRole = userDoc.data().role;
        }
      } else {
        userRole = null;
      }
    });

    // Load exercises
    onSnapshot(collection(db, 'exercises'), (snapshot) => {
      exercises = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    });

    // Load custom types
    onSnapshot(doc(db, 'settings', 'exerciseTypes'), (snapshot) => {
      if (snapshot.exists()) {
        customTypes = snapshot.data().types || [];
      }
    });
  });

  async function saveCustomType(typeName) {
    if (!typeName.trim()) return;
    if (defaultTypes.includes(typeName) || customTypes.includes(typeName)) return;

    const newTypes = [...customTypes, typeName];
    await setDoc(doc(db, 'settings', 'exerciseTypes'), { types: newTypes });
  }

  async function createExercise(e) {
    e.preventDefault();
    if (!newName.trim()) return;

    // Determine final type
    let finalType = newType;
    if (newType === 'Other' && customType.trim()) {
      finalType = customType.trim();
      await saveCustomType(finalType);
    }

    await addDoc(collection(db, 'exercises'), {
      name: newName,
      type: finalType,
      notes: newNotes,
      createdAt: new Date()
    });

    // Reset form
    newName = '';
    newType = 'Compound';
    customType = '';
    newNotes = '';
  }

  async function deleteExercise(id) {
    if (confirm('Delete this exercise?')) {
      await deleteDoc(doc(db, 'exercises', id));
    }
  }
</script>

<h1>Exercise Library</h1>

{#if userRole === 'admin'}
  <h2>Create Exercise</h2>
  <form onsubmit={createExercise}>
    <div style="margin-bottom: 10px;">
      <input type="text" bind:value={newName} placeholder="Exercise name (e.g. Back Squat)" style="width: 100%; padding: 8px;" />
    </div>

    <div style="margin-bottom: 10px;">
      <label>
        Type:
        <select bind:value={newType} style="padding: 8px;">
          {#each getAllTypes() as type}
            <option value={type}>{type}</option>
          {/each}
        </select>
      </label>
    </div>

    {#if newType === 'Other'}
      <div style="margin-bottom: 10px;">
        <input
          type="text"
          bind:value={customType}
          placeholder="Enter new type name"
          style="width: 100%; padding: 8px;"
        />
      </div>
    {/if}

    <div style="margin-bottom: 10px;">
      <textarea bind:value={newNotes} placeholder="Notes/cues (optional)" style="width: 100%; padding: 8px;"></textarea>
    </div>

    <button type="submit">Create Exercise</button>
  </form>
{/if}

<h2>All Exercises</h2>

<div style="margin-bottom: 15px;">
  <label>
    Sort by:
    <select bind:value={sortBy} style="padding: 5px;">
      <option value="alphabetical">A-Z</option>
      <option value="date">Newest</option>
      <option value="type">Type</option>
    </select>
  </label>

  <label style="margin-left: 15px;">
    Filter:
    <select bind:value={filterType} style="padding: 5px;">
      <option value="all">All Types</option>
      {#each getAllTypes().filter(t => t !== 'Other') as type}
        <option value={type}>{type}</option>
      {/each}
    </select>
  </label>
</div>

{#if getFilteredExercises().length === 0}
  <p>No exercises found.</p>
{:else}
  {#each getFilteredExercises() as exercise}
    <div style="border: 1px solid #ccc; padding: 10px; margin: 10px 0;">
      <strong>{exercise.name}</strong>
      <span style="background: #eee; padding: 2px 6px; border-radius: 3px; margin-left: 10px; font-size: 0.8em;">{exercise.type}</span>
      {#if exercise.notes}<br /><em>{exercise.notes}</em>{/if}
      {#if userRole === 'admin'}
        <br />
        <button onclick={() => deleteExercise(exercise.id)}>Delete</button>
      {/if}
    </div>
  {/each}
{/if}

<nav>
  <a href="/">← Home</a>
</nav>
