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
      if (userDoc.exists()) {
        const role = userDoc.data().role;
        if (role === 'admin' || role === 'coach') {
          loading = false;
          return;
        }
      }
      goto('/');
    });
  });
</script>

{#if !loading}
  <h1>Compare</h1>
  <p style="color: #666;">Coming soon.</p>
{/if}
