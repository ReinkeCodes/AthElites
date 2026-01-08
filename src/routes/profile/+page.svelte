<script>
  import { auth, db } from '$lib/firebase.js';
  import { doc, getDoc, updateDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let currentUser = $state(null);
  let userData = $state(null);
  let displayName = $state('');
  let saving = $state(false);
  let message = $state('');

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        goto('/login');
        return;
      }
      currentUser = user;
      const userDoc = await getDoc(doc(db, 'user', user.uid));
      if (userDoc.exists()) {
        userData = userDoc.data();
        displayName = userData.displayName || '';
      }
    });
  });

  async function saveProfile(e) {
    e.preventDefault();
    if (!currentUser) return;

    saving = true;
    message = '';

    try {
      await updateDoc(doc(db, 'user', currentUser.uid), {
        displayName: displayName.trim()
      });
      message = 'Profile saved!';
      setTimeout(() => message = '', 3000);
    } catch (err) {
      message = 'Error saving: ' + err.message;
    }
    saving = false;
  }
</script>

<h1>Profile</h1>

{#if userData}
  <form onsubmit={saveProfile}>
    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: bold;">Your Name:</label>
      <input
        type="text"
        bind:value={displayName}
        placeholder="Enter your name"
        style="width: 100%; padding: 10px; box-sizing: border-box; font-size: 1em;"
      />
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: bold;">Email:</label>
      <p style="margin: 0; padding: 10px; background: #f5f5f5; border-radius: 5px;">{userData.email}</p>
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: bold;">Role:</label>
      <p style="margin: 0; padding: 10px; background: #f5f5f5; border-radius: 5px; text-transform: capitalize;">{userData.role}</p>
    </div>

    {#if message}
      <p style="color: {message.includes('Error') ? 'red' : 'green'}; padding: 10px; background: {message.includes('Error') ? '#ffebee' : '#e8f5e9'}; border-radius: 5px;">
        {message}
      </p>
    {/if}

    <button
      type="submit"
      disabled={saving}
      style="width: 100%; padding: 12px; background: #4CAF50; color: white; border: none; cursor: pointer; font-size: 1em;"
    >
      {saving ? 'Saving...' : 'Save Profile'}
    </button>
  </form>
{:else}
  <p>Loading...</p>
{/if}

<nav style="margin-top: 20px;">
  <a href="/">← Home</a>
</nav>
