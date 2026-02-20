<script>
  import { auth, db } from '$lib/firebase.js';
  import { collection, query, where, orderBy, limit, getDocs, getDoc, doc, setDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { browser } from '$app/environment';
  import { isDraftStale, getDraftAgeText, isValidDayIndex, isDraftExpired } from '$lib/workoutDraft.js';
  import { TONNAGE_TRACKING_NOTE } from '$lib/uiCopy.js';

  let currentUser = $state(null);
  let userRole = $state(null);
  let recentSessions = $state([]);
  let assignedPrograms = $state([]);
  let loading = $state(true);

  // Toast notification state
  let toastMessage = $state('');
  let toastType = $state('error');

  // Active draft state
  let activeDraft = $state(null);
  let showDiscardConfirm = $state(false);
  let showContinueModal = $state(false);
  let expiredMessage = $state(''); // Brief message when draft auto-discarded

  // Tonnage stats
  let monthTonnage = $state(null); // null = loading, number = loaded
  let yearTonnage = $state(null);

  // Tonnage equivalency tiers (year tonnage in lbs)
  const tonnageTiers = [
    { min: 0, max: 1000, nameSingular: 'Shaq', namePlural: 'Shaqs', refWeight: 325, tooltip: "Shaquille O'Neal's listed playing weight was 325 lbs." },
    { min: 1001, max: 5000, nameSingular: 'Formula 1 car', namePlural: 'Formula 1 cars', refWeight: 1600, tooltip: 'A modern Formula 1 car weighs about 1,600 lbs including the driver.' },
    { min: 5001, max: 15000, special: 'bears', refWeight: 13033.2, tooltip: '53 players × ~246 lb average ≈ 13,033 lbs total team weight.' },
    { min: 15001, max: 30000, nameSingular: 'compact car', namePlural: 'compact cars', refWeight: 3000, tooltip: 'A compact car weighs roughly 3,000 lbs.' },
    { min: 30001, max: 75000, nameSingular: 'heavy semi truck', namePlural: 'heavy semi trucks', refWeight: 25000, tooltip: 'An empty heavy-duty semi truck weighs about 25,000 lbs. In 2024, approximately 11.27 billion tons of freight were moved in the U.S.' },
    { min: 75001, max: 150000, nameSingular: 'tower ladder', namePlural: 'tower ladders', refWeight: 80000, tooltip: 'A fully loaded tower ladder can weigh up to 80,000 lbs. It extends aerial platforms for rescue and can flow up to 2,000 gallons of water per minute — about 1,000× a typical shower head.' },
    { min: 150001, max: 300000, nameSingular: 'Boeing 737', namePlural: 'Boeing 737s', refWeight: 90000, tooltip: 'A Boeing 737 weighs roughly 90,000 lbs empty.' },
    { min: 300001, max: 600000, nameSingular: 'blue whale', namePlural: 'blue whales', refWeight: 300000, tooltip: 'A blue whale can weigh up to 300,000 lbs — the largest animal on Earth.' },
    { min: 600001, max: 1500000, nameSingular: 'International Space Station', namePlural: 'International Space Stations', refWeight: 992080, tooltip: 'The International Space Station weighs about 992,080 lbs and orbits Earth at ~17,500 mph.' },
    { min: 1500001, max: Infinity, nameSingular: 'Giant Sequoia', namePlural: 'Giant Sequoias', refWeight: 2700000, tooltip: 'The General Sherman Tree is the largest tree on Earth by volume. Learn more: https://www.nps.gov/seki/learn/nature/sherman.htm' }
  ];

  // Tooltip state for mobile tap
  let showEquivTooltip = $state(false);

  // Animation state for equivalency updates
  let animateEquivalency = $state(false);
  let animationTimeout = null;
  let lastEquivKey = null; // Track changes (non-reactive, null = never set)

  // Tier burst animation state (Ascension Burst)
  // Main burst (container/ring) runs ~1.5s; particles run ~7s to match sound duration
  let animateTierBurst = $state(false);
  let animateTierParticles = $state(false);
  let tierBurstTimeout = null;
  let tierParticlesTimeout = null;

  // Subtle entry animation state (plays on Home entry if user has seen tier-up before)
  let hasTierUpCelebrated = $state(false);
  let animateSubtleEntry = $state(false);
  let subtleEntryTimeout = null;

  function getEquivalencyData(tonnageLbs) {
    if (!tonnageLbs || tonnageLbs <= 0) return null;

    // Find the matching tier and its index
    const tierIndex = tonnageTiers.findIndex(t => tonnageLbs >= t.min && tonnageLbs <= t.max);
    if (tierIndex === -1) return null;

    const tier = tonnageTiers[tierIndex];
    const tierNumber = tierIndex + 1; // 1-10

    // Calculate ratio
    let ratio = tonnageLbs / tier.refWeight;
    let rounded = Math.round(ratio * 10) / 10;
    if (rounded < 0.1) rounded = 0.1;

    // Format with 1 decimal
    const formatted = rounded.toFixed(1);

    // Build display text
    let text;
    let label;
    if (tier.special === 'bears') {
      label = 'Chicago Bears roster';
      text = `You've lifted the entire Chicago Bears roster ~${formatted} times`;
    } else {
      label = rounded === 1.0 ? tier.nameSingular : tier.namePlural;
      text = `You've lifted ~${formatted} ${label}`;
    }

    return { text, tooltip: tier.tooltip, tierNumber, rounded, label };
  }

  // Derived equivalency key for animation tracking (pure computation)
  let equivKey = $derived(() => {
    if (!yearTonnage || yearTonnage <= 0) return '';
    const data = getEquivalencyData(yearTonnage);
    if (!data) return '';
    return `${data.tierNumber}|${data.rounded}|${data.label}`;
  });

  // Effect to trigger animation when equivKey changes (including initial render)
  $effect(() => {
    const currentKey = equivKey;
    if (!currentKey) return;

    // Trigger animation on initial render OR when key changes
    if (lastEquivKey === null || currentKey !== lastEquivKey) {
      // Clear any existing timeout
      if (animationTimeout) clearTimeout(animationTimeout);
      animateEquivalency = true;
      animationTimeout = setTimeout(() => {
        animateEquivalency = false;
      }, 1700); // delay (200ms) + duration (1500ms)
    }
    lastEquivKey = currentKey;

    // Cleanup on effect rerun/unmount
    return () => {
      if (animationTimeout) clearTimeout(animationTimeout);
    };
  });

  // Tier burst animation: hover-intent (500ms) + tap triggered with rate limiting
  const BURST_DURATION_MS = 1550; // main burst (container/ring) duration + buffer
  const PARTICLE_DURATION_MS = 3600; // particles persist for 3.5s + buffer
  const BURST_COOLDOWN_MS = 5000; // cooldown after main burst ends
  const HOVER_INTENT_MS = 500; // hover must persist this long to trigger
  let cooldownUntilMs = 0;
  let hoverIntentTimerId = null;

  // Burst sound using HTMLAudioElement (must be triggered by user gesture)
  let burstAudio = null;
  let soundStatus = $state(null); // null | "played" | "blocked" (TEMP debug)
  let soundStatusTimeout = null;

  function setSoundStatus(status) {
    if (soundStatusTimeout) clearTimeout(soundStatusTimeout);
    soundStatus = status;
    soundStatusTimeout = setTimeout(() => {
      soundStatus = null;
    }, status === 'blocked' ? 2000 : 1500);
  }

  function playBurstSound() {
    try {
      if (!burstAudio) {
        burstAudio = new Audio('/sfx/xbox-rare-achievement.mp3');
        burstAudio.preload = 'auto';
        burstAudio.volume = 0.35;
      }
      burstAudio.pause();
      burstAudio.currentTime = 0;
      const p = burstAudio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          setSoundStatus('played');
        }).catch(() => {
          setSoundStatus('blocked');
        });
      } else {
        // No promise (older browsers) - assume played
        setSoundStatus('played');
      }
    } catch (e) {
      setSoundStatus('blocked');
    }
  }

  function attemptTierBurst(playSound = false) {
    const now = Date.now();
    if (animateTierBurst) return false;
    if (now < cooldownUntilMs) return false;

    // Trigger main burst (container/ring) and particles separately
    animateTierBurst = true;
    animateTierParticles = true;

    // Play celebratory sound only if requested (must be in user gesture stack)
    if (playSound) {
      playBurstSound();
    }

    // Main burst ends after ~1.5s
    if (tierBurstTimeout) clearTimeout(tierBurstTimeout);
    tierBurstTimeout = setTimeout(() => {
      animateTierBurst = false;
    }, BURST_DURATION_MS);

    // Particles persist for full sound duration (~7s)
    if (tierParticlesTimeout) clearTimeout(tierParticlesTimeout);
    tierParticlesTimeout = setTimeout(() => {
      animateTierParticles = false;
    }, PARTICLE_DURATION_MS);

    // Set cooldown: main burst end + 5s (don't wait for particles)
    cooldownUntilMs = now + BURST_DURATION_MS + BURST_COOLDOWN_MS;

    // Set hasTierUpCelebrated flag (enables subtle entry animation on future visits)
    if (currentUser && !hasTierUpCelebrated) {
      hasTierUpCelebrated = true;
      const currentYearKey = String(new Date().getFullYear());
      const flagsRef = doc(db, 'user', currentUser.uid, 'stats', 'uiFlags');
      setDoc(flagsRef, { yearKey: currentYearKey, hasTierUpCelebrated: true }, { merge: true }).catch(e => {
        console.error('Could not save UI flags:', e);
      });
    }

    return true;
  }

  function handleTierMouseEnter() {
    // Clear any existing timer
    if (hoverIntentTimerId) clearTimeout(hoverIntentTimerId);
    // Start 500ms hover-intent timer - triggers burst + sound if user stays
    hoverIntentTimerId = setTimeout(() => {
      hoverIntentTimerId = null;
      attemptTierBurst(true); // Burst + sound after 500ms hover
    }, HOVER_INTENT_MS);
  }

  function handleTierMouseLeave() {
    // Cancel hover-intent if user leaves before 500ms
    if (hoverIntentTimerId) {
      clearTimeout(hoverIntentTimerId);
      hoverIntentTimerId = null;
    }
  }

  function handleTierTap(e) {
    // Mobile tap reliability: pointerup fires reliably on touch devices
    // Prevent double-firing with click by checking pointer type
    if (e.pointerType === 'touch') {
      e.preventDefault(); // Prevent subsequent click event
      attemptTierBurst(true); // Play sound on tap
    }
  }

  function handleTierClick(e) {
    // Desktop click or keyboard - skip if already handled by pointerup (touch)
    if (e.pointerType === 'touch') return;
    attemptTierBurst(true); // Play sound on click
  }

  function loadActiveDraft() {
    if (!browser || !currentUser) return;
    try {
      const key = `activeWorkoutDraft:${currentUser.uid}`;
      const raw = localStorage.getItem(key);
      if (raw) {
        activeDraft = JSON.parse(raw);
      } else {
        activeDraft = null;
      }
    } catch (e) {
      activeDraft = null;
    }
  }

  function clearActiveDraft() {
    if (!browser || !currentUser) return;
    localStorage.removeItem(`activeWorkoutDraft:${currentUser.uid}`);
    activeDraft = null;
    showDiscardConfirm = false;
    showContinueModal = false;
  }

  function handleContinueClick() {
    // Check if draft is expired (>14 days) - auto-discard without modal
    if (activeDraft && isDraftExpired(activeDraft)) {
      clearActiveDraft();
      expiredMessage = 'Your active workout expired after 14 days and was discarded.';
      setTimeout(() => { expiredMessage = ''; }, 5000);
      return;
    }
    // Not expired - show normal modal
    showContinueModal = true;
  }

  function handleContinueResume() {
    showContinueModal = false;
    if (activeDraft) {
      goto(`/programs/${activeDraft.programId}/workout/${activeDraft.dayIndex}`);
    }
  }

  function handleContinueDiscard() {
    clearActiveDraft();
    // Modal closes via clearActiveDraft, stay on Home
  }

  function getDraftLabel() {
    if (!activeDraft) return '';
    const programName = activeDraft.programName || 'Workout';
    const dayName = activeDraft.dayName || `Day ${(activeDraft.dayIndex || 0) + 1}`;
    return `${programName} — ${dayName}`;
  }

  function showToast(message, type = 'error') {
    toastMessage = message;
    toastType = type;
    setTimeout(() => { toastMessage = ''; }, 6000);
  }

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      currentUser = user;
      if (user) {
        // Resume last path on initial app load only (not on every Home click)
        if (browser && !sessionStorage.getItem('ael:resumed')) {
          sessionStorage.setItem('ael:resumed', '1');
          const lastPath = localStorage.getItem('ael:lastPath');
          if (lastPath && lastPath !== '/login' && lastPath !== '/') {
            goto(lastPath);
            return;
          }
        }
        try {
          const userDoc = await getDoc(doc(db, 'user', user.uid));
          if (userDoc.exists()) {
            userRole = userDoc.data().role;
          } else {
            console.error('User document not found');
            showToast('User profile not found. Please contact support.');
          }
        } catch (e) {
          console.error('Failed to fetch user role:', e.code, e.message);
          showToast(`Failed to load profile: ${e.message}`);
        }
        await loadRecentSessions();
        await loadAssignedPrograms();
        loadActiveDraft();
        loadTonnageStats();
        loadUiFlags();
      }
      loading = false;
    });
  });

  // Subtle entry animation: trigger when Home loads with tier visible and user has seen tier-up before
  $effect(() => {
    // Only trigger if flag is true and tier badge would be visible
    if (hasTierUpCelebrated && yearTonnage && yearTonnage > 0) {
      // Small delay to ensure UI is rendered
      setTimeout(() => {
        triggerSubtleEntryAnimation();
      }, 100);
    }
  });

  async function loadRecentSessions() {
    if (!currentUser) return;

    try {
      const sessionsQuery = query(
        collection(db, 'workoutSessions'),
        where('userId', '==', currentUser.uid),
        orderBy('finishedAt', 'desc'),
        limit(5)
      );
      const snapshot = await getDocs(sessionsQuery);
      recentSessions = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.error('Could not load sessions:', e.code, e.message);
      showToast(`Failed to load sessions: ${e.code} - ${e.message}`);
    }
  }

  async function loadAssignedPrograms() {
    if (!currentUser) return;

    try {
      // Use split queries based on role to avoid permission errors
      if (userRole === 'client') {
        // Client: query owned + assigned programs separately
        const ownedQuery = query(
          collection(db, 'programs'),
          where('createdByUserId', '==', currentUser.uid)
        );
        // Use canonical assignedToUids field for array-contains query
        const assignedQuery = query(
          collection(db, 'programs'),
          where('assignedToUids', 'array-contains', currentUser.uid)
        );

        const [ownedSnapshot, assignedSnapshot] = await Promise.all([
          getDocs(ownedQuery),
          getDocs(assignedQuery)
        ]);

        // Merge and dedupe
        const ownedPrograms = ownedSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        const assignedProgramsList = assignedSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        const merged = [...ownedPrograms, ...assignedProgramsList];
        const uniqueMap = new Map(merged.map(p => [p.id, p]));
        assignedPrograms = Array.from(uniqueMap.values());
      } else if (userRole === 'admin' || userRole === 'coach') {
        // Admin/Coach can query all programs
        const programsSnapshot = await getDocs(collection(db, 'programs'));
        assignedPrograms = programsSnapshot.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(p =>
            p.assignedToUids?.includes(currentUser.uid) ||
            p.assignedTo?.includes?.(currentUser.uid) ||
            p.assignedTo === currentUser.uid
          );
      } else {
        // Unknown role - don't query
        console.error('Unknown role, cannot load programs:', userRole);
        assignedPrograms = [];
      }
    } catch (e) {
      console.error('Could not load programs:', e.code, e.message);
      showToast(`Permission error: ${e.code} - ${e.message}`);
    }
  }

  async function loadTonnageStats() {
    if (!currentUser) return;

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // 1-12
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    const yearKey = `${year}`;

    try {
      const monthRef = doc(db, 'user', currentUser.uid, 'stats', `tonnage_${monthKey}`);
      const yearRef = doc(db, 'user', currentUser.uid, 'stats', `tonnage_${yearKey}`);

      const [monthSnap, yearSnap] = await Promise.all([
        getDoc(monthRef),
        getDoc(yearRef)
      ]);

      // Extract tonnage values, default to 0 if missing
      const monthData = monthSnap.exists() ? monthSnap.data() : null;
      const yearData = yearSnap.exists() ? yearSnap.data() : null;

      monthTonnage = (typeof monthData?.tonnage === 'number') ? monthData.tonnage : 0;
      yearTonnage = (typeof yearData?.tonnage === 'number') ? yearData.tonnage : 0;
    } catch (e) {
      console.error('Could not load tonnage stats:', e);
      // Set to 0 on error so UI doesn't show loading state forever
      monthTonnage = 0;
      yearTonnage = 0;
    }
  }

  async function loadUiFlags() {
    if (!currentUser) return;

    const currentYearKey = String(new Date().getFullYear());

    try {
      const flagsRef = doc(db, 'user', currentUser.uid, 'stats', 'uiFlags');
      const flagsSnap = await getDoc(flagsRef);

      if (!flagsSnap.exists()) {
        // No flags doc - create with current year, flag false
        hasTierUpCelebrated = false;
        setDoc(flagsRef, { yearKey: currentYearKey, hasTierUpCelebrated: false }, { merge: true }).catch(e => {
          console.error('Could not initialize UI flags:', e);
        });
      } else {
        const data = flagsSnap.data();
        const storedYearKey = data.yearKey;

        if (storedYearKey !== currentYearKey) {
          // Year changed - reset flag for new year
          hasTierUpCelebrated = false;
          setDoc(flagsRef, { yearKey: currentYearKey, hasTierUpCelebrated: false }, { merge: true }).catch(e => {
            console.error('Could not reset UI flags for new year:', e);
          });
        } else {
          // Same year - use stored flag
          hasTierUpCelebrated = data.hasTierUpCelebrated === true;
        }
      }
    } catch (e) {
      console.error('Could not load UI flags:', e);
      hasTierUpCelebrated = false;
    }
  }

  function triggerSubtleEntryAnimation() {
    if (!hasTierUpCelebrated) return;
    if (animateSubtleEntry) return;

    animateSubtleEntry = true;
    if (subtleEntryTimeout) clearTimeout(subtleEntryTimeout);
    subtleEntryTimeout = setTimeout(() => {
      animateSubtleEntry = false;
    }, 1050); // 1000ms duration + small buffer
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString();
  }
