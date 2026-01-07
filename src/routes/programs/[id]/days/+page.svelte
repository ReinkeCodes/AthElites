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
        program = { id: snapshot.id, ...snapshot.data() };
      }
    });
  });

  function countExercises(day) {
    let total = 0;
    if (day.sections) {
      day.sections.forEach(section => {
        total += section.exercises?.length || 0;
      });
    }
    return total;
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
        <a href="/programs/{program.id}/workout/{dayIndex}" style="text-decoration: none; color: inherit;">
          <div style="border: 2px solid #4CAF50; padding: 20px; border-radius: 10px; background: #f9fff9; cursor: pointer;">
            <h3 style="margin: 0 0 10px 0;">{day.name}</h3>
            <p style="margin: 0; color: #666;">
              {countExercises(day)} exercise{countExercises(day) !== 1 ? 's' : ''}
              {#if day.sections}
                • {day.sections.length} section{day.sections.length !== 1 ? 's' : ''}
              {/if}
            </p>
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
