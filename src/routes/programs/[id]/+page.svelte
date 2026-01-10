<script>
  import { page } from '$app/stores';
  import { auth, db } from '$lib/firebase.js';
  import { doc, onSnapshot, updateDoc, getDoc, collection, addDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let program = $state(null);
  let userRole = $state(null);
  let clients = $state([]);
  let exercises = $state([]);
  let hasUnpublishedChanges = $state(false);
  let publishing = $state(false);
  let showCopyModal = $state(false);
  let selectedClientForCopy = $state('');

  // Day management
  let newDayName = $state('');
  let editingDayIndex = $state(null);
  let editDayName = $state('');

  // Section management
  let expandedDay = $state(null);
  let newSectionName = $state('');
  let newSectionMode = $state('full'); // 'full' or 'checkbox'
  let editingSectionIndex = $state(null);
  let editSectionName = $state('');
  let editSectionMode = $state('full');

  // Exercise in section
  let addingExerciseToSection = $state(null);
  let selectedExerciseId = $state('');
  let exerciseDetails = $state({ sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [], repsMetric: 'reps', weightMetric: 'weight' });

  // Editing exercise in section
  let editingExercise = $state(null); // format: "dayIndex-sectionIndex-exerciseIndex"
  let editExerciseDetails = $state({ sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [], repsMetric: 'reps', weightMetric: 'weight' });

  // Drag and drop
  let draggedExercise = $state(null); // { dayIndex, sectionIndex, exerciseIndex, exercise }
  let dropTargetSection = $state(null); // "dayIndex-sectionIndex"

  // Generate stable unique IDs
  function generateId() {
    return crypto.randomUUID();
  }

  // Backfill missing IDs on days/sections/exercises, returns true if any were added
  function backfillIds(days) {
    if (!days) return false;
    let changed = false;
    for (const day of days) {
      if (!day.workoutTemplateId) { day.workoutTemplateId = generateId(); changed = true; }
      for (const section of day.sections || []) {
        if (!section.sectionTemplateId) { section.sectionTemplateId = generateId(); changed = true; }
        for (const exercise of section.exercises || []) {
          if (!exercise.workoutExerciseId) { exercise.workoutExerciseId = generateId(); changed = true; }
        }
      }
    }
    return changed;
  }

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
        // Backfill missing IDs in both days and publishedDays
        const daysChanged = backfillIds(program.days);
        const publishedChanged = backfillIds(program.publishedDays);
        if (daysChanged || publishedChanged) {
          const updates = {};
          if (daysChanged) updates.days = program.days;
          if (publishedChanged) updates.publishedDays = program.publishedDays;
          updateDoc(doc(db, 'programs', programId), updates);
        }
        // Check for unpublished changes
        hasUnpublishedChanges = checkForUnpublishedChanges();
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
    const newDay = { workoutTemplateId: generateId(), name: newDayName, sections: [] };
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
    updatedDays[dayIndex].sections = [...(updatedDays[dayIndex].sections || []), {
      sectionTemplateId: generateId(),
      name: newSectionName,
      mode: newSectionMode,
      exercises: []
    }];
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
    newSectionName = '';
    newSectionMode = 'full';
  }

  async function deleteSection(dayIndex, sectionIndex) {
    if (!confirm('Delete this section?')) return;
    const updatedDays = [...program.days];
    updatedDays[dayIndex].sections = updatedDays[dayIndex].sections.filter((_, i) => i !== sectionIndex);
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
  }

  function startEditSection(dayIndex, sectionIndex) {
    const section = program.days[dayIndex].sections[sectionIndex];
    editingSectionIndex = `${dayIndex}-${sectionIndex}`;
    editSectionName = section.name;
    editSectionMode = section.mode || 'full';
  }

  async function saveEditSection(dayIndex, sectionIndex) {
    const updatedDays = [...program.days];
    updatedDays[dayIndex].sections[sectionIndex].name = editSectionName;
    updatedDays[dayIndex].sections[sectionIndex].mode = editSectionMode;
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
    editingSectionIndex = null;
    editSectionName = '';
    editSectionMode = 'full';
  }

  function cancelEditSection() {
    editingSectionIndex = null;
    editSectionName = '';
    editSectionMode = 'full';
  }

  // Exercise in section functions
  async function addExerciseToSection(dayIndex, sectionIndex) {
    if (!selectedExerciseId) return;
    const exercise = exercises.find(e => e.id === selectedExerciseId);
    if (!exercise) return;

    const updatedDays = [...program.days];
    const exerciseEntry = {
      workoutExerciseId: generateId(),
      exerciseId: selectedExerciseId,
      name: exercise.name,
      type: exercise.type,
      sets: exerciseDetails.sets,
      reps: exerciseDetails.reps,
      weight: exerciseDetails.weight,
      rir: exerciseDetails.rir,
      notes: exerciseDetails.notes,
      customReqs: exerciseDetails.customReqs || [],
      repsMetric: exerciseDetails.repsMetric || 'reps',
      weightMetric: exerciseDetails.weightMetric || 'weight'
    };
    updatedDays[dayIndex].sections[sectionIndex].exercises.push(exerciseEntry);
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });

    selectedExerciseId = '';
    exerciseDetails = { sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [], repsMetric: 'reps', weightMetric: 'weight' };
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
      customReqs: ex.customReqs ? [...ex.customReqs] : [],
      repsMetric: ex.repsMetric || 'reps',
      weightMetric: ex.weightMetric || 'weight'
    };
  }

  function cancelEditExercise() {
    editingExercise = null;
    editExerciseDetails = { sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [], repsMetric: 'reps', weightMetric: 'weight' };
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
    ex.repsMetric = editExerciseDetails.repsMetric;
    ex.weightMetric = editExerciseDetails.weightMetric;
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
    editingExercise = null;
    editExerciseDetails = { sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [], repsMetric: 'reps', weightMetric: 'weight' };
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

  // Check if there are unpublished changes
  function checkForUnpublishedChanges() {
    if (!program) return false;
    // If never published, there are unpublished changes (if there are days)
    if (!program.publishedDays && program.days?.length > 0) return true;
    // Compare current days with published days
    return JSON.stringify(program.days) !== JSON.stringify(program.publishedDays);
  }

  // Publish current changes to clients
  async function publishChanges() {
    if (!program) return;
    publishing = true;
    try {
      // Deep copy days to publishedDays and ensure all IDs exist
      const publishedDays = JSON.parse(JSON.stringify(program.days || []));
      for (const day of publishedDays) {
        if (!day.workoutTemplateId) day.workoutTemplateId = generateId();
        for (const section of day.sections || []) {
          if (!section.sectionTemplateId) section.sectionTemplateId = generateId();
          for (const exercise of section.exercises || []) {
            if (!exercise.workoutExerciseId) exercise.workoutExerciseId = generateId();
          }
        }
      }
      await updateDoc(doc(db, 'programs', program.id), {
        publishedDays,
        lastPublished: new Date()
      });
      hasUnpublishedChanges = false;
    } catch (e) {
      console.error('Error publishing:', e);
    }
    publishing = false;
  }

  // Create a copy of this program for a specific client
  async function createClientCopy() {
    if (!selectedClientForCopy || !program) return;

    const client = clients.find(c => c.id === selectedClientForCopy);
    if (!client) return;

    const clientName = client.displayName || client.email.split('@')[0];

    // Create new program with client's name
    const newProgram = {
      name: `${program.name} (${clientName})`,
      description: program.description || '',
      days: JSON.parse(JSON.stringify(program.days || [])), // Deep copy
      publishedDays: JSON.parse(JSON.stringify(program.days || [])), // Already published
      assignedTo: [selectedClientForCopy],
      parentProgramId: program.id, // Reference to original
      isClientCopy: true,
      createdFor: selectedClientForCopy,
      createdAt: new Date(),
      lastPublished: new Date()
    };

    const docRef = await addDoc(collection(db, 'programs'), newProgram);

    showCopyModal = false;
    selectedClientForCopy = '';

    // Navigate to the new program
    goto(`/programs/${docRef.id}`);
  }

  function getClientName(clientId) {
    const client = clients.find(c => c.id === clientId);
    return client?.displayName || client?.email?.split('@')[0] || 'Unknown';
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

  {#if program.isClientCopy}
    <div style="background: #e3f2fd; padding: 10px 15px; border-radius: 5px; margin-bottom: 15px; font-size: 0.9em;">
      <strong>Custom Program</strong> — Created for {getClientName(program.createdFor)}
    </div>
  {/if}

  <!-- Publish Status Banner -->
  {#if hasUnpublishedChanges}
    <div style="background: #fff3e0; border: 2px solid #ff9800; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
        <div>
          <strong style="color: #e65100;">Unpublished Changes</strong>
          <p style="margin: 5px 0 0 0; font-size: 0.9em; color: #666;">
            Clients won't see your changes until you publish.
          </p>
        </div>
        <button
          onclick={publishChanges}
          disabled={publishing}
          style="padding: 10px 20px; background: #ff9800; color: white; border: none; cursor: pointer; font-weight: bold; border-radius: 5px;"
        >
          {publishing ? 'Publishing...' : 'Publish to Clients'}
        </button>
      </div>
    </div>
  {:else if program.lastPublished}
    <div style="background: #e8f5e9; padding: 10px 15px; border-radius: 5px; margin-bottom: 15px; font-size: 0.9em; color: #2e7d32;">
      Published — Clients see the latest version
    </div>
  {/if}

  <!-- Action Buttons -->
  <div style="display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap;">
    <button onclick={() => showCopyModal = true} style="padding: 10px 15px; background: #2196F3; color: white; border: none; cursor: pointer; border-radius: 5px;">
      Create Copy for Client
    </button>
  </div>

  <!-- Copy Modal -->
  {#if showCopyModal}
    <div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 20px;">
      <div style="background: white; padding: 25px; border-radius: 10px; max-width: 400px; width: 100%;">
        <h3 style="margin: 0 0 15px 0;">Create Custom Copy</h3>
        <p style="color: #666; margin-bottom: 15px;">
          This will create a separate version of "{program.name}" specifically for one client. Changes to this copy won't affect the original.
        </p>

        <label style="display: block; margin-bottom: 15px;">
          <strong>Select Client:</strong>
          <select bind:value={selectedClientForCopy} style="width: 100%; padding: 10px; margin-top: 5px;">
            <option value="">-- Choose a client --</option>
            {#each clients as client}
              <option value={client.id}>{client.displayName || client.email}</option>
            {/each}
          </select>
        </label>

        {#if selectedClientForCopy}
          <p style="background: #f5f5f5; padding: 10px; border-radius: 5px; font-size: 0.9em;">
            New program will be named: <strong>"{program.name} ({getClientName(selectedClientForCopy)})"</strong>
          </p>
        {/if}

        <div style="display: flex; gap: 10px; margin-top: 20px;">
          <button
            onclick={createClientCopy}
            disabled={!selectedClientForCopy}
            style="flex: 1; padding: 12px; background: {selectedClientForCopy ? '#4CAF50' : '#ccc'}; color: white; border: none; cursor: {selectedClientForCopy ? 'pointer' : 'not-allowed'}; border-radius: 5px;"
          >
            Create Copy
          </button>
          <button onclick={() => { showCopyModal = false; selectedClientForCopy = ''; }} style="flex: 1; padding: 12px; background: #f5f5f5; border: 1px solid #ccc; cursor: pointer; border-radius: 5px;">
            Cancel
          </button>
        </div>
      </div>
    </div>
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
            {client.displayName || client.email}
            {#if client.displayName}
              <span style="color: #888; font-size: 0.85em;">({client.email})</span>
            {/if}
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
          <div style="margin: 10px 0; padding: 10px; background: #f0f0f0; border-radius: 5px;">
            <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center;">
              <input type="text" bind:value={newSectionName} placeholder="Section name (e.g. Warm-up, Main)" style="padding: 8px; flex: 1; min-width: 150px;" />
              <select bind:value={newSectionMode} style="padding: 8px;">
                <option value="full">Full Tracking (sets, reps, weight)</option>
                <option value="checkbox">Checkbox Only (just complete)</option>
              </select>
              <button onclick={() => addSection(dayIndex)}>Add Section</button>
            </div>
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
                {#if editingSectionIndex === `${dayIndex}-${sectionIndex}`}
                  <!-- Edit Section Mode -->
                  <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 10px;">
                    <input type="text" bind:value={editSectionName} style="padding: 5px; flex: 1;" />
                    <select bind:value={editSectionMode} style="padding: 5px;">
                      <option value="full">Full Tracking</option>
                      <option value="checkbox">Checkbox Only</option>
                    </select>
                    <button onclick={() => saveEditSection(dayIndex, sectionIndex)}>Save</button>
                    <button onclick={cancelEditSection}>Cancel</button>
                  </div>
                {:else}
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                      <strong>{section.name}</strong>
                      <span style="background: {section.mode === 'checkbox' ? '#fff3e0' : '#e8f5e9'}; padding: 2px 8px; border-radius: 10px; font-size: 0.75em; margin-left: 8px;">
                        {section.mode === 'checkbox' ? 'Checkbox' : 'Full Tracking'}
                      </span>
                    </div>
                    <div style="display: flex; gap: 5px;">
                      <button onclick={() => startEditSection(dayIndex, sectionIndex)} style="font-size: 0.8em;">Edit</button>
                      <button onclick={() => deleteSection(dayIndex, sectionIndex)} style="font-size: 0.8em;">Remove</button>
                    </div>
                  </div>
                {/if}

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
                        <!-- Metric selectors -->
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; padding: 10px; background: #f0f7ff; border-radius: 5px;">
                          <div>
                            <label style="font-size: 0.8em; color: #666;">Reps measured as:</label>
                            <select bind:value={editExerciseDetails.repsMetric} style="width: 100%; padding: 5px; margin-top: 3px;">
                              <option value="reps">Reps (count)</option>
                              <option value="distance">Distance</option>
                            </select>
                          </div>
                          <div>
                            <label style="font-size: 0.8em; color: #666;">Weight measured as:</label>
                            <select bind:value={editExerciseDetails.weightMetric} style="width: 100%; padding: 5px; margin-top: 3px;">
                              <option value="weight">Weight (lbs)</option>
                              <option value="time">Time</option>
                            </select>
                          </div>
                        </div>
                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin: 10px 0;">
                          <input type="text" bind:value={editExerciseDetails.sets} placeholder="Sets" style="padding: 5px;" />
                          <input type="text" bind:value={editExerciseDetails.reps} placeholder={editExerciseDetails.repsMetric === 'distance' ? 'Distance' : 'Reps'} style="padding: 5px;" />
                          <input type="text" bind:value={editExerciseDetails.weight} placeholder={editExerciseDetails.weightMetric === 'time' ? 'Time' : 'Weight'} style="padding: 5px;" />
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
                            <div style="display: flex; gap: 5px; margin-top: 5px; align-items: center;">
                              <input type="text" bind:value={editExerciseDetails.customReqs[reqIndex].name} placeholder="Category (e.g. Tempo)" style="flex: 1; padding: 5px;" />
                              <input type="text" bind:value={editExerciseDetails.customReqs[reqIndex].value} placeholder="Value (e.g. 3-1-2)" style="flex: 1; padding: 5px;" />
                              <label style="display: flex; align-items: center; gap: 3px; font-size: 0.75em; white-space: nowrap;">
                                <input type="checkbox" bind:checked={editExerciseDetails.customReqs[reqIndex].clientInput} />
                                Client input
                              </label>
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
                        {@const repsLabel = ex.repsMetric === 'distance' ? '' : 'reps'}
                        {@const weightLabel = ex.weightMetric === 'time' ? '' : ''}
                        <div style="display: flex; justify-content: space-between; align-items: start;">
                          <div style="display: flex; align-items: start; gap: 10px;">
                            <span style="color: #999; cursor: grab; font-size: 1.2em; user-select: none;" title="Drag to move">⋮⋮</span>
                            <div>
                              <strong>{ex.name}</strong>
                              <span style="color: #888; font-size: 0.8em;">({ex.type})</span>
                              {#if ex.repsMetric === 'distance' || ex.weightMetric === 'time'}
                                <span style="background: #e8f5e9; color: #2e7d32; padding: 2px 6px; border-radius: 3px; font-size: 0.7em; margin-left: 5px;">
                                  {ex.repsMetric === 'distance' ? 'Distance' : ''}{ex.repsMetric === 'distance' && ex.weightMetric === 'time' ? '/' : ''}{ex.weightMetric === 'time' ? 'Time' : ''}
                                </span>
                              {/if}
                              <br />
                              {#if ex.sets}{ex.sets} sets{/if}
                              {#if ex.reps} × {ex.reps} {ex.repsMetric === 'distance' ? '' : 'reps'}{/if}
                              {#if ex.weight} @ {ex.weight}{ex.weightMetric === 'time' ? '' : ''}{/if}
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
                    <!-- Metric selectors -->
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; padding: 10px; background: #f0f7ff; border-radius: 5px;">
                      <div>
                        <label style="font-size: 0.8em; color: #666;">Reps measured as:</label>
                        <select bind:value={exerciseDetails.repsMetric} style="width: 100%; padding: 5px; margin-top: 3px;">
                          <option value="reps">Reps (count)</option>
                          <option value="distance">Distance</option>
                        </select>
                      </div>
                      <div>
                        <label style="font-size: 0.8em; color: #666;">Weight measured as:</label>
                        <select bind:value={exerciseDetails.weightMetric} style="width: 100%; padding: 5px; margin-top: 3px;">
                          <option value="weight">Weight (lbs)</option>
                          <option value="time">Time</option>
                        </select>
                      </div>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-bottom: 8px;">
                      <input type="text" bind:value={exerciseDetails.sets} placeholder="Sets" style="padding: 5px;" />
                      <input type="text" bind:value={exerciseDetails.reps} placeholder={exerciseDetails.repsMetric === 'distance' ? 'Distance' : 'Reps'} style="padding: 5px;" />
                      <input type="text" bind:value={exerciseDetails.weight} placeholder={exerciseDetails.weightMetric === 'time' ? 'Time' : 'Weight'} style="padding: 5px;" />
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
                        <div style="display: flex; gap: 5px; margin-top: 5px; align-items: center;">
                          <input type="text" bind:value={exerciseDetails.customReqs[reqIndex].name} placeholder="Category (e.g. Tempo)" style="flex: 1; padding: 5px;" />
                          <input type="text" bind:value={exerciseDetails.customReqs[reqIndex].value} placeholder="Value (e.g. 3-1-2)" style="flex: 1; padding: 5px;" />
                          <label style="display: flex; align-items: center; gap: 3px; font-size: 0.75em; white-space: nowrap;">
                            <input type="checkbox" bind:checked={exerciseDetails.customReqs[reqIndex].clientInput} />
                            Client input
                          </label>
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