</script>

<h1>AthElites</h1>

{#if loading}
  <p>Loading...</p>
{:else if !currentUser}
  <div style="text-align: center; padding: 40px 0;">
    <h2>Welcome to AthElites</h2>
    <p style="color: #666; margin-bottom: 20px;">Your personal training companion</p>
    <a href="/login" style="display: inline-block; padding: 12px 24px; background: #4CAF50; color: white; text-decoration: none; border-radius: 5px;">
      Login / Sign Up
    </a>
  </div>
{:else}
  <!-- Active Draft Buttons -->
  {#if activeDraft}
    <div style="display: grid; gap: 10px; margin-bottom: 20px; padding: 15px; background: #e3f2fd; border-radius: 10px; border: 2px solid #2196F3;">
      <p style="margin: 0 0 5px 0; color: #1565c0; font-weight: 500; font-size: 0.9em;">Unfinished workout: {getDraftLabel()}</p>
      <button onclick={handleContinueClick} style="display: block; width: 100%; padding: 15px; background: #2196F3; color: white; border: none; border-radius: 8px; text-align: center; font-weight: bold; cursor: pointer; font-size: 1em;">
        Continue active workout
      </button>
      <button onclick={() => showDiscardConfirm = true} style="padding: 10px; background: transparent; color: #d32f2f; border: 1px solid #d32f2f; border-radius: 6px; cursor: pointer; font-size: 0.9em;">
        Discard active session
      </button>
    </div>
  {/if}

  <!-- Expired Draft Message (shown briefly after auto-discard) -->
  {#if expiredMessage}
    <div style="margin-bottom: 20px; padding: 12px 15px; background: #fff3e0; border: 1px solid #ff9800; border-radius: 8px; color: #e65100; font-size: 0.9em;">
      {expiredMessage}
    </div>
  {/if}

  <!-- Tonnage Stats -->
  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
    <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; text-align: center;">
      <p style="margin: 0 0 5px 0; color: #666; font-size: 0.85em;">Month Tonnage</p>
      <p style="margin: 0; font-size: 1.4em; font-weight: bold; color: #333;">
        {monthTonnage === null ? '—' : `${monthTonnage.toLocaleString()} lbs`}
      </p>
    </div>
    <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; text-align: center;">
      <p style="margin: 0 0 5px 0; color: #666; font-size: 0.85em;">Year Tonnage</p>
      <p style="margin: 0; font-size: 1.4em; font-weight: bold; color: #333;">
        {yearTonnage === null ? '—' : `${yearTonnage.toLocaleString()} lbs`}
      </p>
    </div>
  </div>

  <!-- Tonnage Equivalency (based on year tonnage) -->
  {#if yearTonnage && yearTonnage > 0}
    {@const equivData = getEquivalencyData(yearTonnage)}
    {#if equivData}
      <div class="equiv-container {animateEquivalency ? 'equiv-animate' : ''} {animateTierBurst ? 'tier-burst' : ''}">
        <div class="equiv-text-section">
          <span style="color: #555; font-size: 0.95em;">{equivData.text}</span>
          <span
            class="equiv-tooltip-trigger"
            role="button"
            tabindex="0"
            onclick={() => showEquivTooltip = !showEquivTooltip}
            onkeydown={(e) => e.key === 'Enter' && (showEquivTooltip = !showEquivTooltip)}
            onmouseenter={() => showEquivTooltip = true}
            onmouseleave={() => showEquivTooltip = false}
          >
            <span class="equiv-info-icon">i</span>
            {#if showEquivTooltip}
              <span class="equiv-tooltip">
                {#if equivData.tooltip.includes('https://')}
                  {@const parts = equivData.tooltip.split(/(https:\/\/\S+)/)}
                  {#each parts as part}
                    {#if part.startsWith('https://')}
                      <a href={part} target="_blank" rel="noopener noreferrer" style="color: #90caf9;">{part}</a>
                    {:else}
                      {part}
                    {/if}
                  {/each}
                {:else}
                  {equivData.tooltip}
                {/if}
              </span>
            {/if}
          </span>
        </div>
        <div class="tier-badge">
          <span
            class="tier-number {animateSubtleEntry ? 'subtle-entry' : ''}"
            role="button"
            tabindex="0"
            onmouseenter={handleTierMouseEnter}
            onmouseleave={handleTierMouseLeave}
            onpointerup={handleTierTap}
            onclick={handleTierClick}
            onkeydown={(e) => e.key === 'Enter' && handleTierClick(e)}
          >{equivData.tierNumber}</span>
          <span class="tier-label">out of 10 tiers</span>
          {#if soundStatus}
            <span class="sound-debug-status">sound: {soundStatus}</span>
          {/if}
          {#if animateTierParticles}
            <span class="burst-particle p1"></span>
            <span class="burst-particle p2"></span>
            <span class="burst-particle p3"></span>
            <span class="burst-particle p4"></span>
            <span class="burst-particle p5"></span>
            <span class="burst-particle p6"></span>
            <span class="burst-particle p7"></span>
            <span class="burst-particle p8"></span>
            <span class="burst-particle p9"></span>
            <span class="burst-particle p10"></span>
          {/if}
          <span class="radial-flash"></span>
        </div>
      </div>
    {/if}
  {:else if yearTonnage === 0}
    <p style="text-align: center; margin-bottom: 10px; color: #999; font-size: 0.9em;">Log a workout to see your equivalency!</p>
  {/if}

  <p style="margin: 0 0 20px 0; color: #999; font-size: 0.75em; text-align: center;">{TONNAGE_TRACKING_NOTE}</p>

  <!-- Quick Actions -->
  <div style="display: grid; gap: 10px; margin-bottom: 30px;">
    {#if assignedPrograms.length > 0}
      <a href="/programs" class="action-btn" style="display: block; padding: 20px; background: #4CAF50; color: white; text-decoration: none; border-radius: 8px; text-align: center;">
        <strong style="font-size: 1.2em;">Start Workout</strong>
        <p style="margin: 5px 0 0 0; opacity: 0.9;">{assignedPrograms.length} program{assignedPrograms.length !== 1 ? 's' : ''} available</p>
      </a>
    {:else if userRole === 'admin'}
      <a href="/programs" class="action-btn" style="display: block; padding: 20px; background: #2196F3; color: white; text-decoration: none; border-radius: 8px; text-align: center;">
        <strong style="font-size: 1.2em;">Manage Programs</strong>
        <p style="margin: 5px 0 0 0; opacity: 0.9;">Create and assign workouts</p>
      </a>
      <a href="/exercises" class="action-btn" style="display: block; padding: 20px; background: #ff9800; color: white; text-decoration: none; border-radius: 8px; text-align: center;">
        <strong style="font-size: 1.2em;">Exercise Library</strong>
        <p style="margin: 5px 0 0 0; opacity: 0.9;">Manage exercises</p>
      </a>
    {:else}
      <p style="color: #888; text-align: center; padding: 20px;">No programs assigned yet. Check back later!</p>
    {/if}
  </div>

  <!-- History & PRs -->
  <a href="/history" class="action-btn" style="display: block; padding: 15px; background: #f5f5f5; border-radius: 8px; text-align: center; text-decoration: none; color: #333; margin-bottom: 10px;">
    <strong>History & PRs</strong>
  </a>

  <!-- Profile -->
  <a href="/profile" class="action-btn" style="display: block; padding: 15px; background: #f5f5f5; border-radius: 8px; text-align: center; text-decoration: none; color: #333; margin-bottom: 20px;">
    <strong>Profile</strong>
  </a>

  <!-- Recent Workouts -->
  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
    <h2 style="margin: 0;">Recent Workouts</h2>
    <a href="/history" style="font-size: 0.9em; color: #667eea;">View All</a>
  </div>
  {#if recentSessions.length === 0}
    <p style="color: #888;">No workouts completed yet. Start your first workout!</p>
  {:else}
    <div style="display: grid; gap: 10px;">
      {#each recentSessions as session}
        <div style="border: 1px solid #ddd; padding: 15px; border-radius: 8px; background: #f9f9f9;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong>{session.dayName}</strong>
              <p style="margin: 3px 0 0 0; color: #666; font-size: 0.9em;">{session.programName}</p>
            </div>
            <div style="text-align: right;">
              <span style="color: #888; font-size: 0.85em;">{formatDate(session.finishedAt)}</span>
              {#if session.durationMinutes}
                <p style="margin: 3px 0 0 0; color: #666; font-size: 0.85em;">{session.durationMinutes} min</p>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}

{/if}

<!-- Continue Active Workout Modal (Resume/Discard choice) -->
{#if showContinueModal && activeDraft}
  {@const isStale = isDraftStale(activeDraft)}
  {@const ageText = getDraftAgeText(activeDraft)}
  {@const isCorrupted = !isValidDayIndex(activeDraft.dayIndex)}
  <div
    role="dialog"
    aria-modal="true"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2001;"
    onclick={(e) => { if (e.target === e.currentTarget) showContinueModal = false; }}
  >
    <div style="background: white; border-radius: 8px; padding: 20px; max-width: 90%; width: 340px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      {#if isCorrupted}
        <h3 style="margin: 0 0 12px 0; font-size: 1.1em; color: #d32f2f;">Corrupted workout draft</h3>
        <p style="margin: 0 0 20px 0; color: #666; font-size: 0.9em;">This active workout is missing its day reference and can't be resumed. Discard to start fresh.</p>
        <div style="display: flex; gap: 10px; justify-content: flex-end;">
          <button onclick={() => showContinueModal = false} style="padding: 8px 16px; background: #fff; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;">Cancel</button>
          <button onclick={handleContinueDiscard} style="padding: 8px 16px; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer;">Discard</button>
        </div>
      {:else}
        <h3 style="margin: 0 0 12px 0; font-size: 1.1em;">Pick up where you left off?</h3>
        <p style="margin: 0 0 {isStale ? '10px' : '20px'} 0; color: #666; font-size: 0.9em;">You have an unfinished workout: <strong>{getDraftLabel()}</strong>. Resume it, or discard to start fresh.</p>
        {#if isStale}
          <p style="margin: 0 0 20px 0; color: #e65100; font-size: 0.85em; background: #fff3e0; padding: 8px 12px; border-radius: 4px;">This workout is from {ageText} and may be out of date.</p>
        {/if}
        <div style="display: flex; gap: 10px; justify-content: flex-end;">
          <button onclick={handleContinueDiscard} style="padding: 8px 16px; background: {isStale ? '#d32f2f' : '#fff'}; color: {isStale ? 'white' : '#d32f2f'}; border: 1px solid #d32f2f; border-radius: 4px; cursor: pointer;">Discard</button>
          <button onclick={handleContinueResume} style="padding: 8px 16px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer;">Resume</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- Discard Confirmation Modal -->
{#if showDiscardConfirm}
  <div
    role="dialog"
    aria-modal="true"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2001;"
    onclick={(e) => { if (e.target === e.currentTarget) showDiscardConfirm = false; }}
  >
    <div style="background: white; border-radius: 8px; padding: 20px; max-width: 90%; width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <h3 style="margin: 0 0 12px 0; font-size: 1.1em;">Discard active workout?</h3>
      <p style="margin: 0 0 20px 0; color: #666; font-size: 0.9em;">This will permanently delete your unfinished workout on this device.</p>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button onclick={() => showDiscardConfirm = false} style="padding: 8px 16px; background: #fff; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;">Cancel</button>
        <button onclick={clearActiveDraft} style="padding: 8px 16px; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer;">Discard</button>
      </div>
    </div>
  </div>
{/if}

<!-- Toast notification -->
{#if toastMessage}
  <div style="position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: {toastType === 'error' ? '#f44336' : '#4CAF50'}; color: white; padding: 12px 24px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 2000; max-width: 90%; text-align: center;">
    {toastMessage}
  </div>
{/if}

<style>
  .action-btn {
    transition: filter 0.15s ease;
  }
  .action-btn:hover {
    filter: brightness(0.95);
  }
  .action-btn:active {
    filter: brightness(0.9);
  }

  /* Tonnage equivalency tooltip */
  .equiv-tooltip-trigger {
    position: relative;
    display: inline-block;
    cursor: pointer;
    margin-left: 4px;
    vertical-align: middle;
  }
  .equiv-info-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #bbb;
    color: white;
    font-size: 10px;
    font-weight: bold;
    font-style: italic;
    font-family: Georgia, serif;
  }
  .equiv-tooltip-trigger:hover .equiv-info-icon,
  .equiv-tooltip-trigger:focus .equiv-info-icon {
    background: #888;
  }
  .equiv-tooltip {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-bottom: 8px;
    padding: 10px 12px;
    background: #333;
    color: #fff;
    font-size: 0.8em;
    line-height: 1.4;
    border-radius: 6px;
    white-space: normal;
    width: 260px;
    max-width: 90vw;
    text-align: left;
    z-index: 1000;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
  }
  .equiv-tooltip::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 6px solid transparent;
    border-top-color: #333;
  }

  /* Equivalency container with tier badge */
  .equiv-container {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    margin-bottom: 10px;
  }
  .equiv-container.equiv-animate {
    animation: equiv-debug-pulse 1500ms ease-out;
    animation-delay: 200ms;
    animation-fill-mode: both;
  }

  /* DEBUG: Painfully obvious animation - will be scaled back later */
  @keyframes equiv-debug-pulse {
    0% {
      transform: scale(1) rotate(0deg);
      opacity: 1;
      outline: 3px solid transparent;
      box-shadow: none;
    }
    15% {
      transform: scale(1.25) rotate(-3deg);
      opacity: 0.9;
      outline: 3px solid #667eea;
      box-shadow: 0 0 20px rgba(102, 126, 234, 0.6);
    }
    35% {
      transform: scale(1.2) rotate(2deg);
      opacity: 0.9;
      outline: 3px solid #667eea;
      box-shadow: 0 0 25px rgba(102, 126, 234, 0.7);
    }
    55% {
      transform: scale(1.18) rotate(-2deg);
      opacity: 0.92;
      outline: 3px solid #667eea;
      box-shadow: 0 0 20px rgba(102, 126, 234, 0.5);
    }
    75% {
      transform: scale(1.1) rotate(1deg);
      opacity: 0.95;
      outline: 3px solid #667eea;
      box-shadow: 0 0 15px rgba(102, 126, 234, 0.3);
    }
    100% {
      transform: scale(1) rotate(0deg);
      opacity: 1;
      outline: 3px solid transparent;
      box-shadow: none;
    }
  }

  /* Tier Burst (Ascension Burst) Animation - 1500ms duration, synced to Xbox achievement sound */
  .equiv-container.tier-burst {
    animation: tier-burst-container 1500ms cubic-bezier(0.22, 0.61, 0.36, 1);
    animation-fill-mode: both;
  }

  @keyframes tier-burst-container {
    /* Phase 1: 0-8% (~120ms) - pre-ignite, tiny glow ramp */
    0% {
      transform: translateY(0) scale(1);
      filter: drop-shadow(0 0 0 transparent);
    }
    8% {
      transform: translateY(-2px) scale(1.03);
      filter: drop-shadow(0 0 6px rgba(102, 126, 234, 0.3));
    }
    /* Phase 2: 8-14% (~120-210ms) - main impact peak (sound hit) */
    14% {
      transform: translateY(-10px) scale(1.22);
      filter: drop-shadow(0 0 24px rgba(102, 126, 234, 0.85));
    }
    /* Phase 3: 14-25% (~210-375ms) - settle from impact */
    25% {
      transform: translateY(-6px) scale(1.08);
      filter: drop-shadow(0 0 16px rgba(102, 126, 234, 0.55));
    }
    /* Phase 4: 25-47% (~375-700ms) - gentle sustain during chime */
    47% {
      transform: translateY(-4px) scale(1.04);
      filter: drop-shadow(0 0 10px rgba(102, 126, 234, 0.35));
    }
    /* Phase 5: 47-100% (~700-1500ms) - smooth fade with tail */
    70% {
      transform: translateY(-2px) scale(1.02);
      filter: drop-shadow(0 0 5px rgba(102, 126, 234, 0.15));
    }
    100% {
      transform: translateY(0) scale(1);
      filter: drop-shadow(0 0 0 transparent);
    }
  }

  /* Tier badge needs relative positioning for particles */
  .tier-badge {
    position: relative;
  }

  /* Radial flash behind tier number - synced to sound hit */
  .radial-flash {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(102, 126, 234, 0.7) 0%, transparent 70%);
    transform: translate(-50%, -50%) scale(0);
    pointer-events: none;
    opacity: 0;
  }
  .tier-burst .radial-flash {
    animation: radial-flash-expand 1500ms cubic-bezier(0.22, 0.61, 0.36, 1);
    animation-fill-mode: both;
  }

  @keyframes radial-flash-expand {
    /* 0-8% (~120ms): pre-ignite, invisible */
    0% {
      transform: translate(-50%, -50%) scale(0);
      opacity: 0;
    }
    /* 8% (~120ms): start expanding on impact */
    8% {
      transform: translate(-50%, -50%) scale(1);
      opacity: 0.5;
    }
    /* 14% (~210ms): peak flash at sound hit */
    14% {
      transform: translate(-50%, -50%) scale(6);
      opacity: 0.8;
    }
    /* 30% (~450ms): fading out */
    30% {
      transform: translate(-50%, -50%) scale(9);
      opacity: 0.35;
    }
    /* 40% (~600ms): nearly gone */
    40% {
      transform: translate(-50%, -50%) scale(10);
      opacity: 0.1;
    }
    /* 50%+: fully faded */
    50%, 100% {
      transform: translate(-50%, -50%) scale(11);
      opacity: 0;
    }
  }

  /* Burst particles - 3.5s duration, smooth gravity, shimmer from 1.5-3s */
  .burst-particle {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #667eea;
    pointer-events: none;
    opacity: 0;
    will-change: transform, opacity, filter;
    /* Main flight animation (3.5s) + shimmer (starts at 1.5s, runs 1.5s) */
    animation:
      particle-flight 3500ms cubic-bezier(0.33, 0, 0.2, 1) both,
      particle-late-shimmer 1500ms ease-in-out 1500ms both;
  }

  /* Particle positions - tight horizontal, mid-ground gravity (max ~70vh)
     --x0, --y0: starting offset (small, near center)
     --dx, --dy: target radial offset (before gravity)
     --gEnd: final gravity drop in vh (mid-ground: 35-70vh) */
  .burst-particle.p1  { --x0: 8px;   --y0: 0px;    --dx: 70px;   --dy: 0px;    --gEnd: 38vh; }
  .burst-particle.p2  { --x0: 6px;   --y0: 5px;    --dx: 60px;   --dy: 25px;   --gEnd: 45vh; }
  .burst-particle.p3  { --x0: 2px;   --y0: 7px;    --dx: 18px;   --dy: 35px;   --gEnd: 55vh; }
  .burst-particle.p4  { --x0: -3px;  --y0: 8px;    --dx: -12px;  --dy: 42px;   --gEnd: 70vh; }
  .burst-particle.p5  { --x0: -6px;  --y0: 5px;    --dx: -55px;  --dy: 20px;   --gEnd: 42vh; }
  .burst-particle.p6  { --x0: -8px;  --y0: 0px;    --dx: -65px;  --dy: 0px;    --gEnd: 48vh; }
  .burst-particle.p7  { --x0: -5px;  --y0: -4px;   --dx: -50px;  --dy: -25px;  --gEnd: 52vh; }
  .burst-particle.p8  { --x0: -3px;  --y0: -8px;   --dx: -15px;  --dy: -38px;  --gEnd: 62vh; }
  .burst-particle.p9  { --x0: 3px;   --y0: -7px;   --dx: 20px;   --dy: -42px;  --gEnd: 65vh; }
  .burst-particle.p10 { --x0: 7px;   --y0: -5px;   --dx: 45px;   --dy: -20px;  --gEnd: 50vh; }

  @keyframes particle-flight {
    /* 0%: at starting position, invisible */
    0% {
      transform: translate(calc(-50% + var(--x0)), calc(-50% + var(--y0))) scale(1);
      opacity: 0;
    }
    /* 3% (~105ms): appear just before impact */
    3% {
      transform: translate(calc(-50% + var(--x0)), calc(-50% + var(--y0))) scale(1);
      opacity: 0.95;
    }
    /* 6% (~210ms): burst outward on impact */
    6% {
      transform: translate(
        calc(-50% + var(--x0) + var(--dx) * 0.4),
        calc(-50% + var(--y0) + var(--dy) * 0.4 + var(--gEnd) * 0.01)
      ) scale(1.08);
      opacity: 1;
    }
    /* 10% (~350ms): fast radial travel */
    10% {
      transform: translate(
        calc(-50% + var(--x0) + var(--dx) * 0.7),
        calc(-50% + var(--y0) + var(--dy) * 0.7 + var(--gEnd) * 0.025)
      ) scale(1.02);
      opacity: 1;
    }
    /* 15% (~525ms): radial nearly complete */
    15% {
      transform: translate(
        calc(-50% + var(--x0) + var(--dx) * 0.92),
        calc(-50% + var(--y0) + var(--dy) * 0.92 + var(--gEnd) * 0.05)
      ) scale(0.98);
      opacity: 1;
    }
    /* 22% (~770ms): radial settled, gravity building */
    22% {
      transform: translate(
        calc(-50% + var(--x0) + var(--dx)),
        calc(-50% + var(--y0) + var(--dy) + var(--gEnd) * 0.1)
      ) scale(0.95);
      opacity: 1;
    }
    /* 32% (~1120ms): smooth acceleration */
    32% {
      transform: translate(
        calc(-50% + var(--x0) + var(--dx) * 1.01),
        calc(-50% + var(--y0) + var(--dy) + var(--gEnd) * 0.2)
      ) scale(0.92);
      opacity: 0.98;
    }
    /* 43% (~1505ms): shimmer starts here */
    43% {
      transform: translate(
        calc(-50% + var(--x0) + var(--dx) * 1.02),
        calc(-50% + var(--y0) + var(--dy) + var(--gEnd) * 0.35)
      ) scale(0.9);
      opacity: 0.96;
    }
    /* 55% (~1925ms): steady fall */
    55% {
      transform: translate(
        calc(-50% + var(--x0) + var(--dx) * 1.02),
        calc(-50% + var(--y0) + var(--dy) + var(--gEnd) * 0.5)
      ) scale(0.88);
      opacity: 0.94;
    }
    /* 68% (~2380ms): deeper fall */
    68% {
      transform: translate(
        calc(-50% + var(--x0) + var(--dx) * 1.03),
        calc(-50% + var(--y0) + var(--dy) + var(--gEnd) * 0.68)
      ) scale(0.85);
      opacity: 0.92;
    }
    /* 80% (~2800ms): approaching end */
    80% {
      transform: translate(
        calc(-50% + var(--x0) + var(--dx) * 1.03),
        calc(-50% + var(--y0) + var(--dy) + var(--gEnd) * 0.85)
      ) scale(0.82);
      opacity: 0.9;
    }
    /* 86% (~3010ms): start fading */
    86% {
      transform: translate(
        calc(-50% + var(--x0) + var(--dx) * 1.04),
        calc(-50% + var(--y0) + var(--dy) + var(--gEnd) * 0.92)
      ) scale(0.8);
      opacity: 0.7;
    }
    /* 100% (~3500ms): fade out */
    100% {
      transform: translate(
        calc(-50% + var(--x0) + var(--dx) * 1.04),
        calc(-50% + var(--y0) + var(--dy) + var(--gEnd))
      ) scale(0.75);
      opacity: 0;
    }
  }

  /* Shimmer from 1.5s to 3s - twinkle/sparkle effect
     Uses only filter to avoid conflicting with flight animation's transform */
  @keyframes particle-late-shimmer {
    0% { filter: brightness(1); }
    10% { filter: brightness(1.6); }
    20% { filter: brightness(1); }
    35% { filter: brightness(1.7); }
    45% { filter: brightness(1.1); }
    60% { filter: brightness(1.5); }
    70% { filter: brightness(1); }
    85% { filter: brightness(1.4); }
    100% { filter: brightness(0.9); }
  }

  /* Stagger particle timing slightly for organic feel */
  .burst-particle.p2  { animation-delay: 15ms, 1515ms; }
  .burst-particle.p3  { animation-delay: 30ms, 1530ms; }
  .burst-particle.p4  { animation-delay: 10ms, 1510ms; }
  .burst-particle.p5  { animation-delay: 40ms, 1540ms; }
  .burst-particle.p6  { animation-delay: 20ms, 1520ms; }
  .burst-particle.p7  { animation-delay: 12ms, 1512ms; }
  .burst-particle.p8  { animation-delay: 35ms, 1535ms; }
  .burst-particle.p9  { animation-delay: 18ms, 1518ms; }
  .burst-particle.p10 { animation-delay: 25ms, 1525ms; }

  .equiv-text-section {
    text-align: center;
    flex: 1;
    min-width: 0;
  }
  .tier-badge {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-width: 60px;
  }
  .tier-number {
    font-size: 2.4rem;
    font-weight: 700;
    color: #667eea;
    line-height: 1;
    cursor: pointer;
  }

  /* Subtle entry animation - gentle glow + micro shake */
  .tier-number.subtle-entry {
    animation: subtle-tier-pulse 1000ms ease-out;
  }

  @keyframes subtle-tier-pulse {
    0% {
      transform: scale(1) translateX(0);
      text-shadow: 0 0 0 transparent;
    }
    15% {
      transform: scale(1.02) translateX(-1px);
      text-shadow: 0 0 8px rgba(102, 126, 234, 0.5);
    }
    30% {
      transform: scale(1.03) translateX(1px);
      text-shadow: 0 0 12px rgba(102, 126, 234, 0.6);
    }
    50% {
      transform: scale(1.02) translateX(-0.5px);
      text-shadow: 0 0 10px rgba(102, 126, 234, 0.5);
    }
    70% {
      transform: scale(1.01) translateX(0.5px);
      text-shadow: 0 0 6px rgba(102, 126, 234, 0.3);
    }
    100% {
      transform: scale(1) translateX(0);
      text-shadow: 0 0 0 transparent;
    }
  }

  .tier-label {
    font-size: 0.75rem;
    color: #888;
    white-space: nowrap;
  }

  /* TEMP debug status for sound playback */
  .sound-debug-status {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: 4px;
    font-size: 0.65rem;
    color: #888;
    background: #f0f0f0;
    padding: 2px 6px;
    border-radius: 3px;
    white-space: nowrap;
  }

  /* Mobile responsive: stack on very small screens */
  @media (max-width: 360px) {
    .equiv-container {
      flex-direction: column;
      gap: 8px;
    }
    .tier-badge {
      flex-direction: row;
      gap: 6px;
    }
    .tier-number {
      font-size: 1.8rem;
    }
  }
</style>