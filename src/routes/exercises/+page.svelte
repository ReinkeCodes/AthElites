<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, addDoc, onSnapshot, deleteDoc, doc, getDoc, setDoc, updateDoc, getDocs } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

  let exercises = $state([]);
  let programs = $state([]);
  let userRole = $state(null);

  // New exercise form
  let newName = $state('');
  let newType = $state('Compound');
  let customType = $state('');
  let newNotes = $state('');

  // Edit mode
  let editingId = $state(null);
  let editName = $state('');
  let editType = $state('');
  let editCustomType = $state('');
  let editNotes = $state('');

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

    // Load programs (to check exercise usage)
    onSnapshot(collection(db, 'programs'), (snapshot) => {
      programs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    });

    // Load custom types
    onSnapshot(doc(db, 'settings', 'exerciseTypes'), (snapshot) => {
      if (snapshot.exists()) {
        customTypes = snapshot.data().types || [];
      }
    });
  });

  // Find which programs use a specific exercise
  function getProgramsUsingExercise(exerciseId) {
    const usingPrograms = [];
    for (const program of programs) {
      const days = program.days || [];
      for (const day of days) {
        for (const section of day.sections || []) {
          for (const exercise of section.exercises || []) {
            if (exercise.exerciseId === exerciseId) {
              usingPrograms.push(program.name);
              break;
            }
          }
          if (usingPrograms.includes(program.name)) break;
        }
        if (usingPrograms.includes(program.name)) break;
      }
    }
    return [...new Set(usingPrograms)]; // Remove duplicates
  }

  // Start editing an exercise
  function startEdit(exercise) {
    editingId = exercise.id;
    editName = exercise.name || '';
    editType = getAllTypes().includes(exercise.type) ? exercise.type : 'Other';
    editCustomType = getAllTypes().includes(exercise.type) ? '' : exercise.type;
    editNotes = exercise.notes || '';
  }

  // Cancel editing
  function cancelEdit() {
    editingId = null;
    editName = '';
    editType = '';
    editCustomType = '';
    editNotes = '';
  }

  // Save edited exercise
  async function saveEdit() {
    if (!editName.trim()) return;

    let finalType = editType;
    if (editType === 'Other' && editCustomType.trim()) {
      finalType = editCustomType.trim();
      await saveCustomType(finalType);
    }

    await updateDoc(doc(db, 'exercises', editingId), {
      name: editName,
      type: finalType,
      notes: editNotes
    });

    cancelEdit();
  }

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

  async function deleteExercise(exercise) {
    const usingPrograms = getProgramsUsingExercise(exercise.id);

    let confirmMessage = `Delete "${exercise.name}"?`;
    if (usingPrograms.length > 0) {
      confirmMessage = `⚠️ WARNING: "${exercise.name}" is currently used in:\n\n• ${usingPrograms.join('\n• ')}\n\nThe exercise will remain in these programs but be removed from the library.\n\nDelete anyway?`;
    }

    if (confirm(confirmMessage)) {
      await deleteDoc(doc(db, 'exercises', exercise.id));
    }
  }
</script>

<h1>Exercise Library</h1>

{#if userRole === 'admin' || userRole === 'coach'}
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
    <div style="border: 1px solid #ccc; padding: 15px; margin: 10px 0; border-radius: 8px;">
      {#if editingId === exercise.id}
        <!-- Edit mode -->
        <div style="display: grid; gap: 10px;">
          <input
            type="text"
            bind:value={editName}
            placeholder="Exercise name"
            style="padding: 8px; font-size: 1em;"
          />
          <div style="display: flex; gap: 10px; align-items: center;">
            <select bind:value={editType} style="padding: 8px; flex: 1;">
              {#each getAllTypes() as type}
                <option value={type}>{type}</option>
              {/each}
            </select>
            {#if editType === 'Other'}
              <input
                type="text"
                bind:value={editCustomType}
                placeholder="Custom type"
                style="padding: 8px; flex: 1;"
              />
            {/if}
          </div>
          <textarea
            bind:value={editNotes}
            placeholder="Notes/cues (optional)"
            style="padding: 8px;"
          ></textarea>
          <div style="display: flex; gap: 10px;">
            <button onclick={saveEdit} style="padding: 8px 16px; background: #4CAF50; color: white; border: none; cursor: pointer; border-radius: 4px;">
              Save
            </button>
            <button onclick={cancelEdit} style="padding: 8px 16px; background: #f5f5f5; border: 1px solid #ccc; cursor: pointer; border-radius: 4px;">
              Cancel
            </button>
          </div>
        </div>
      {:else}
        <!-- View mode -->
        {@const usingPrograms = getProgramsUsingExercise(exercise.id)}
        <div style="display: flex; justify-content: space-between; align-items: start;">
          <div>
            <strong style="font-size: 1.1em;">{exercise.name}</strong>
            <span style="background: #e3f2fd; color: #1976D2; padding: 3px 8px; border-radius: 12px; margin-left: 10px; font-size: 0.8em;">{exercise.type}</span>
            {#if exercise.notes}
              <p style="margin: 8px 0 0 0; color: #666; font-style: italic;">{exercise.notes}</p>
            {/if}
            {#if usingPrograms.length > 0}
              <p style="margin: 8px 0 0 0; font-size: 0.8em; color: #888;">
                Used in: {usingPrograms.join(', ')}
              </p>
            {/if}
          </div>
          {#if userRole === 'admin' || userRole === 'coach'}
            <div style="display: flex; gap: 8px;">
              <button
                onclick={() => startEdit(exercise)}
                style="padding: 6px 12px; background: #fff; border: 1px solid #2196F3; color: #2196F3; cursor: pointer; border-radius: 4px; font-size: 0.9em;"
              >
                Edit
              </button>
              {#if userRole === 'admin'}
                <button
                  onclick={() => deleteExercise(exercise)}
                  style="padding: 6px 12px; background: #fff; border: 1px solid #f44336; color: #f44336; cursor: pointer; border-radius: 4px; font-size: 0.9em;"
                >
                  Delete
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
{/if}

<nav>
  <a href="/">← Home</a>
</nav>
