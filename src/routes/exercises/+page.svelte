<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, addDoc, onSnapshot, deleteDoc, doc, getDoc, setDoc, updateDoc, getDocs, query, where } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

  let exercises = $state([]);
  let programs = $state([]);
  let userRole = $state(null);
  let currentUserId = $state(null);

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
  let editVideoUrl = $state('');

  // Video URL
  let newVideoUrl = $state('');
  let videoUrlError = $state('');

  // Filter/sort
  let sortBy = $state('alphabetical');
  let filterType = $state('all');

  // Video modal
  let videoModalExercise = $state(null);
  let pendingVideoExercise = $state(null);

  // Toast notification
  let toastMessage = $state('');
  let toastType = $state('error'); // 'error' or 'success'

  function showToast(message, type = 'error') {
    toastMessage = message;
    toastType = type;
    setTimeout(() => { toastMessage = ''; }, 5000);
  }

  function validateVideoUrl(url) {
    const trimmed = url.trim();
    if (!trimmed) return { valid: true, value: '' };
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      return { valid: false, error: 'URL must start with http:// or https://' };
    }
    return { valid: true, value: trimmed };
  }

  // Extract YouTube video ID from URL (returns null if not YouTube)
  function getYouTubeId(url) {
    if (!url) return null;
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  function openVideoModal(exercise) {
    pendingVideoExercise = exercise;
  }

  function confirmOpenVideo() {
    videoModalExercise = pendingVideoExercise;
    pendingVideoExercise = null;
  }

  function cancelOpenVideo() {
    pendingVideoExercise = null;
  }

  function closeVideoModal() {
    videoModalExercise = null;
  }

  function handleModalKeydown(e) {
    if (e.key === 'Escape') closeVideoModal();
  }

  function handleConfirmKeydown(e) {
    if (e.key === 'Escape') cancelOpenVideo();
  }

  // Default types + custom types from Firebase
  const defaultTypes = ['Compound', 'Isolation', 'Warm-up', 'Stretch', 'Cardio', 'Mobility', 'Core'];
  let customTypes = $state([]);

  // Combined list for dropdowns (computed)
  function getAllTypes() {
    return [...defaultTypes, ...customTypes, 'Other'];
  }

  // Check if exercise is owned by current client user
  function isMyExercise(exercise) {
    return exercise.createdByRole === 'client' && exercise.createdByUserId === currentUserId;
  }

  // Filtered and sorted exercises (computed)
  function getFilteredExercises() {
    let result = [...exercises];

    // Role-based filtering
    if (userRole === 'admin' || userRole === 'coach') {
      // Coach/Admin: show only global exercises (exclude client-created)
      result = result.filter(e => e.createdByRole !== 'client');
    } else if (userRole === 'client') {
      // Client: show global exercises + their own client-created exercises
      result = result.filter(e => e.createdByRole !== 'client' || isMyExercise(e));
    }

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
        currentUserId = user.uid;
        try {
          const userDoc = await getDoc(doc(db, 'user', user.uid));
          if (userDoc.exists()) {
            userRole = userDoc.data().role;
          } else {
            showToast('User profile not found');
          }
        } catch (e) {
          console.error('Failed to load user role:', e.code, e.message);
          showToast(`Failed to load profile: ${e.message}`);
        }
      } else {
        userRole = null;
        currentUserId = null;
      }
    });

    // Load exercises with error handling
    onSnapshot(collection(db, 'exercises'),
      (snapshot) => {
        exercises = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      },
      (error) => {
        console.error('Failed to load exercises:', error.code, error.message);
        showToast(`Failed to load exercises: ${error.code} - ${error.message}`);
      }
    );

    // Load custom types
    onSnapshot(doc(db, 'settings', 'exerciseTypes'), (snapshot) => {
      if (snapshot.exists()) {
        customTypes = snapshot.data().types || [];
      }
    });
  });

  // Load programs based on role (to check exercise usage)
  $effect(() => {
    if (!userRole || !currentUserId) return;

    if (userRole === 'admin' || userRole === 'coach') {
      // Admin/Coach can load all programs
      const unsub = onSnapshot(collection(db, 'programs'),
        (snapshot) => {
          programs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        },
        (error) => {
          console.error('Failed to load programs:', error.code, error.message);
          showToast(`Failed to load programs: ${error.code} - ${error.message}`);
        }
      );
      return () => unsub();
    } else if (userRole === 'client') {
      // Client: load owned + assigned programs
      let ownedPrograms = [];
      let assignedPrograms = [];

      const ownedQuery = query(
        collection(db, 'programs'),
        where('createdByUserId', '==', currentUserId)
      );
      // Use canonical assignedToUids field for array-contains query
      const assignedQuery = query(
        collection(db, 'programs'),
        where('assignedToUids', 'array-contains', currentUserId)
      );

      const unsub1 = onSnapshot(ownedQuery,
        (snapshot) => {
          ownedPrograms = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
          const merged = [...ownedPrograms, ...assignedPrograms];
          const uniqueMap = new Map(merged.map(p => [p.id, p]));
          programs = Array.from(uniqueMap.values());
        },
        (error) => {
          console.error('Failed to load owned programs:', error.code, error.message);
          showToast(`Permission error: ${error.code} - ${error.message}`);
        }
      );

      const unsub2 = onSnapshot(assignedQuery,
        (snapshot) => {
          assignedPrograms = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
          const merged = [...ownedPrograms, ...assignedPrograms];
          const uniqueMap = new Map(merged.map(p => [p.id, p]));
          programs = Array.from(uniqueMap.values());
        },
        (error) => {
          console.error('Failed to load assigned programs:', error.code, error.message);
          showToast(`Permission error: ${error.code} - ${error.message}`);
        }
      );

      return () => {
        unsub1();
        unsub2();
      };
    }
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
    editVideoUrl = exercise.videoUrl || '';
    videoUrlError = '';
  }

  // Cancel editing
  function cancelEdit() {
    editingId = null;
    editName = '';
    editType = '';
    editCustomType = '';
    editNotes = '';
    editVideoUrl = '';
    videoUrlError = '';
  }

  // Save edited exercise
  async function saveEdit() {
    if (!editName.trim()) return;

    const videoValidation = validateVideoUrl(editVideoUrl);
    if (!videoValidation.valid) {
      videoUrlError = videoValidation.error;
      return;
    }
    videoUrlError = '';

    let finalType = editType;
    if (editType === 'Other' && editCustomType.trim()) {
      finalType = editCustomType.trim();
      await saveCustomType(finalType);
    }

    try {
      const updateData = {
        name: editName,
        type: finalType,
        notes: editNotes
      };
      if (videoValidation.value) {
        updateData.videoUrl = videoValidation.value;
      } else {
        // Use FieldValue.delete() equivalent - set to deleteField()
        const { deleteField } = await import('firebase/firestore');
        updateData.videoUrl = deleteField();
      }
      await updateDoc(doc(db, 'exercises', editingId), updateData);
      cancelEdit();
    } catch (err) {
      showToast(`Failed to update exercise: ${err.message}`);
    }
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

    const videoValidation = validateVideoUrl(newVideoUrl);
    if (!videoValidation.valid) {
      videoUrlError = videoValidation.error;
      return;
    }
    videoUrlError = '';

    // Determine final type
    let finalType = newType;
    if (newType === 'Other' && customType.trim()) {
      finalType = customType.trim();
      await saveCustomType(finalType);
    }

    try {
      const exerciseData = {
        name: newName,
        type: finalType,
        notes: newNotes,
        createdAt: new Date(),
        createdByRole: userRole,
        createdByUserId: currentUserId
      };
      if (videoValidation.value) {
        exerciseData.videoUrl = videoValidation.value;
      }
      await addDoc(collection(db, 'exercises'), exerciseData);

      // Reset form
      newName = '';
      newType = 'Compound';
      customType = '';
      newNotes = '';
      newVideoUrl = '';
    } catch (err) {
      showToast(`Failed to create exercise: ${err.message}`);
    }
  }

  async function deleteExercise(exercise) {
    const usingPrograms = getProgramsUsingExercise(exercise.id);

    let confirmMessage = `Delete "${exercise.name}"?`;
    if (usingPrograms.length > 0) {
      confirmMessage = `⚠️ WARNING: "${exercise.name}" is currently used in:\n\n• ${usingPrograms.join('\n• ')}\n\nThe exercise will remain in these programs but be removed from the library.\n\nDelete anyway?`;
    }

    if (confirm(confirmMessage)) {
      try {
        await deleteDoc(doc(db, 'exercises', exercise.id));
      } catch (err) {
        showToast(`Failed to delete exercise: ${err.message}`);
      }
    }
  }
</script>

<h1>Exercise Library</h1>

{#if userRole}
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

    <div style="margin-bottom: 10px;">
      <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Video URL (optional)</label>
      <input type="text" bind:value={newVideoUrl} placeholder="Paste a link (e.g., YouTube)" style="width: 100%; padding: 8px;" />
      {#if videoUrlError && !editingId}
        <p style="color: #f44336; font-size: 0.85em; margin: 4px 0 0 0;">{videoUrlError}</p>
      {/if}
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
          <div>
            <label style="display: block; font-size: 0.9em; margin-bottom: 4px;">Video URL (optional)</label>
            <input type="text" bind:value={editVideoUrl} placeholder="Paste a link (e.g., YouTube)" style="width: 100%; padding: 8px;" />
            {#if videoUrlError && editingId}
              <p style="color: #f44336; font-size: 0.85em; margin: 4px 0 0 0;">{videoUrlError}</p>
            {/if}
          </div>
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
        {@const isMine = isMyExercise(exercise)}
        <div style="display: flex; justify-content: space-between; align-items: start;">
          <div>
            <strong style="font-size: 1.1em;">{exercise.name}</strong>
            <span style="background: #e3f2fd; color: #1976D2; padding: 3px 8px; border-radius: 12px; margin-left: 10px; font-size: 0.8em;">{exercise.type}</span>
            {#if isMine}
              <span style="background: #e8f5e9; color: #388E3C; padding: 3px 8px; border-radius: 12px; margin-left: 6px; font-size: 0.8em;">My Exercise</span>
            {/if}
            {#if exercise.notes}
              <p style="margin: 8px 0 0 0; color: #666; font-style: italic;">{exercise.notes}</p>
            {/if}
            {#if usingPrograms.length > 0}
              <p style="margin: 8px 0 0 0; font-size: 0.8em; color: #888;">
                Used in: {usingPrograms.join(', ')}
              </p>
            {/if}
          </div>
          <div style="display: flex; gap: 8px;">
            {#if exercise.videoUrl?.trim()}
              <button
                onclick={() => openVideoModal(exercise)}
                aria-label="Play video"
                style="padding: 6px 12px; background: #fff; border: 1px solid #9C27B0; color: #9C27B0; cursor: pointer; border-radius: 4px; font-size: 0.9em;"
              >
                ▶ Video
              </button>
            {/if}
            {#if userRole === 'admin' || userRole === 'coach'}
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
            {:else if userRole === 'client' && isMine}
              <button
                onclick={() => startEdit(exercise)}
                style="padding: 6px 12px; background: #fff; border: 1px solid #2196F3; color: #2196F3; cursor: pointer; border-radius: 4px; font-size: 0.9em;"
              >
                Edit
              </button>
              <button
                onclick={() => deleteExercise(exercise)}
                style="padding: 6px 12px; background: #fff; border: 1px solid #f44336; color: #f44336; cursor: pointer; border-radius: 4px; font-size: 0.9em;"
              >
                Delete
              </button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/each}
{/if}

<!-- Video Confirm Dialog -->
{#if pendingVideoExercise}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Open video confirmation"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2001;"
    onclick={(e) => { if (e.target === e.currentTarget) cancelOpenVideo(); }}
    onkeydown={handleConfirmKeydown}
  >
    <div style="background: white; border-radius: 8px; padding: 20px; max-width: 90%; width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <h3 style="margin: 0 0 12px 0; font-size: 1.1em;">Open video?</h3>
      <p style="margin: 0 0 20px 0; color: #666; font-size: 0.9em;">This video may load content from an external site (e.g., YouTube).</p>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button
          onclick={cancelOpenVideo}
          style="padding: 8px 16px; background: #fff; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;"
        >Cancel</button>
        <button
          onclick={confirmOpenVideo}
          style="padding: 8px 16px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer;"
        >Continue</button>
      </div>
    </div>
  </div>
{/if}

<!-- Video Modal -->
{#if videoModalExercise}
  {@const ytId = getYouTubeId(videoModalExercise.videoUrl)}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Video player"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 2000;"
    onclick={(e) => { if (e.target === e.currentTarget) closeVideoModal(); }}
    onkeydown={handleModalKeydown}
  >
    <div style="background: white; border-radius: 8px; max-width: 90%; width: 640px; max-height: 90vh; overflow: auto;">
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px; border-bottom: 1px solid #eee;">
        <h3 style="margin: 0;">{videoModalExercise.name}</h3>
        <button
          onclick={closeVideoModal}
          aria-label="Close"
          style="background: none; border: none; font-size: 1.5em; cursor: pointer; padding: 4px 8px;"
        >&times;</button>
      </div>
      <div style="padding: 16px;">
        {#if ytId}
          <div style="position: relative; padding-bottom: 56.25%; height: 0;">
            <iframe
              src="https://www.youtube.com/embed/{ytId}"
              title="Video player"
              frameborder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen
              style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border-radius: 4px;"
            ></iframe>
          </div>
        {:else}
          <p style="margin: 0 0 12px 0;">This video cannot be embedded.</p>
          <a
            href={videoModalExercise.videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            style="display: inline-block; padding: 10px 20px; background: #2196F3; color: white; text-decoration: none; border-radius: 4px;"
          >Open link</a>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- Toast notification -->
{#if toastMessage}
  <div style="position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: {toastType === 'error' ? '#f44336' : '#4CAF50'}; color: white; padding: 12px 24px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000; max-width: 90%; text-align: center;">
    {toastMessage}
  </div>
{/if}
