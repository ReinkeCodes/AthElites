<script>
  import { auth, db } from '$lib/firebase.js';
  import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
  import { doc, setDoc } from 'firebase/firestore';
  import { goto } from '$app/navigation';

  let email = $state('');
  let password = $state('');
  let displayName = $state('');
  let error = $state('');
  let loading = $state(false);
  let showPassword = $state(false);
  let isSignupMode = $state(false);

  function getLoginErrorMessage(err) {
    const invalidCredentialCodes = [
      'auth/wrong-password',
      'auth/user-not-found',
      'auth/invalid-credential',
      'auth/invalid-email'
    ];
    if (invalidCredentialCodes.includes(err.code)) {
      return 'Invalid email/username or password.';
    }
    return 'Login failed. Please try again.';
  }

  function clearError() {
    if (error) error = '';
  }

  async function login(e) {
    e.preventDefault();
    error = '';
    loading = true;
    try {
      await signInWithEmailAndPassword(auth, email, password);
      goto('/');
    } catch (err) {
      error = getLoginErrorMessage(err);
    }
    loading = false;
  }

  async function signup(e) {
    e.preventDefault();
    if (!displayName.trim()) {
      error = 'Please enter your name';
      return;
    }
    error = '';
    loading = true;
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      // Save user to Firestore with default role "client"
      await setDoc(doc(db, 'user', userCredential.user.uid), {
        email: email,
        displayName: displayName.trim(),
        role: 'client',
        createdAt: new Date()
      });
      goto('/');
    } catch (err) {
      error = err.message;
    }
    loading = false;
  }
</script>

<h1>AthElites</h1>

{#if error}
  <p style="color: red; background: #ffebee; padding: 10px; border-radius: 5px;">{error}</p>
{/if}

{#if isSignupMode}
  <!-- Sign Up Form -->
  <h2>Create Account</h2>
  <form onsubmit={signup}>
    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px;">Your Name:</label>
      <input type="text" bind:value={displayName} placeholder="e.g. John Smith" required style="width: 100%; padding: 10px; box-sizing: border-box;" />
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px;">Email:</label>
      <input type="email" bind:value={email} required style="width: 100%; padding: 10px; box-sizing: border-box;" />
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px;">Password:</label>
      <div style="display: flex; gap: 10px;">
        <input type={showPassword ? 'text' : 'password'} bind:value={password} required style="flex: 1; padding: 10px;" />
        <button type="button" onclick={() => showPassword = !showPassword} style="padding: 10px;">
          {showPassword ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>

    <button type="submit" disabled={loading} style="width: 100%; padding: 12px; background: #4CAF50; color: white; border: none; cursor: pointer; font-size: 1em;">
      {loading ? 'Creating Account...' : 'Create Account'}
    </button>
  </form>

  <p style="text-align: center; margin-top: 20px;">
    Already have an account?
    <button onclick={() => isSignupMode = false} style="background: none; border: none; color: #2196F3; cursor: pointer; text-decoration: underline;">
      Login
    </button>
  </p>
{:else}
  <!-- Login Form -->
  <h2>Login</h2>
  <form onsubmit={login}>
    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px;">Email:</label>
      <input type="email" bind:value={email} oninput={clearError} required style="width: 100%; padding: 10px; box-sizing: border-box;" />
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px;">Password:</label>
      <div style="display: flex; gap: 10px;">
        <input type={showPassword ? 'text' : 'password'} bind:value={password} oninput={clearError} required style="flex: 1; padding: 10px;" />
        <button type="button" onclick={() => showPassword = !showPassword} style="padding: 10px;">
          {showPassword ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>

    <button type="submit" disabled={loading} style="width: 100%; padding: 12px; background: #4CAF50; color: white; border: none; cursor: pointer; font-size: 1em;">
      {loading ? 'Logging in...' : 'Login'}
    </button>
  </form>

  <p style="text-align: center; margin-top: 20px;">
    Don't have an account?
    <button onclick={() => isSignupMode = true} style="background: none; border: none; color: #2196F3; cursor: pointer; text-decoration: underline;">
      Sign Up
    </button>
  </p>
{/if}
