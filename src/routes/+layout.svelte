<script>
  import favicon from '$lib/assets/favicon.svg';
  import { auth, db } from '$lib/firebase.js';
  import { onAuthStateChanged, signOut } from 'firebase/auth';
  import { doc, getDoc } from 'firebase/firestore';
  import { onMount } from 'svelte';

  let { children } = $props();
  let user = $state(null);
  let userRole = $state(null);

  onMount(() => {
    onAuthStateChanged(auth, async (u) => {
      user = u;
      if (u) {
        const userDoc = await getDoc(doc(db, 'user', u.uid));
        if (userDoc.exists()) {
          userRole = userDoc.data().role;
        }
      } else {
        userRole = null;
      }
    });
  });

  function logout() {
    signOut(auth);
  }
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
</svelte:head>

<nav style="background: #333; padding: 10px; margin-bottom: 20px;">
  <a href="/" style="color: white; margin-right: 20px;">Home</a>
  <a href="/log" style="color: white; margin-right: 20px;">Log Exercise</a>
  <a href="/programs" style="color: white; margin-right: 20px;">Programs</a>

  {#if user}
    <span style="color: #aaa; margin-right: 10px;">
      {user.email}
      {#if userRole === 'admin'}
        <span style="color: #4CAF50;">(Admin)</span>
      {/if}
    </span>
    <button onclick={logout}>Logout</button>
  {:else}
    <a href="/login" style="color: white;">Login / Sign Up</a>
  {/if}
</nav>

<main style="padding: 0 20px;">
  {@render children()}
</main>
