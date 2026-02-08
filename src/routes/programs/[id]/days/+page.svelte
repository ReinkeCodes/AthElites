<script>
  import { page } from '$app/stores';
  import { auth, db } from '$lib/firebase.js';
  import { doc, onSnapshot, getDoc, updateDoc, collection } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { browser } from '$app/environment';

  let program = $state(null);
  let userRole = $state(null);
  let currentUserId = $state(null);

  // Draft interception state
  let activeDraft = $state(null);
  let showDraftModal = $state(false);
  let pendingWorkoutRoute = $state(null);

  function loadActiveDraft() {
    if (!browser || !currentUserId) return;
    try {
      const key = `activeWorkoutDraft:${currentUserId}`;
      const raw = localStorage.getItem(key);
      activeDraft = raw ? JSON.parse(raw) : null;
    } catch (e) {
      activeDraft = null;
    }
  }

  function getDraftLabel() {
    if (!activeDraft) return '';
    const programName = activeDraft.programName || 'Workout';
    const dayName = activeDraft.dayName || `Day ${(activeDraft.dayIndex || 0) + 1}`;
    return `${programName} — ${dayName}`;
  }

  function handleStartWorkout(e, dayIndex) {
    e.preventDefault();
    const targetRoute = `/programs/${program.id}/workout/${dayIndex}`;

    // No draft or draft matches this workout → proceed
    if (!activeDraft || (activeDraft.programId === program.id && activeDraft.dayIndex === dayIndex)) {
      goto(targetRoute);
      return;
    }

    // Draft exists for different workout → show modal
    pendingWorkoutRoute = targetRoute;
    showDraftModal = true;
  }

  function resumeDraft() {
    showDraftModal = false;
    goto(`/programs/${activeDraft.programId}/workout/${activeDraft.dayIndex}`);
  }

  function discardAndProceed() {
    if (browser && currentUserId) {
      localStorage.removeItem(`activeWorkoutDraft:${currentUserId}`);
    }
    activeDraft = null;
    showDraftModal = false;
    if (pendingWorkoutRoute) {
      goto(pendingWorkoutRoute);
    }
  }

  // Generate stable unique IDs (Firestore-based, works on all browsers including mobile Safari)
  function generateId() {
    return doc(collection(db, '_')).id;
  }

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

  // Check if this is a client-owned program
  function isClientOwnedProgram() {
    return program?.createdByRole === 'client' && program?.createdByUserId === currentUserId;
  }

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUserId = user.uid;
        const userDoc = await getDoc(doc(db, 'user', user.uid));
        if (userDoc.exists()) {
          userRole = userDoc.data().role;
        }
        loadActiveDraft();
      }
    });

    const programId = $page.params.id;
    onSnapshot(doc(db, 'programs', programId), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();

        // Backfill missing IDs in publishedDays and persist
        if (data.publishedDays && backfillIds(data.publishedDays)) {
          updateDoc(doc(db, 'programs', programId), { publishedDays: data.publishedDays });
        }

        program = {
          id: snapshot.id,
          ...data,
          // Always use publishedDays for workouts (same infrastructure for all programs)
          days: data.publishedDays || []
        };
      }
    });
  });

  function getSectionSummaries(day) {
    if (!day.sections) return [];
    return day.sections.map(section => ({
      name: section.name,
      mode: section.mode || 'full',
      exercises: section.exercises || []
    }));
  }
</script>

