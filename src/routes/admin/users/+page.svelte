<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, doc, getDoc, updateDoc, onSnapshot } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let currentUser = $state(null);
  let userRole = $state(null);
  let allUsers = $state([]);
  let message = $state('');
  let loading = $state(true);
  let pendingChanges = $state({});
  let sortBy = $state('displayName');
  let sortDir = $state('asc');

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        goto('/login');
        return;
      }
      currentUser = user;
      const userDoc = await getDoc(doc(db, 'user', user.uid));
      if (userDoc.exists()) {
        userRole = userDoc.data().role;
        if (userRole !== 'admin') {
          goto('/');
          return;
        }
        onSnapshot(collection(db, 'user'), (snapshot) => {
          allUsers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
          loading = false;
        });
      } else {
        goto('/');
      }
    });
  });

  function getSortedUsers() {
    return [...allUsers].sort((a, b) => {
      let aVal, bVal;
      if (sortBy === 'displayName') {
        aVal = (a.displayName || a.email || '').toLowerCase();
        bVal = (b.displayName || b.email || '').toLowerCase();
      } else if (sortBy === 'role') {
        aVal = a.role || '';
        bVal = b.role || '';
      } else if (sortBy === 'createdAt') {
        aVal = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt || 0);
        bVal = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt || 0);
      }
      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  function toggleSort(field) {
    if (sortBy === field) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortBy = field;
      sortDir = 'asc';
    }
  }

  function setPendingRole(userId, newRole) {
    pendingChanges[userId] = newRole;
    pendingChanges = { ...pendingChanges };
  }

  function getDisplayRole(user) {
    return pendingChanges[user.id] !== undefined ? pendingChanges[user.id] : user.role;
  }

  function hasPendingChange(userId, currentRole) {
    return pendingChanges[userId] !== undefined && pendingChanges[userId] !== currentRole;
  }

  async function saveUserRole(userId) {
    if (userRole !== 'admin') return;
    if (userId === currentUser?.uid) {
      message = 'Cannot change your own role';
      setTimeout(() => message = '', 3000);
      return;
    }
    const newRole = pendingChanges[userId];
    if (!newRole) return;
    try {
      await updateDoc(doc(db, 'user', userId), { role: newRole });
      delete pendingChanges[userId];
      pendingChanges = { ...pendingChanges };
      message = 'Role updated successfully';
      setTimeout(() => message = '', 3000);
    } catch (err) {
      message = 'Error: ' + err.message;
    }
  }

  function formatDate(timestamp) {
    if (!timestamp) return '-';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString();
  }
</script>

<h1>User Roles</h1>

{#if loading}
  <p>Loading...</p>
{:else if userRole !== 'admin'}
  <p>Access denied. Admin only.</p>
{:else}
  {#if message}
    <p style="padding: 10px; background: {message.includes('Error') ? '#ffebee' : '#e8f5e9'}; color: {message.includes('Error') ? '#c62828' : '#2e7d32'}; border-radius: 5px; margin-bottom: 15px;">
      {message}
    </p>
  {/if}

  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;">
    <p style="color: #666; margin: 0;">{allUsers.length} user{allUsers.length !== 1 ? 's' : ''}</p>
    <div style="display: flex; gap: 5px; flex-wrap: wrap;">
      <span style="color: #888; font-size: 0.85em; align-self: center;">Sort:</span>
      <button onclick={() => toggleSort('displayName')} style="padding: 5px 10px; border: 1px solid {sortBy === 'displayName' ? '#667eea' : '#ccc'}; background: {sortBy === 'displayName' ? '#e8eaf6' : 'white'}; border-radius: 4px; cursor: pointer; font-size: 0.85em;">
        Name {sortBy === 'displayName' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
      </button>
      <button onclick={() => toggleSort('role')} style="padding: 5px 10px; border: 1px solid {sortBy === 'role' ? '#667eea' : '#ccc'}; background: {sortBy === 'role' ? '#e8eaf6' : 'white'}; border-radius: 4px; cursor: pointer; font-size: 0.85em;">
        Role {sortBy === 'role' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
      </button>
      <button onclick={() => toggleSort('createdAt')} style="padding: 5px 10px; border: 1px solid {sortBy === 'createdAt' ? '#667eea' : '#ccc'}; background: {sortBy === 'createdAt' ? '#e8eaf6' : 'white'}; border-radius: 4px; cursor: pointer; font-size: 0.85em;">
        Created {sortBy === 'createdAt' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
      </button>
    </div>
  </div>

  <div style="display: flex; flex-direction: column; gap: 10px;">
    {#each getSortedUsers() as user}
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; background: {hasPendingChange(user.id, user.role) ? '#fff8e1' : '#f5f5f5'}; border: 1px solid {hasPendingChange(user.id, user.role) ? '#ffb300' : 'transparent'}; border-radius: 8px; flex-wrap: wrap; gap: 10px;">
        <div style="flex: 1; min-width: 180px;">
          <strong>{user.displayName || user.email}</strong>
          {#if user.displayName}
            <br /><span style="color: #888; font-size: 0.85em;">{user.email}</span>
          {/if}
          {#if user.id === currentUser?.uid}
            <span style="background: #e3f2fd; color: #1565c0; padding: 2px 6px; border-radius: 4px; font-size: 0.7em; margin-left: 8px;">You</span>
          {/if}
          <div style="color: #999; font-size: 0.8em; margin-top: 4px;">Joined: {formatDate(user.createdAt)}</div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <select
            value={getDisplayRole(user)}
            onchange={(e) => setPendingRole(user.id, e.target.value)}
            disabled={user.id === currentUser?.uid}
            style="padding: 8px 12px; border-radius: 5px; border: 1px solid #ccc; font-size: 1em; {user.id === currentUser?.uid ? 'opacity: 0.5; cursor: not-allowed;' : 'cursor: pointer;'}"
          >
            <option value="client">Client</option>
            <option value="coach">Coach</option>
            <option value="admin">Admin</option>
          </select>
          {#if hasPendingChange(user.id, user.role)}
            <button onclick={() => saveUserRole(user.id)} style="padding: 8px 16px; background: #4CAF50; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 0.9em;">
              Save
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}
