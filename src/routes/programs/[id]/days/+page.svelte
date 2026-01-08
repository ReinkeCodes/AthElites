<script>
  import { page } from '$app/stores';
  import { auth, db } from '$lib/firebase.js';
  import { doc, onSnapshot, getDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';

  let program = $state(null);
  let userRole = $state(null);

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        const userDoc = await getDoc(doc(db, 'user', user.uid));
        if (userDoc.exists()) {
          userRole = userDoc.data().role;
        }
      }
    });

    const programId = $page.params.id;
    onSnapshot(doc(db, 'programs', programId), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        program = {
          id: snapshot.id,
          ...data,
          // Use published version for clients
          days: data.publishedDays || data.days
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
    <p>No workout days available yet. Check back later!</p>
  {:else}
    <div style="display: grid; gap: 15px;">
      {#each program.days as day, dayIndex}
        {@const sections = getSectionSummaries(day)}
        <a href="/programs/{program.id}/workout/{dayIndex}" style="text-decoration: none; color: inherit;">
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

<nav style="margin-top: 20px;">
  <a href="/programs">← Back to Programs</a>
</nav>
