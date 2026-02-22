<script>
  import favicon from '$lib/assets/favicon.svg';
  import { auth, db } from '$lib/firebase.js';
  import { hideNav } from '$lib/stores/ui.js';
  import { onAuthStateChanged, signOut } from 'firebase/auth';
  import { doc, getDoc } from 'firebase/firestore';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';

  let { children } = $props();
  let user = $state(null);
  let userRole = $state(null);
  let menuOpen = $state(false);

  // Pages that have back navigation (previously had "Back to..." links)
  const backNavPages = [
    '/programs',
    '/exercises',
    '/log',
    '/history',
    '/settings',
    '/admin/users',
    '/clients',
    '/compare'
  ];

  // Check if back arrow should be visible
  function showBackArrow(pathname) {
    if (pathname === '/') return false; // Never on home
    // Show on explicit back-nav pages or any nested program/workout pages
    return backNavPages.includes(pathname) || pathname.startsWith('/programs/');
  }

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
        // Redirect to login on logout (from any page)
        if (browser && window.location.pathname !== '/login') {
          localStorage.removeItem('ael:lastPath');
          goto('/login');
        }
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

  // Track last visited path for logged-in users (for resume functionality)
  $effect(() => {
    if (browser && user) {
      const path = $page.url.pathname + $page.url.search;
      if (path !== '/login' && path !== '/') {
        localStorage.setItem('ael:lastPath', path);
      }
    }
  });
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

{#if !$hideNav}
<!-- Click-outside overlay to close menu -->
{#if menuOpen && user}
  <div
    class="menu-overlay"
    onclick={closeMenu}
    role="presentation"
  ></div>
{/if}

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

  <!-- Back Arrow (visible when not on home, not menu open, and on back-nav page) -->
  {#if user && !menuOpen && showBackArrow($page.url.pathname)}
    <button
      onclick={() => history.back()}
      class="back-arrow"
      aria-label="Back"
      title="Back"
    >←</button>
  {/if}

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
      <a href="/history" onclick={closeMenu} style="display: block; color: white; text-decoration: none; padding: 10px 0; border-bottom: 1px solid #444;">
        History & PRs
      </a>
      {#if userRole === 'admin'}
        <a href="/clients" onclick={closeMenu} style="display: block; color: white; text-decoration: none; padding: 10px 0; border-bottom: 1px solid #444;">
          Clients
        </a>
      {/if}
      <a href="/exercises" onclick={closeMenu} style="display: block; color: white; text-decoration: none; padding: 10px 0; border-bottom: 1px solid #444;">
        Exercise Library
      </a>
      {#if userRole === 'admin'}
        <a href="/admin/users" onclick={closeMenu} style="display: block; color: white; text-decoration: none; padding: 10px 0; border-bottom: 1px solid #444;">
          User Roles
        </a>
      {/if}
      {#if userRole === 'admin' || userRole === 'coach'}
        <a href="/compare" onclick={closeMenu} style="display: block; color: white; text-decoration: none; padding: 10px 0; border-bottom: 1px solid #444;">
          Compare
        </a>
      {/if}
      <a href="/settings" onclick={closeMenu} style="display: block; color: white; text-decoration: none; padding: 10px 0; border-bottom: 1px solid #444;">
        Settings
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
{/if}

<main style="padding: 15px; max-width: 800px; margin: 0 auto;">
  {@render children()}
</main>

<style>
  .menu-overlay {
    position: fixed;
    inset: 0;
    z-index: 99;
    background: transparent;
    cursor: default;
  }
  .back-arrow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin-top: 8px;
    background: transparent;
    border: none;
    border-radius: 6px;
    font-size: 1.2em;
    color: white;
    cursor: pointer;
    transition: transform 0.1s ease, background 0.15s ease;
    line-height: 1;
  }
  .back-arrow:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  .back-arrow:active {
    transform: scale(0.9);
    color: #d4a574;
  }
</style>
