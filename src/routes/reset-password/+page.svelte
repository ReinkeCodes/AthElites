<script>
  import { auth } from '$lib/firebase.js';
  import { sendPasswordResetEmail } from 'firebase/auth';
  import { onDestroy } from 'svelte';

  const STORAGE_KEY = 'ae:lastResetEmail';
  const COOLDOWN_SECONDS = 45;

  let email = $state((typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY)) || '');
  let error = $state('');
  let loading = $state(false);
  let success = $state(false);
  let submittedEmail = $state('');
  let cooldown = $state(0);
  let cooldownInterval = $state(null);

  onDestroy(() => {
    if (cooldownInterval) clearInterval(cooldownInterval);
  });

  function formatCooldown(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  function startCooldown() {
    cooldown = COOLDOWN_SECONDS;
    if (cooldownInterval) clearInterval(cooldownInterval);
    cooldownInterval = setInterval(() => {
      cooldown--;
      if (cooldown <= 0) {
        clearInterval(cooldownInterval);
        cooldownInterval = null;
      }
    }, 1000);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    error = '';

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      error = 'Please enter an email address.';
      return;
    }

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      error = 'Please enter a valid email address.';
      return;
    }

    loading = true;
    localStorage.setItem(STORAGE_KEY, trimmedEmail);

    try {
      await sendPasswordResetEmail(auth, trimmedEmail);
      submittedEmail = trimmedEmail;
      success = true;
      startCooldown();
    } catch (err) {
      // Generic error - don't reveal account existence
      error = "Couldn't send reset email. Please try again.";
    }

    loading = false;
  }

  async function handleResend() {
    if (cooldown > 0) return;
    error = '';
    loading = true;

    try {
      await sendPasswordResetEmail(auth, submittedEmail);
      startCooldown();
    } catch (err) {
      error = "Couldn't send reset email. Please try again.";
    }

    loading = false;
  }

  function useDifferentEmail() {
    success = false;
    error = '';
  }
</script>

<h1>AthElites</h1>
<h2>Reset password</h2>

{#if error}
  <p style="color: red; background: #ffebee; padding: 10px; border-radius: 5px; margin-bottom: 15px;">{error}</p>
{/if}

{#if success}
  <div style="background: #e8f5e9; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
    <p style="color: #2e7d32; font-size: 1.1em; margin: 0 0 10px 0;">
      ✅ If an account exists for <strong>{submittedEmail}</strong>, we sent a reset link.
    </p>
    <p style="color: #555; margin: 0 0 8px 0;">Check your inbox and spam/junk folder.</p>
    <p style="color: #555; margin: 0;">Consider saving your new password in a password manager.</p>
  </div>

  <div style="display: flex; flex-direction: column; gap: 10px;">
    <button
      onclick={handleResend}
      disabled={loading || cooldown > 0}
      style="width: 100%; padding: 12px; background: {cooldown > 0 ? '#ccc' : '#4CAF50'}; color: white; border: none; cursor: {cooldown > 0 ? 'not-allowed' : 'pointer'}; font-size: 1em; border-radius: 4px;"
    >
      {#if loading}
        Sending...
      {:else if cooldown > 0}
        Resend available in {formatCooldown(cooldown)}
      {:else}
        Resend link
      {/if}
    </button>

    <button
      onclick={useDifferentEmail}
      style="width: 100%; padding: 12px; background: transparent; color: #2196F3; border: 1px solid #2196F3; cursor: pointer; font-size: 1em; border-radius: 4px;"
    >
      Use a different email
    </button>
  </div>
{:else}
  <form onsubmit={handleSubmit}>
    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px;">Email:</label>
      <input
        type="email"
        bind:value={email}
        placeholder="Enter your email"
        required
        style="width: 100%; padding: 10px; box-sizing: border-box;"
      />
    </div>

    <button
      type="submit"
      disabled={loading}
      style="width: 100%; padding: 12px; background: #4CAF50; color: white; border: none; cursor: pointer; font-size: 1em; border-radius: 4px;"
    >
      {loading ? 'Sending...' : 'Send reset link'}
    </button>
  </form>
{/if}

<p style="text-align: center; margin-top: 20px;">
  <a href="/login" style="color: #2196F3; text-decoration: underline;">Back to log in</a>
</p>
