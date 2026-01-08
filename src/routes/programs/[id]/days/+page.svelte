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

  function getExerciseNames(day) {
    const names = [];
    if (day.sections) {
      day.sections.forEach(section => {
        if (section.exercises) {
          section.exercises.forEach(ex => {
            if (ex.name) names.push(ex.name);
          });
        }
      });
    }
    return names;
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
        {@const exercises = getExerciseNames(day)}
        <a href="/programs/{program.id}/workout/{dayIndex}" style="text-decoration: none; color: inherit;">
          <div style="border: 2px solid #4CAF50; padding: 20px; border-radius: 10px; background: #f9fff9; cursor: pointer; transition: all 0.2s;" onmouseenter={(e) => e.currentTarget.style.background = '#e8f5e9'} onmouseleave={(e) => e.currentTarget.style.background = '#f9fff9'}>
            <div style="display: flex; justify-content: space-between; align-items: start;">
              <h3 style="margin: 0;">{day.name}</h3>
              {#if day.sections}
                <span style="background: #e8f5e9; color: #4CAF50; padding: 3px 8px; border-radius: 12px; font-size: 0.75em;">{day.sections.length} section{day.sections.length !== 1 ? 's' : ''}</span>
              {/if}
            </div>
            {#if exercises.length > 0}
              <div style="margin-top: 10px; color: #555; font-size: 0.9em; line-height: 1.5;">
                {exercises.join(' • ')}
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
