<script>
  import { auth, db } from '$lib/firebase.js';
  import { doc, getDoc, updateDoc, collection, onSnapshot } from 'firebase/firestore';
  import { onAuthStateChanged, sendPasswordResetEmail, verifyBeforeUpdateEmail, sendEmailVerification, reauthenticateWithCredential, EmailAuthProvider } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { APP_VERSION, BUILD_ID, BUILD_TIME, FEATURE_VERSIONS } from '$lib/version.js';

  // Compute latest feature update date
  const latestFeatureUpdate = Object.values(FEATURE_VERSIONS).map(f => f.date).filter(Boolean).sort().pop() || null;

  let currentUser = $state(null);
  let userData = $state(null);
  let displayName = $state('');
  let saving = $state(false);
  let message = $state('');
  let allUsers = $state([]);
  let roleMessage = $state('');

  // Shared cooldown constant
  const COOLDOWN_SECONDS = 45;

  // Action code settings for email change verification
  const changeEmailActionCodeSettings = {
    url: 'https://athelites-c32e5.web.app/settings',
    handleCodeInApp: false
  };

  // Password reset state
  let resetLoading = $state(false);
  let resetSuccess = $state(false);
  let resetError = $state('');
  let resetCooldown = $state(0);
  let resetCooldownInterval = null;

  // Change email state
  let showChangeEmailForm = $state(false);
  let newEmail = $state('');
  let changeEmailLoading = $state(false);
  let changeEmailSuccess = $state(false);
  let changeEmailError = $state('');
  let changeEmailCooldown = $state(0);
  let changeEmailCooldownInterval = null;

  // Reauth state (for change email)
  let showReauthForm = $state(false);
  let reauthPassword = $state('');
  let reauthLoading = $state(false);
  let reauthError = $state('');
  let pendingChangeEmailAction = $state(null); // 'send' | 'resend' | null

  function hasPasswordProvider() {
    return currentUser?.providerData?.some(p => p.providerId === 'password');
  }

  function getChangeEmailErrorMessage(code) {
    switch (code) {
      case 'auth/email-already-in-use':
        return 'That email is already in use. Try a different email or sign in to the account that uses it.';
      case 'auth/invalid-email':
        return 'Enter a valid email address.';
      case 'auth/too-many-requests':
        return 'Too many attempts. Please wait a bit and try again.';
      default:
        return "Couldn't send change email link. Please try again.";
    }
  }

  // Verify email state
  let verifyLoading = $state(false);
  let verifySuccess = $state(false);
  let verifyError = $state('');
  let verifyCooldown = $state(0);
  let verifyCooldownInterval = null;

  function formatCooldown(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  function startResetCooldown() {
    resetCooldown = COOLDOWN_SECONDS;
    if (resetCooldownInterval) clearInterval(resetCooldownInterval);
    resetCooldownInterval = setInterval(() => {
      resetCooldown--;
      if (resetCooldown <= 0) {
        clearInterval(resetCooldownInterval);
        resetCooldownInterval = null;
      }
    }, 1000);
  }

  function startChangeEmailCooldown() {
    changeEmailCooldown = COOLDOWN_SECONDS;
    if (changeEmailCooldownInterval) clearInterval(changeEmailCooldownInterval);
    changeEmailCooldownInterval = setInterval(() => {
      changeEmailCooldown--;
      if (changeEmailCooldown <= 0) {
        clearInterval(changeEmailCooldownInterval);
        changeEmailCooldownInterval = null;
      }
    }, 1000);
  }

  function startVerifyCooldown() {
    verifyCooldown = COOLDOWN_SECONDS;
    if (verifyCooldownInterval) clearInterval(verifyCooldownInterval);
    verifyCooldownInterval = setInterval(() => {
      verifyCooldown--;
      if (verifyCooldown <= 0) {
        clearInterval(verifyCooldownInterval);
        verifyCooldownInterval = null;
      }
    }, 1000);
  }

  async function handlePasswordReset() {
    if (!currentUser?.email) return;
    resetError = '';
    resetLoading = true;
    try {
      await sendPasswordResetEmail(auth, currentUser.email);
      resetSuccess = true;
      startResetCooldown();
    } catch (err) {
      resetError = "Couldn't send reset email. Please try again.";
    }
    resetLoading = false;
  }

  async function handleResendReset() {
    if (resetCooldown > 0 || !currentUser?.email) return;
    resetError = '';
    resetLoading = true;
    try {
      await sendPasswordResetEmail(auth, currentUser.email);
      startResetCooldown();
    } catch (err) {
      resetError = "Couldn't send reset email. Please try again.";
    }
    resetLoading = false;
  }

  async function handleChangeEmail() {
    if (!currentUser || !newEmail.trim()) return;
    changeEmailSuccess = false;
    changeEmailError = '';
    const targetEmail = newEmail.trim().toLowerCase();
    const currentEmail = currentUser?.email?.trim().toLowerCase() || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      changeEmailError = 'Please enter a valid email address.';
      return;
    }
    if (targetEmail === currentEmail) {
      changeEmailError = 'New email must be different from your current email.';
      return;
    }
    changeEmailLoading = true;
    try {
      await verifyBeforeUpdateEmail(currentUser, targetEmail, changeEmailActionCodeSettings);
      changeEmailSuccess = true;
      showChangeEmailForm = false;
      showReauthForm = false;
      pendingChangeEmailAction = null;
      startChangeEmailCooldown();
    } catch (err) {
      changeEmailSuccess = false;
      if (err?.code === 'auth/requires-recent-login') {
        pendingChangeEmailAction = 'send';
        showReauthForm = true;
        reauthError = '';
        reauthPassword = '';
      } else {
        changeEmailError = getChangeEmailErrorMessage(err?.code);
      }
    }
    changeEmailLoading = false;
  }

  async function handleReauthAndChangeEmail() {
    if (!currentUser || !reauthPassword) return;
    reauthError = '';
    reauthLoading = true;
    try {
      const credential = EmailAuthProvider.credential(currentUser.email, reauthPassword);
      await reauthenticateWithCredential(currentUser, credential);
      // Retry the pending action
      const targetEmail = newEmail.trim().toLowerCase();
      await verifyBeforeUpdateEmail(currentUser, targetEmail, changeEmailActionCodeSettings);
      changeEmailSuccess = true;
      showChangeEmailForm = false;
      showReauthForm = false;
      reauthPassword = '';
      pendingChangeEmailAction = null;
      startChangeEmailCooldown();
    } catch (err) {
      if (err?.code === 'auth/email-already-in-use' || err?.code === 'auth/invalid-email' || err?.code === 'auth/too-many-requests') {
        changeEmailError = getChangeEmailErrorMessage(err?.code);
        showReauthForm = false;
        reauthPassword = '';
        pendingChangeEmailAction = null;
      } else {
        reauthError = `Couldn't confirm: ${err?.code || 'unknown error'}`;
      }
    }
    reauthLoading = false;
  }

  function cancelReauth() {
    showReauthForm = false;
    reauthPassword = '';
    reauthError = '';
    pendingChangeEmailAction = null;
  }

  async function handleResendChangeEmail() {
    if (changeEmailCooldown > 0 || !currentUser || !newEmail.trim()) return;
    changeEmailSuccess = false;
    changeEmailError = '';
    const targetEmail = newEmail.trim().toLowerCase();
    const currentEmail = currentUser?.email?.trim().toLowerCase() || '';
    if (targetEmail === currentEmail) {
      changeEmailError = 'New email must be different from your current email.';
      return;
    }
    changeEmailLoading = true;
    try {
      await verifyBeforeUpdateEmail(currentUser, targetEmail, changeEmailActionCodeSettings);
      changeEmailSuccess = true;
      startChangeEmailCooldown();
    } catch (err) {
      changeEmailSuccess = false;
      if (err?.code === 'auth/requires-recent-login') {
        pendingChangeEmailAction = 'resend';
        showChangeEmailForm = true;
        showReauthForm = true;
        reauthError = '';
        reauthPassword = '';
      } else {
        changeEmailError = getChangeEmailErrorMessage(err?.code);
      }
    }
    changeEmailLoading = false;
  }

  async function handleVerifyEmail() {
    if (!currentUser) return;
    verifyError = '';
    verifyLoading = true;
    try {
      await sendEmailVerification(currentUser);
      verifySuccess = true;
      startVerifyCooldown();
    } catch (err) {
      verifyError = "Couldn't send verification email. Please try again.";
    }
    verifyLoading = false;
  }

  async function handleResendVerify() {
    if (verifyCooldown > 0 || !currentUser) return;
    verifyError = '';
    verifyLoading = true;
    try {
      await sendEmailVerification(currentUser);
      startVerifyCooldown();
    } catch (err) {
      verifyError = "Couldn't send verification email. Please try again.";
    }
    verifyLoading = false;
  }

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
        if (userData.role === 'admin') {
          onSnapshot(collection(db, 'user'), (snapshot) => {
            allUsers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
          }, (err) => {
            if (err?.code === 'permission-denied') return;
            console.error(err);
          });
        }
      }
    });
    return () => {
      if (resetCooldownInterval) clearInterval(resetCooldownInterval);
      if (changeEmailCooldownInterval) clearInterval(changeEmailCooldownInterval);
      if (verifyCooldownInterval) clearInterval(verifyCooldownInterval);
    };
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

  async function changeUserRole(userId, newRole) {
    if (userData?.role !== 'admin') return;
    if (userId === currentUser?.uid) {
      roleMessage = 'Cannot change your own role';
      setTimeout(() => roleMessage = '', 3000);
      return;
    }
    try {
      await updateDoc(doc(db, 'user', userId), { role: newRole });
      roleMessage = 'Role updated!';
      setTimeout(() => roleMessage = '', 3000);
    } catch (err) {
      roleMessage = 'Error: ' + err.message;
    }
  }
