<script>
  import favicon from '$lib/assets/favicon.svg';
  import { auth, db } from '$lib/firebase.js';
  import { onAuthStateChanged, signOut } from 'firebase/auth';
  import { doc, getDoc } from 'firebase/firestore';
  import { onMount } from 'svelte';

  let { children } = $props();
  let user = $state(null);
  let userRole = $state(null);
  let menuOpen = $state(false);

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
    menuOpen = false;
  }

  function closeMenu() {
    menuOpen = false;
  }
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
  </style>
</svelte:head>

<!-- Mobile-friendly nav -->
<nav style="background: #333; padding: 10px 15px; position: sticky; top: 0; z-index: 100;">
  <div style="display: flex; justify-content: space-between; align-items: center;">
    <a href="/" style="color: white; text-decoration: none; font-weight: bold; font-size: 1.2em;" onclick={closeMenu}>
      AthElites
    </a>

    {#if user}
      <button
        onclick={() => menuOpen = !menuOpen}
        style="background: none; border: none; color: white; font-size: 1.5em; cursor: pointer; padding: 5px;"
      >
        {menuOpen ? '✕' : '☰'}
      </button>
    {:else}
      <a href="/login" style="color: white; text-decoration: none; padding: 8px 16px; background: #4CAF50; border-radius: 5px;">
        Login
      </a>
    {/if}
  </div>

  {#if menuOpen && user}
    <div style="padding-top: 15px; border-top: 1px solid #555; margin-top: 10px;">
      <div style="color: #aaa; font-size: 0.9em; margin-bottom: 10px;">
        {user.email}
        {#if userRole === 'admin'}
          <span style="color: #4CAF50;"> (Admin)</span>
        {/if}
      </div>

      <a href="/" onclick={closeMenu} style="display: block; color: white; text-decoration: none; padding: 10px 0; border-bottom: 1px solid #444;">
        Home
      </a>
      <a href="/programs" onclick={closeMenu} style="display: block; color: white; text-decoration: none; padding: 10px 0; border-bottom: 1px solid #444;">
        Programs
      </a>
      {#if userRole === 'admin' || userRole === 'coach'}
        <a href="/exercises" onclick={closeMenu} style="display: block; color: white; text-decoration: none; padding: 10px 0; border-bottom: 1px solid #444;">
          Exercise Library
        </a>
      {/if}
      {#if userRole === 'admin'}
        <a href="/admin/users" onclick={closeMenu} style="display: block; color: white; text-decoration: none; padding: 10px 0; border-bottom: 1px solid #444;">
          User Roles
        </a>
      {/if}
      <a href="/profile" onclick={closeMenu} style="display: block; color: white; text-decoration: none; padding: 10px 0; border-bottom: 1px solid #444;">
        Profile
      </a>
      <button
        onclick={logout}
        style="display: block; width: 100%; text-align: left; background: none; border: none; color: #ff6b6b; padding: 10px 0; cursor: pointer; font-size: 1em;"
      >
        Logout
      </button>
    </div>
  {/if}
</nav>

<main style="padding: 15px; max-width: 800px; margin: 0 auto;">
  {@render children()}
</main>
