<script>
  import { page } from '$app/stores';
  import { auth, db } from '$lib/firebase.js';
  import { doc, onSnapshot, updateDoc, getDoc, collection } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let program = $state(null);
  let userRole = $state(null);
  let clients = $state([]);
  let exercises = $state([]);

  // Day management
  let newDayName = $state('');
  let editingDayIndex = $state(null);
  let editDayName = $state('');

  // Section management
  let expandedDay = $state(null);
  let newSectionName = $state('');
  let editingSectionIndex = $state(null);
  let editSectionName = $state('');

  // Exercise in section
  let addingExerciseToSection = $state(null);
  let selectedExerciseId = $state('');
  let exerciseDetails = $state({ sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [] });

  // Editing exercise in section
  let editingExercise = $state(null); // format: "dayIndex-sectionIndex-exerciseIndex"
  let editExerciseDetails = $state({ sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [] });

  // Drag and drop
  let draggedExercise = $state(null); // { dayIndex, sectionIndex, exerciseIndex, exercise }
  let dropTargetSection = $state(null); // "dayIndex-sectionIndex"

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        const userDoc = await getDoc(doc(db, 'user', user.uid));
        if (userDoc.exists()) {
          userRole = userDoc.data().role;
          if (userDoc.data().role !== 'admin') {
            goto(`/programs/${$page.params.id}/days`);
          }
        }
      }
    });

    const programId = $page.params.id;
    onSnapshot(doc(db, 'programs', programId), (snapshot) => {
      if (snapshot.exists()) {
        program = { id: snapshot.id, ...snapshot.data() };
      }
    });

    onSnapshot(collection(db, 'user'), (snapshot) => {
      clients = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(u => u.role === 'client');
    });

    onSnapshot(collection(db, 'exercises'), (snapshot) => {
      exercises = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    });
  });

  async function toggleAssignment(clientId) {
    const currentAssigned = program.assignedTo || [];
    const newAssigned = currentAssigned.includes(clientId)
      ? currentAssigned.filter(id => id !== clientId)
      : [...currentAssigned, clientId];
    await updateDoc(doc(db, 'programs', program.id), { assignedTo: newAssigned });
  }

  // Day functions
  async function addDay(e) {
    e.preventDefault();
    if (!newDayName.trim()) return;
    const newDay = { name: newDayName, sections: [] };
    await updateDoc(doc(db, 'programs', program.id), {
      days: [...(program.days || []), newDay]
    });
    newDayName = '';
  }

  async function deleteDay(dayIndex) {
    if (!confirm('Delete this day and all its exercises?')) return;
    const updatedDays = program.days.filter((_, i) => i !== dayIndex);
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
  }

  function startEditDay(dayIndex) {
    editingDayIndex = dayIndex;
    editDayName = program.days[dayIndex].name;
  }

  async function saveEditDay() {
    const updatedDays = [...program.days];
    updatedDays[editingDayIndex].name = editDayName;
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
    editingDayIndex = null;
    editDayName = '';
  }

  // Section functions
  async function addSection(dayIndex) {
    if (!newSectionName.trim()) return;
    const updatedDays = [...program.days];
    updatedDays[dayIndex].sections = [...(updatedDays[dayIndex].sections || []), { name: newSectionName, exercises: [] }];
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
    newSectionName = '';
  }

  async function deleteSection(dayIndex, sectionIndex) {
    if (!confirm('Delete this section?')) return;
    const updatedDays = [...program.days];
    updatedDays[dayIndex].sections = updatedDays[dayIndex].sections.filter((_, i) => i !== sectionIndex);
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
  }

  // Exercise in section functions
  async function addExerciseToSection(dayIndex, sectionIndex) {
    if (!selectedExerciseId) return;
    const exercise = exercises.find(e => e.id === selectedExerciseId);
    if (!exercise) return;

    const updatedDays = [...program.days];
    const exerciseEntry = {
      exerciseId: selectedExerciseId,
      name: exercise.name,
      type: exercise.type,
      sets: exerciseDetails.sets,
      reps: exerciseDetails.reps,
      weight: exerciseDetails.weight,
      rir: exerciseDetails.rir,
      notes: exerciseDetails.notes,
      customReqs: exerciseDetails.customReqs || []
    };
    updatedDays[dayIndex].sections[sectionIndex].exercises.push(exerciseEntry);
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });

    selectedExerciseId = '';
    exerciseDetails = { sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [] };
    addingExerciseToSection = null;
  }

  async function deleteExerciseFromSection(dayIndex, sectionIndex, exerciseIndex) {
    const updatedDays = [...program.days];
    updatedDays[dayIndex].sections[sectionIndex].exercises =
      updatedDays[dayIndex].sections[sectionIndex].exercises.filter((_, i) => i !== exerciseIndex);
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
  }

  function startEditExercise(dayIndex, sectionIndex, exerciseIndex) {
    const ex = program.days[dayIndex].sections[sectionIndex].exercises[exerciseIndex];
    editingExercise = `${dayIndex}-${sectionIndex}-${exerciseIndex}`;
    editExerciseDetails = {
      sets: ex.sets || '',
      reps: ex.reps || '',
      weight: ex.weight || '',
      rir: ex.rir || '',
      notes: ex.notes || '',
      customReqs: ex.customReqs ? [...ex.customReqs] : []
    };
  }

  function cancelEditExercise() {
    editingExercise = null;
    editExerciseDetails = { sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [] };
  }

  async function saveEditExercise(dayIndex, sectionIndex, exerciseIndex) {
    const updatedDays = [...program.days];
    const ex = updatedDays[dayIndex].sections[sectionIndex].exercises[exerciseIndex];
    ex.sets = editExerciseDetails.sets;
    ex.reps = editExerciseDetails.reps;
    ex.weight = editExerciseDetails.weight;
    ex.rir = editExerciseDetails.rir;
    ex.notes = editExerciseDetails.notes;
    ex.customReqs = editExerciseDetails.customReqs;
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
    editingExercise = null;
    editExerciseDetails = { sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [] };
  }

  // Custom requirements for adding new exercise
  function addCustomReq() {
    exerciseDetails.customReqs = [...exerciseDetails.customReqs, { name: '', value: '' }];
  }

  function removeCustomReq(index) {
    exerciseDetails.customReqs = exerciseDetails.customReqs.filter((_, i) => i !== index);
  }

  // Custom requirements for editing exercise
  function addEditCustomReq() {
    editExerciseDetails.customReqs = [...editExerciseDetails.customReqs, { name: '', value: '' }];
  }

  function removeEditCustomReq(index) {
    editExerciseDetails.customReqs = editExerciseDetails.customReqs.filter((_, i) => i !== index);
  }

  function getExercisesByType(type) {
    return exercises.filter(e => e.type === type);
  }

  function getAllExerciseTypes() {
    return [...new Set(exercises.map(e => e.type))].sort();
  }

  // Drag and drop functions
  function handleDragStart(e, dayIndex, sectionIndex, exerciseIndex) {
    const exercise = program.days[dayIndex].sections[sectionIndex].exercises[exerciseIndex];
    draggedExercise = { dayIndex, sectionIndex, exerciseIndex, exercise };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ''); // Required for Firefox
  }

  function handleDragOver(e, dayIndex, sectionIndex) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dropTargetSection = `${dayIndex}-${sectionIndex}`;
  }

  function handleDragLeave(e) {
    // Only clear if leaving the section entirely
    if (!e.currentTarget.contains(e.relatedTarget)) {
      dropTargetSection = null;
    }
  }

  function handleDragEnd() {
    draggedExercise = null;
    dropTargetSection = null;
  }

  async function handleDrop(e, targetDayIndex, targetSectionIndex) {
    e.preventDefault();
    if (!draggedExercise) return;

    const { dayIndex: sourceDayIndex, sectionIndex: sourceSectionIndex, exerciseIndex: sourceExerciseIndex, exercise } = draggedExercise;

    // Don't do anything if dropping in same section
    if (sourceDayIndex === targetDayIndex && sourceSectionIndex === targetSectionIndex) {
      draggedExercise = null;
      dropTargetSection = null;
      return;
    }

    const updatedDays = [...program.days];

    // Remove from source section
    updatedDays[sourceDayIndex].sections[sourceSectionIndex].exercises =
      updatedDays[sourceDayIndex].sections[sourceSectionIndex].exercises.filter((_, i) => i !== sourceExerciseIndex);

    // Add to target section
    updatedDays[targetDayIndex].sections[targetSectionIndex].exercises.push(exercise);

    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });

    draggedExercise = null;
    dropTargetSection = null;
  }