</script>

<h1>Settings</h1>

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

  <!-- Security Section -->
  <hr style="margin: 30px 0; border: none; border-top: 2px solid #eee;" />
  <h2>Security</h2>

  <div style="margin-bottom: 15px;">
    <label style="display: block; margin-bottom: 5px; font-weight: bold;">Account email:</label>
    <p style="margin: 0; padding: 10px; background: #f5f5f5; border-radius: 5px; display: flex; align-items: center; gap: 8px;">
      {currentUser?.email || 'Account email unavailable'}
      {#if currentUser?.emailVerified}
        <span style="color: #2e7d32; font-size: 0.85em;">✓ Verified</span>
      {/if}
    </p>
  </div>

  <!-- Verify Email -->
  {#if currentUser?.email && !currentUser?.emailVerified}
    {#if verifyError}
      <p style="color: red; background: #ffebee; padding: 10px; border-radius: 5px; margin-bottom: 15px;">{verifyError}</p>
    {/if}
    {#if verifySuccess}
      <div style="background: #e8f5e9; padding: 20px; border-radius: 8px; margin-bottom: 15px;">
        <p style="color: #2e7d32; font-size: 1.1em; margin: 0 0 10px 0;">
          ✅ Verification email sent to <strong>{currentUser?.email}</strong>
        </p>
        <p style="color: #555; margin: 0;">Check your inbox and spam/junk folder.</p>
      </div>
      <button
        onclick={handleResendVerify}
        disabled={verifyLoading || verifyCooldown > 0}
        style="width: 100%; padding: 12px; margin-bottom: 15px; background: {verifyCooldown > 0 ? '#ccc' : '#2196F3'}; color: white; border: none; cursor: {verifyCooldown > 0 ? 'not-allowed' : 'pointer'}; font-size: 1em; border-radius: 4px;"
      >
        {#if verifyLoading}
          Sending...
        {:else if verifyCooldown > 0}
          Resend in {formatCooldown(verifyCooldown)}
        {:else}
          Resend verification
        {/if}
      </button>
    {:else}
      <button
        onclick={handleVerifyEmail}
        disabled={verifyLoading}
        style="width: 100%; padding: 12px; margin-bottom: 15px; background: #2196F3; color: white; border: none; cursor: pointer; font-size: 1em; border-radius: 4px;"
      >
        {verifyLoading ? 'Sending...' : 'Verify email'}
      </button>
    {/if}
  {/if}

  <!-- Change Email -->
  {#if changeEmailError}
    <p style="color: red; background: #ffebee; padding: 10px; border-radius: 5px; margin-bottom: 15px;">{changeEmailError}</p>
  {/if}
  {#if changeEmailSuccess}
    <div style="background: #e8f5e9; padding: 20px; border-radius: 8px; margin-bottom: 15px;">
      <p style="color: #2e7d32; font-size: 1.1em; margin: 0 0 10px 0;">
        ✅ Change-email link sent
      </p>
      <p style="color: #555; margin: 0 0 8px 0;">Sent to: <strong>{newEmail}</strong></p>
      <p style="color: #555; margin: 0 0 8px 0;">If you don't receive the email, check spam/junk.</p>
      <p style="color: #555; margin: 0;">If the link doesn't work, the new email may already be used by another AthElites account.</p>
    </div>
    <button
      onclick={handleResendChangeEmail}
      disabled={changeEmailLoading || changeEmailCooldown > 0}
      style="width: 100%; padding: 12px; margin-bottom: 15px; background: {changeEmailCooldown > 0 ? '#ccc' : '#FF9800'}; color: white; border: none; cursor: {changeEmailCooldown > 0 ? 'not-allowed' : 'pointer'}; font-size: 1em; border-radius: 4px;"
    >
      {#if changeEmailLoading}
        Sending...
      {:else if changeEmailCooldown > 0}
        Resend in {formatCooldown(changeEmailCooldown)}
      {:else}
        Resend change email link
      {/if}
    </button>
  {:else if showChangeEmailForm}
    <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
      {#if showReauthForm}
        {#if !hasPasswordProvider()}
          <p style="color: #555; margin: 0 0 15px 0;">Please sign out and sign back in, then try again.</p>
          <button
            onclick={cancelReauth}
            style="padding: 12px 20px; background: transparent; color: #666; border: 1px solid #ccc; cursor: pointer; font-size: 1em; border-radius: 4px;"
          >
            Cancel
          </button>
        {:else}
          <p style="color: #555; margin: 0 0 15px 0;">For security, please confirm your password to change your email.</p>
          {#if reauthError}
            <p style="color: red; background: #ffebee; padding: 10px; border-radius: 5px; margin-bottom: 10px;">{reauthError}</p>
          {/if}
          <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px; font-weight: bold;">Password:</label>
            <input
              type="password"
              bind:value={reauthPassword}
              placeholder="Enter your password"
              style="width: 100%; padding: 10px; box-sizing: border-box; font-size: 1em;"
            />
          </div>
          <div style="display: flex; gap: 10px;">
            <button
              onclick={handleReauthAndChangeEmail}
              disabled={reauthLoading || !reauthPassword}
              style="flex: 1; padding: 12px; background: #FF9800; color: white; border: none; cursor: pointer; font-size: 1em; border-radius: 4px;"
            >
              {reauthLoading ? 'Confirming...' : 'Confirm and send link'}
            </button>
            <button
              onclick={cancelReauth}
              style="padding: 12px 20px; background: transparent; color: #666; border: 1px solid #ccc; cursor: pointer; font-size: 1em; border-radius: 4px;"
            >
              Cancel
            </button>
          </div>
        {/if}
      {:else}
        <div style="margin-bottom: 10px;">
          <label style="display: block; margin-bottom: 5px; font-weight: bold;">New email address:</label>
          <input
            type="email"
            bind:value={newEmail}
            placeholder="Enter new email"
            style="width: 100%; padding: 10px; box-sizing: border-box; font-size: 1em;"
          />
        </div>
        <div style="display: flex; gap: 10px;">
          <button
            onclick={handleChangeEmail}
            disabled={changeEmailLoading || !currentUser?.email}
            style="flex: 1; padding: 12px; background: #FF9800; color: white; border: none; cursor: pointer; font-size: 1em; border-radius: 4px;"
          >
            {changeEmailLoading ? 'Sending...' : 'Send change-email link to new address'}
          </button>
          <button
            onclick={() => { showChangeEmailForm = false; newEmail = ''; changeEmailError = ''; }}
            style="padding: 12px 20px; background: transparent; color: #666; border: 1px solid #ccc; cursor: pointer; font-size: 1em; border-radius: 4px;"
          >
            Cancel
          </button>
        </div>
      {/if}
    </div>
  {:else}
    <button
      onclick={() => showChangeEmailForm = true}
      disabled={!currentUser?.email}
      style="width: 100%; padding: 12px; margin-bottom: 15px; background: {!currentUser?.email ? '#ccc' : '#FF9800'}; color: white; border: none; cursor: {!currentUser?.email ? 'not-allowed' : 'pointer'}; font-size: 1em; border-radius: 4px;"
    >
      Change email
    </button>
  {/if}

  <!-- Password Reset -->
  {#if resetError}
    <p style="color: red; background: #ffebee; padding: 10px; border-radius: 5px; margin-bottom: 15px;">{resetError}</p>
  {/if}

  {#if resetSuccess}
    <div style="background: #e8f5e9; padding: 20px; border-radius: 8px; margin-bottom: 15px;">
      <p style="color: #2e7d32; font-size: 1.1em; margin: 0 0 10px 0;">
        ✅ Reset link sent to <strong>{currentUser?.email}</strong>
      </p>
      <p style="color: #555; margin: 0 0 8px 0;">Check your inbox and spam/junk folder.</p>
      <p style="color: #555; margin: 0;">Consider saving your new password in a password manager.</p>
    </div>
    <button
      onclick={handleResendReset}
      disabled={resetLoading || resetCooldown > 0}
      style="width: 100%; padding: 12px; background: {resetCooldown > 0 ? '#ccc' : '#4CAF50'}; color: white; border: none; cursor: {resetCooldown > 0 ? 'not-allowed' : 'pointer'}; font-size: 1em; border-radius: 4px;"
    >
      {#if resetLoading}
        Sending...
      {:else if resetCooldown > 0}
        Resend in {formatCooldown(resetCooldown)}
      {:else}
        Resend link
      {/if}
    </button>
  {:else}
    <button
      onclick={handlePasswordReset}
      disabled={resetLoading || !currentUser?.email}
      style="width: 100%; padding: 12px; background: {!currentUser?.email ? '#ccc' : '#4CAF50'}; color: white; border: none; cursor: {!currentUser?.email ? 'not-allowed' : 'pointer'}; font-size: 1em; border-radius: 4px;"
    >
      {resetLoading ? 'Sending...' : 'Send password reset link'}
    </button>
  {/if}
{:else}
  <p>Loading...</p>
{/if}

{#if userData?.role === 'admin'}
  <hr style="margin: 30px 0; border: none; border-top: 2px solid #eee;" />
  <h2>User Management</h2>
  {#if roleMessage}
    <p style="color: {roleMessage.includes('Error') ? 'red' : 'green'}; padding: 10px; background: {roleMessage.includes('Error') ? '#ffebee' : '#e8f5e9'}; border-radius: 5px; margin-bottom: 15px;">
      {roleMessage}
    </p>
  {/if}
  <div style="display: flex; flex-direction: column; gap: 10px;">
    {#each allUsers as user}
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #f5f5f5; border-radius: 8px; flex-wrap: wrap; gap: 10px;">
        <div>
          <strong>{user.displayName || user.email}</strong>
          {#if user.displayName}<br /><span style="color: #888; font-size: 0.85em;">{user.email}</span>{/if}
          {#if user.id === currentUser?.uid}<span style="background: #e3f2fd; color: #1565c0; padding: 2px 6px; border-radius: 4px; font-size: 0.7em; margin-left: 8px;">You</span>{/if}
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <select
            value={user.role}
            onchange={(e) => changeUserRole(user.id, e.target.value)}
            disabled={user.id === currentUser?.uid}
            style="padding: 6px 10px; border-radius: 4px; border: 1px solid #ccc; {user.id === currentUser?.uid ? 'opacity: 0.5; cursor: not-allowed;' : ''}"
          >
            <option value="client">Client</option>
            <option value="coach">Coach</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>
    {/each}
  </div>
{/if}

<!-- About Section -->
<hr style="margin: 30px 0; border: none; border-top: 2px solid #eee;" />
<h2>About</h2>
<div style="background: #f5f5f5; border-radius: 8px; padding: 16px;">
  <div style="display: flex; flex-direction: column; gap: 12px;">
    <div>
      <span style="font-weight: 600; color: #555;">App Version:</span>
      <span style="margin-left: 8px;">{APP_VERSION}</span>
      {#if latestFeatureUpdate}
        <span style="margin-left: 12px; font-size: 0.85em; color: #888; font-variant-numeric: tabular-nums;">Latest update: {latestFeatureUpdate}</span>
      {/if}
    </div>
    <div>
      <span style="font-weight: 600; color: #555;">Build:</span>
      <span style="margin-left: 8px; font-family: monospace; background: #e0e0e0; padding: 2px 6px; border-radius: 4px;">{BUILD_ID}</span>
      {#if BUILD_TIME}
        <span style="margin-left: 8px; color: #888; font-size: 0.9em;">({BUILD_TIME})</span>
      {/if}
    </div>
    <div>
      <span style="font-weight: 600; color: #555; display: block; margin-bottom: 8px;">Feature Versions:</span>
      <div style="font-family: monospace; font-size: 0.85em; background: #e8e8e8; padding: 12px; border-radius: 6px; overflow-x: auto;">
        {#each Object.entries(FEATURE_VERSIONS) as [feature, { v, date }]}
          <div style="display: grid; grid-template-columns: 1fr 48px 80px; gap: 8px; padding: 3px 0; align-items: baseline;">
            <span style="color: #555; text-align: right;">{feature}</span>
            <span style="color: #333; font-weight: 500; font-variant-numeric: tabular-nums;">v{v}</span>
            <span style="color: #999; font-size: 0.9em; font-variant-numeric: tabular-nums;">{date || ''}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>
