<script>
    import { db } from '$lib/firebase.js';
    import { collection, onSnapshot, query, where, orderBy } from 'firebase/firestore';
    import { onMount } from 'svelte';

    let todaysExercises = [];
    let today = new Date().toISOString().split('T')[0];

    onMount(() => {
      const q = query(
        collection(db, 'exercises'),
        where('date', '==', today),
        orderBy('date', 'desc')
      );
      onSnapshot(q, (snapshot) => {
        todaysExercises = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      });
    });
  </script>

  <h1>AthElites</h1>
  <h2>Today's Workout</h2>

  {#if todaysExercises.length === 0}
    <p>No exercises logged today.</p>
  {:else}
    {#each todaysExercises as entry}
      <p>{entry.exercise}: {entry.weight}lbs x {entry.reps} reps</p>
    {/each}
  {/if}

  <nav>
    <a href="/log">Log Exercise</a>
  </nav>