{#if program}
  <h1>{program.name}</h1>
  {#if program.description}
    <p style="color: #666;">{program.description}</p>
  {/if}

  <h2>Select a Day</h2>

  {#if !program.days || program.days.length === 0}
    {#if isClientOwnedProgram()}
      <div style="background: #fff3e0; border: 2px solid #ff9800; padding: 20px; border-radius: 8px; text-align: center;">
        <p style="margin: 0 0 10px 0; font-weight: bold; color: #e65100;">No published workouts yet</p>
        <p style="margin: 0 0 15px 0; color: #666;">
          You need to publish your changes before you can start workouts.
        </p>
        <a href="/programs/{program.id}" style="display: inline-block; padding: 10px 20px; background: #ff9800; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
          Go to Editor & Publish
        </a>
      </div>
    {:else}
      <p>No workout days available yet. Check back later!</p>
    {/if}
  {:else}
    <div style="display: grid; gap: 15px;">
      {#each program.days as day, dayIndex}
        {@const sections = getSectionSummaries(day)}
        <a href="/programs/{program.id}/workout/{dayIndex}" onclick={(e) => handleStartWorkout(e, dayIndex)} style="text-decoration: none; color: inherit;">
          <div style="border: 2px solid #4CAF50; padding: 20px; border-radius: 10px; background: #f9fff9; cursor: pointer; transition: all 0.2s;" onmouseenter={(e) => e.currentTarget.style.background = '#e8f5e9'} onmouseleave={(e) => e.currentTarget.style.background = '#f9fff9'}>
            <div style="display: flex; justify-content: space-between; align-items: start;">
              <h3 style="margin: 0;">{day.name}</h3>
              {#if sections.length > 0}
                <span style="background: #e8f5e9; color: #4CAF50; padding: 3px 8px; border-radius: 12px; font-size: 0.75em;">{sections.length} section{sections.length !== 1 ? 's' : ''}</span>
              {/if}
            </div>

            {#if sections.length > 0}
              <div style="margin-top: 12px;">
                {#each sections as section}
                  <div style="margin-bottom: 10px;">
                    <div style="font-weight: 600; color: #333; font-size: 0.85em; margin-bottom: 4px;">{section.name}</div>
                    {#if section.mode === 'checkbox'}
                      <!-- Checkbox sections: brief list -->
                      <div style="color: #888; font-size: 0.8em;">
                        {section.exercises.map(e => e.name).join(' • ')}
                      </div>
                    {:else}
                      <!-- Full-detail sections: show sets/reps -->
                      {#each section.exercises as ex}
                        <div style="color: #555; font-size: 0.85em; padding: 4px 0 4px 10px; border-left: 2px solid #e0e0e0; margin: 3px 0;">
                          <strong>{ex.name}</strong>
                          {#if ex.sets || ex.reps || ex.weight}
                            <span style="color: #888;">
                              — {ex.sets || '?'}×{ex.reps || '?'}{#if ex.weight} @ {ex.weight}{/if}
                            </span>
                          {/if}
                        </div>
                      {/each}
                    {/if}
                  </div>
                {/each}
              </div>
            {:else}
              <p style="margin: 10px 0 0 0; color: #888; font-size: 0.9em;">No exercises yet</p>
            {/if}
          </div>
        </a>
      {/each}
    </div>
  {/if}
{:else}
  <p>Loading...</p>
{/if}

<!-- Draft Interception Modal (Option B) -->
{#if showDraftModal}
  <div
    role="dialog"
    aria-modal="true"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2001;"
    onclick={(e) => { if (e.target === e.currentTarget) showDraftModal = false; }}
  >
    <div style="background: white; border-radius: 8px; padding: 20px; max-width: 90%; width: 340px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <h3 style="margin: 0 0 12px 0; font-size: 1.1em;">Pick up where you left off?</h3>
      <p style="margin: 0 0 20px 0; color: #666; font-size: 0.9em;">We found an unfinished workout: <strong>{getDraftLabel()}</strong>. You can resume it, or discard it to start a new session.</p>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button onclick={discardAndProceed} style="padding: 8px 16px; background: #fff; color: #d32f2f; border: 1px solid #d32f2f; border-radius: 4px; cursor: pointer;">Discard</button>
        <button onclick={resumeDraft} style="padding: 8px 16px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer;">Resume</button>
      </div>
    </div>
  </div>
{/if}