</script>

{#if program && userRole === 'admin'}
  <h1>{program.name}</h1>
  {#if program.description}
    <p style="color: #666;">{program.description}</p>
  {/if}

  <!-- Assign to Clients -->
  <details style="margin-bottom: 20px;">
    <summary style="cursor: pointer; font-weight: bold;">Assign to Clients ({program.assignedTo?.length || 0} assigned)</summary>
    <div style="padding: 10px; background: #f5f5f5; margin-top: 5px;">
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
    </div>
  </details>

  <!-- Add Day -->
  <h2>Days</h2>
  <form onsubmit={addDay} style="margin-bottom: 15px;">
    <input type="text" bind:value={newDayName} placeholder="Day name (e.g. Leg Day, Push A)" style="padding: 8px; margin-right: 5px;" />
    <button type="submit">Add Day</button>
  </form>

  <!-- Days List -->
  {#if !program.days || program.days.length === 0}
    <p>No days added yet. Add a day to get started.</p>
  {:else}
    {#each program.days as day, dayIndex}
      <div style="border: 2px solid #333; padding: 15px; margin: 15px 0; border-radius: 8px;">
        <!-- Day Header -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          {#if editingDayIndex === dayIndex}
            <input type="text" bind:value={editDayName} style="padding: 5px; font-size: 1.1em;" />
            <div>
              <button onclick={saveEditDay}>Save</button>
              <button onclick={() => editingDayIndex = null}>Cancel</button>
            </div>
          {:else}
            <h3 style="margin: 0;">{day.name}</h3>
            <div>
              <button onclick={() => expandedDay = expandedDay === dayIndex ? null : dayIndex}>
                {expandedDay === dayIndex ? 'Collapse' : 'Expand'}
              </button>
              <button onclick={() => startEditDay(dayIndex)}>Rename</button>
              <button onclick={() => deleteDay(dayIndex)}>Delete</button>
            </div>
          {/if}
        </div>

        <!-- Day Content (expanded) -->
        {#if expandedDay === dayIndex}
          <!-- Add Section -->
          <div style="margin: 10px 0; padding: 10px; background: #f0f0f0;">
            <input type="text" bind:value={newSectionName} placeholder="Section name (e.g. Warm-up, Main, Cool-down)" style="padding: 5px; margin-right: 5px;" />
            <button onclick={() => addSection(dayIndex)}>Add Section</button>
          </div>

          <!-- Sections -->
          {#if !day.sections || day.sections.length === 0}
            <p style="color: #888;">No sections yet. Add sections like "Warm-up", "Main", "Cool-down".</p>
          {:else}
            {#each day.sections as section, sectionIndex}
              <div
                style="border: 1px solid #ccc; padding: 10px; margin: 10px 0; background: {dropTargetSection === `${dayIndex}-${sectionIndex}` ? '#e3f2fd' : 'white'}; transition: background 0.2s; {dropTargetSection === `${dayIndex}-${sectionIndex}` ? 'border: 2px dashed #2196F3;' : ''}"
                ondragover={(e) => handleDragOver(e, dayIndex, sectionIndex)}
                ondragleave={handleDragLeave}
                ondrop={(e) => handleDrop(e, dayIndex, sectionIndex)}
              >
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <strong>{section.name}</strong>
                  <button onclick={() => deleteSection(dayIndex, sectionIndex)} style="font-size: 0.8em;">Remove Section</button>
                </div>

                <!-- Exercises in Section -->
                {#if section.exercises && section.exercises.length > 0}
                  {#each section.exercises as ex, exIndex}
                    <div
                      draggable="true"
                      ondragstart={(e) => handleDragStart(e, dayIndex, sectionIndex, exIndex)}
                      ondragend={handleDragEnd}
                      style="padding: 10px; margin: 5px 0; background: #f9f9f9; border-left: 3px solid #4CAF50; cursor: grab; {draggedExercise?.dayIndex === dayIndex && draggedExercise?.sectionIndex === sectionIndex && draggedExercise?.exerciseIndex === exIndex ? 'opacity: 0.5;' : ''}"
                    >
                      {#if editingExercise === `${dayIndex}-${sectionIndex}-${exIndex}`}
                        <!-- Edit Mode -->
                        <strong>{ex.name}</strong>
                        <span style="color: #888; font-size: 0.8em;">({ex.type})</span>
                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin: 10px 0;">
                          <input type="text" bind:value={editExerciseDetails.sets} placeholder="Sets" style="padding: 5px;" />
                          <input type="text" bind:value={editExerciseDetails.reps} placeholder="Reps" style="padding: 5px;" />
                          <input type="text" bind:value={editExerciseDetails.weight} placeholder="Weight" style="padding: 5px;" />
                        </div>
                        <div style="margin-bottom: 8px;">
                          <input type="text" bind:value={editExerciseDetails.rir} placeholder="RIR" style="padding: 5px; width: 100%;" />
                        </div>
                        <div style="margin-bottom: 8px;">
                          <input type="text" bind:value={editExerciseDetails.notes} placeholder="Notes" style="padding: 5px; width: 100%;" />
                        </div>

                        <!-- Custom Requirements -->
                        <div style="margin: 10px 0; padding: 10px; background: #fff3e0; border-radius: 5px;">
                          <strong style="font-size: 0.9em;">Custom Requirements:</strong>
                          {#each editExerciseDetails.customReqs as req, reqIndex}
                            <div style="display: flex; gap: 5px; margin-top: 5px;">
                              <input type="text" bind:value={editExerciseDetails.customReqs[reqIndex].name} placeholder="Category (e.g. Tempo)" style="flex: 1; padding: 5px;" />
                              <input type="text" bind:value={editExerciseDetails.customReqs[reqIndex].value} placeholder="Value (e.g. 3-1-2)" style="flex: 1; padding: 5px;" />
                              <button onclick={() => removeEditCustomReq(reqIndex)} style="padding: 5px 10px;">✕</button>
                            </div>
                          {/each}
                          <button onclick={addEditCustomReq} style="margin-top: 8px; font-size: 0.85em;">+ Add Requirement</button>
                        </div>

                        <div style="margin-top: 10px;">
                          <button onclick={() => saveEditExercise(dayIndex, sectionIndex, exIndex)}>Save</button>
                          <button onclick={cancelEditExercise}>Cancel</button>
                        </div>
                      {:else}
                        <!-- View Mode -->
                        <div style="display: flex; justify-content: space-between; align-items: start;">
                          <div style="display: flex; align-items: start; gap: 10px;">
                            <span style="color: #999; cursor: grab; font-size: 1.2em; user-select: none;" title="Drag to move">⋮⋮</span>
                            <div>
                              <strong>{ex.name}</strong>
                            <span style="color: #888; font-size: 0.8em;">({ex.type})</span>
                            <br />
                            {#if ex.sets}{ex.sets} sets{/if}
                            {#if ex.reps} × {ex.reps} reps{/if}
                            {#if ex.weight} @ {ex.weight}{/if}
                            {#if ex.rir} (RIR: {ex.rir}){/if}
                            {#if ex.notes}<br /><em style="color: #666;">{ex.notes}</em>{/if}
                            {#if ex.customReqs && ex.customReqs.length > 0}
                              <div style="margin-top: 5px;">
                                {#each ex.customReqs as req}
                                  {#if req.name && req.value}
                                    <span style="display: inline-block; background: #e3f2fd; padding: 2px 6px; border-radius: 3px; font-size: 0.8em; margin-right: 5px;">
                                      {req.name}: {req.value}
                                    </span>
                                  {/if}
                                {/each}
                              </div>
                            {/if}
                            </div>
                          </div>
                          <div style="display: flex; gap: 5px;">
                            <button onclick={() => startEditExercise(dayIndex, sectionIndex, exIndex)} style="font-size: 0.8em;">Edit</button>
                            <button onclick={() => deleteExerciseFromSection(dayIndex, sectionIndex, exIndex)} style="font-size: 0.8em;">Remove</button>
                          </div>
                        </div>
                      {/if}
                    </div>
                  {/each}
                {/if}

                <!-- Add Exercise to Section -->
                {#if addingExerciseToSection === `${dayIndex}-${sectionIndex}`}
                  <div style="margin-top: 10px; padding: 10px; background: #e8f5e9; border-radius: 5px;">
                    <div style="margin-bottom: 8px;">
                      <select bind:value={selectedExerciseId} style="padding: 5px; width: 100%;">
                        <option value="">-- Select Exercise --</option>
                        {#each getAllExerciseTypes() as type}
                          <optgroup label={type}>
                            {#each getExercisesByType(type) as ex}
                              <option value={ex.id}>{ex.name}</option>
                            {/each}
                          </optgroup>
                        {/each}
                      </select>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-bottom: 8px;">
                      <input type="text" bind:value={exerciseDetails.sets} placeholder="Sets" style="padding: 5px;" />
                      <input type="text" bind:value={exerciseDetails.reps} placeholder="Reps" style="padding: 5px;" />
                      <input type="text" bind:value={exerciseDetails.weight} placeholder="Weight" style="padding: 5px;" />
                    </div>
                    <div style="margin-bottom: 8px;">
                      <input type="text" bind:value={exerciseDetails.rir} placeholder="RIR (Reps in Reserve)" style="padding: 5px; width: 100%;" />
                    </div>
                    <div style="margin-bottom: 8px;">
                      <input type="text" bind:value={exerciseDetails.notes} placeholder="Notes" style="padding: 5px; width: 100%;" />
                    </div>

                    <!-- Custom Requirements -->
                    <div style="margin: 10px 0; padding: 10px; background: #fff3e0; border-radius: 5px;">
                      <strong style="font-size: 0.9em;">Custom Requirements (optional):</strong>
                      {#each exerciseDetails.customReqs as req, reqIndex}
                        <div style="display: flex; gap: 5px; margin-top: 5px;">
                          <input type="text" bind:value={exerciseDetails.customReqs[reqIndex].name} placeholder="Category (e.g. Tempo, Pause)" style="flex: 1; padding: 5px;" />
                          <input type="text" bind:value={exerciseDetails.customReqs[reqIndex].value} placeholder="Value (e.g. 3-1-2, 2 sec)" style="flex: 1; padding: 5px;" />
                          <button onclick={() => removeCustomReq(reqIndex)} style="padding: 5px 10px;">✕</button>
                        </div>
                      {/each}
                      <button onclick={addCustomReq} style="margin-top: 8px; font-size: 0.85em;">+ Add Requirement</button>
                    </div>

                    <button onclick={() => addExerciseToSection(dayIndex, sectionIndex)}>Add Exercise</button>
                    <button onclick={() => addingExerciseToSection = null}>Cancel</button>
                  </div>
                {:else}
                  <button onclick={() => addingExerciseToSection = `${dayIndex}-${sectionIndex}`} style="margin-top: 8px;">
                    + Add Exercise
                  </button>
                {/if}
              </div>
            {/each}
          {/if}
        {/if}
      </div>
    {/each}
  {/if}
{:else if program}
  <p>Redirecting...</p>
{:else}
  <p>Loading...</p>
{/if}

<nav style="margin-top: 20px;">
  <a href="/programs">← Back to Programs</a>
</nav>
