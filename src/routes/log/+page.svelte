 <script>
    import { db } from '$lib/firebase.js';
    import { collection, addDoc, onSnapshot, orderBy, query, deleteDoc, doc } from 'firebase/firestore';
    import { onMount } from 'svelte';

    let exercise = '';
    let weight = 0;
    let reps = 0;
    let date = new Date().toISOString().split('T')[0]; // Today's date
    let history = [];

    onMount(() => {
      const q = query(collection(db, 'exercises'), orderBy('date', 'desc'));
      onSnapshot(q, (snapshot) => {
        history = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      });
    });

    async function logExercise() {
      await addDoc(collection(db, 'exercises'), {
        exercise,
        weight,
        reps,
        date
      });
      exercise = '';
      weight = 0;
      reps = 0;
      date = new Date().toISOString().split('T')[0];
    }

    async function clearHistory() {
      if (confirm('Delete all entries? This cannot be undone.')) {
        for (const entry of history) {
          await deleteDoc(doc(db, 'exercises', entry.id));
        }
      }
    }
  </script>

  <h1>AthElites</h1>

  <form on:submit|preventDefault={logExercise}>
    <label>
      Exercise:
      <input type="text" bind:value={exercise} />
    </label>

    <label>
      Weight (lbs):
      <input type="number" bind:value={weight} />
    </label>

    <label>
      Reps:
      <input type="number" bind:value={reps} />
    </label>

    <label>
      Date:
      <input type="date" bind:value={date} />
    </label>

    <button type="submit">Log Exercise</button>
  </form>

  <h2>History</h2>
  <button on:click={clearHistory}>Clear All History</button>

  {#each history as entry}
    <p>{entry.date} - {entry.exercise}: {entry.weight}lbs x {entry.reps} reps</p>
  {/each}

