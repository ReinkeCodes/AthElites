<script>
  import { auth, db } from '$lib/firebase.js';
  import { doc, getDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let loading = $state(true);

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        goto('/login');
        return;
      }
      const userDoc = await getDoc(doc(db, 'user', user.uid));
      if (userDoc.exists() && userDoc.data().role === 'admin') {
        loading = false;
      } else {
        goto('/');
      }
    });
  });
</script>

{#if loading}
  <p>Loading...</p>
{:else}
  <h1>Client Dashboard</h1>
  <p style="color: #666;">Coming soon</p>
{/if}
