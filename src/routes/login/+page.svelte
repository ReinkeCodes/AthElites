<script>
  import { auth, db } from '$lib/firebase.js';
  import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
  import { doc, setDoc } from 'firebase/firestore';
  import { goto } from '$app/navigation';

  let email = $state('');
  let password = $state('');
  let error = $state('');
  let loading = $state(false);
  let showPassword = $state(false);

  async function login(e) {
    e.preventDefault();
    error = '';
    loading = true;
    try {
      await signInWithEmailAndPassword(auth, email, password);
      goto('/');
    } catch (err) {
      error = err.message;
    }
    loading = false;
  }

  async function signup() {
    error = '';
    loading = true;
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      // Save user to Firestore with default role "client"
      await setDoc(doc(db, 'user', userCredential.user.uid), {
        email: email,
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

<h1>AthElites Login</h1>

{#if error}
  <p style="color: red;">{error}</p>
{/if}

<form onsubmit={login}>
  <label>
    Email:
    <input type="email" bind:value={email} required />
  </label>

  <label>
    Password:
    <input type={showPassword ? 'text' : 'password'} bind:value={password} required />
    <button type="button" onclick={() => showPassword = !showPassword}>
      {showPassword ? 'Hide' : 'Show'}
    </button>
  </label>

  <button type="submit" disabled={loading}>Login</button>
  <button type="button" onclick={signup} disabled={loading}>Sign Up</button>
</form>
