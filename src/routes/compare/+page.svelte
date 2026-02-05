<script>
  import { auth, db } from '$lib/firebase.js';
  import { doc, getDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';

  let loading = $state(true);

  // Pane A state
  let paneA = $state({ sourceType: null, localUrl: null, fileName: null, youtubeId: null, error: null });
  let paneAYoutubeInput = $state('');
  let videoA = $state(null);
  let trimA = $state({ in: 0, out: 0, duration: 0 });
  let trimATrack = $state(null);
  let trimADragging = $state(null); // 'in' | 'out' | null
  let rateA = $state(1);

  // Pane B state
  let paneB = $state({ sourceType: null, localUrl: null, fileName: null, youtubeId: null, error: null });
  let paneBYoutubeInput = $state('');
  let videoB = $state(null);
  let trimB = $state({ in: 0, out: 0, duration: 0 });
  let trimBTrack = $state(null);
  let trimBDragging = $state(null); // 'in' | 'out' | null
  let rateB = $state(1);

  // YouTube IFrame API state
  let ytApiLoading = false;
  let ytPlayerA = $state(null);
  let ytPlayerB = $state(null);
  let ytReadyA = $state(false);
  let ytReadyB = $state(false);
  let ytDurationA = $state(0);
  let ytDurationB = $state(0);

  // Shared controls state
  let isPlaying = $state(false);
  let currentTime = $state(0);
  let maxDuration = $state(0);
  let loopEnabled = $state(false);

  // Check if both panes have local videos loaded
  function getBothLocalLoaded() {
    return paneA.sourceType === 'local' && paneA.localUrl &&
           paneB.sourceType === 'local' && paneB.localUrl;
  }

  // Check if both panes have valid trims (duration > 0 means trim is initialized)
  function getTrimsValid() {
    return getBothLocalLoaded() && trimA.duration > 0 && trimB.duration > 0;
  }

  // Check if one pane is Local and the other is YouTube (mixed mode)
  function getMixedMode() {
    const aLocal = paneA.sourceType === 'local' && paneA.localUrl;
    const bLocal = paneB.sourceType === 'local' && paneB.localUrl;
    const aYT = paneA.sourceType === 'youtube' && paneA.youtubeId;
    const bYT = paneB.sourceType === 'youtube' && paneB.youtubeId;
    if (aLocal && bYT) return { localPane: 'A', ytPane: 'B' };
    if (bLocal && aYT) return { localPane: 'B', ytPane: 'A' };
    return null;
  }

  // Check if master controls should be visible
  function getMasterControlsVisible() {
    return getBothLocalLoaded() || getMixedMode() !== null;
  }

  // Check if scrubber is usable in mixed mode
  function getMixedScrubberEnabled() {
    const mixed = getMixedMode();
    if (!mixed) return false;
    const localTrim = mixed.localPane === 'A' ? trimA : trimB;
    const ytReady = mixed.ytPane === 'A' ? ytReadyA : ytReadyB;
    const ytDur = mixed.ytPane === 'A' ? ytDurationA : ytDurationB;
    return localTrim.duration > 0 && ytReady && ytDur > 0;
  }

  // Get the master segment length (rate-aware: min of effective durations)
  function getMasterSegmentLen() {
    const mixed = getMixedMode();
    if (mixed) {
      const localTrim = mixed.localPane === 'A' ? trimA : trimB;
      const localRate = mixed.localPane === 'A' ? rateA : rateB;
      const ytDur = mixed.ytPane === 'A' ? ytDurationA : ytDurationB;
      const safeRate = localRate > 0 ? localRate : 1;
      const localEffective = localTrim.duration > 0
        ? Math.max(0, localTrim.out - localTrim.in) / safeRate
        : 0;
      if (localEffective <= 0 || ytDur <= 0) return 0;
      return Math.min(localEffective, ytDur);
    }
    if (!getTrimsValid()) return maxDuration;
    const safeRateA = rateA > 0 ? rateA : 1;
    const safeRateB = rateB > 0 ? rateB : 1;
    const effectiveA = Math.max(0, trimA.out - trimA.in) / safeRateA;
    const effectiveB = Math.max(0, trimB.out - trimB.in) / safeRateB;
    return Math.min(effectiveA, effectiveB);
  }

  // Get the scrubber max value
  function getScrubberMax() {
    if (getMixedMode()) {
      return getMixedScrubberEnabled() ? getMasterSegmentLen() : 0;
    }
    return getTrimsValid() ? getMasterSegmentLen() : maxDuration;
  }

  // Update max duration when videos are loaded
  function updateMaxDuration() {
    if (videoA && videoB && !isNaN(videoA.duration) && !isNaN(videoB.duration)) {
      maxDuration = Math.min(videoA.duration, videoB.duration);
    }
  }

  const PLAY_END_EPSILON = 0.05;

  // Shared play/pause
  function togglePlayPause() {
    if (!videoA || !videoB) return;

    if (isPlaying) {
      videoA.pause();
      videoB.pause();
      isPlaying = false;
    } else {
      // Check if we need to restart from trim start
      if (getTrimsValid()) {
        const masterLen = getMasterSegmentLen();
        const safeRateA = rateA > 0 ? rateA : 1;
        const safeRateB = rateB > 0 ? rateB : 1;
        const atEnd = currentTime >= masterLen - PLAY_END_EPSILON;
        const aOutOfBounds = videoA.currentTime < trimA.in || videoA.currentTime > trimA.out;
        const bOutOfBounds = videoB.currentTime < trimB.in || videoB.currentTime > trimB.out;

        if (atEnd || aOutOfBounds || bOutOfBounds) {
          // Restart from trim starts
          currentTime = 0;
          videoA.currentTime = trimA.in;
          videoB.currentTime = trimB.in;
        } else {
          // Sync both videos to current compare-time before playing
          videoA.currentTime = trimA.in + currentTime * safeRateA;
          videoB.currentTime = trimB.in + currentTime * safeRateB;
        }
      }

      videoA.play();
      videoB.play();
      isPlaying = true;
    }
  }

  // Handle video ended
  function handleEnded() {
    if (videoA) videoA.pause();
    if (videoB) videoB.pause();
    isPlaying = false;
  }

  // Seek both videos (rate-aware mapping when trims are valid)
  function handleSeek(e) {
    const t = parseFloat(e.target.value);
    currentTime = t;

    const mixed = getMixedMode();
    if (mixed) {
      // Mixed mode: seek local pane with trim+rate mapping, YT pane directly
      const localTrim = mixed.localPane === 'A' ? trimA : trimB;
      const localRate = mixed.localPane === 'A' ? rateA : rateB;
      const localVideo = mixed.localPane === 'A' ? videoA : videoB;
      const safeRate = localRate > 0 ? localRate : 1;

      if (localTrim.duration > 0) {
        const localTime = Math.min(localTrim.out, Math.max(localTrim.in, localTrim.in + t * safeRate));
        if (localVideo) localVideo.currentTime = localTime;
      } else {
        if (localVideo) localVideo.currentTime = t;
      }

      const ytPlayer = mixed.ytPane === 'A' ? ytPlayerA : ytPlayerB;
      const ytReady = mixed.ytPane === 'A' ? ytReadyA : ytReadyB;
      if (ytPlayer && ytReady) {
        ytPlayer.seekTo(t, true);
      }
      return;
    }

    if (getTrimsValid()) {
      // Map compare-time to actual video times: timeX = inX + (t * rateX)
      const safeRateA = rateA > 0 ? rateA : 1;
      const safeRateB = rateB > 0 ? rateB : 1;
      const timeA = Math.min(trimA.out, Math.max(trimA.in, trimA.in + t * safeRateA));
      const timeB = Math.min(trimB.out, Math.max(trimB.in, trimB.in + t * safeRateB));
      if (videoA) videoA.currentTime = timeA;
      if (videoB) videoB.currentTime = timeB;
    } else {
      // Direct time when no trims
      if (videoA) videoA.currentTime = t;
      if (videoB) videoB.currentTime = t;
    }
  }

  // Pause YouTube after scrub ends (mixed mode only)
  function handleSeekEnd() {
    const mixed = getMixedMode();
    if (!mixed) return;
    const ytPlayer = mixed.ytPane === 'A' ? ytPlayerA : ytPlayerB;
    const ytReady = mixed.ytPane === 'A' ? ytReadyA : ytReadyB;
    if (ytPlayer && ytReady) {
      try { ytPlayer.pauseVideo(); } catch (e) { /* player gone */ }
    }
  }

  // Format time as MM:SS
  function formatTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Format time as MM:SS.xx for trim readouts
  function formatTimeDetailed(seconds) {
    if (isNaN(seconds) || seconds === null) return '0:00.00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const hundredths = Math.floor((seconds % 1) * 100);
    return `${mins}:${secs.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`;
  }

  // Initialize trim values when video metadata loads
  function initTrim(pane, duration) {
    if (pane === 'A') {
      trimA = { in: 0, out: duration, duration };
    } else {
      trimB = { in: 0, out: duration, duration };
    }
  }

  // Reset trim to full duration
  function resetTrim(pane) {
    if (pane === 'A') {
      trimA = { ...trimA, in: 0, out: trimA.duration };
      if (videoA) videoA.currentTime = 0;
    } else {
      trimB = { ...trimB, in: 0, out: trimB.duration };
      if (videoB) videoB.currentTime = 0;
    }
  }

  // Calculate time from pointer position on track
  function getTimeFromPointer(e, trackEl, duration) {
    const rect = trackEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    return ratio * duration;
  }

  const MIN_TRIM_GAP = 0.05; // Minimum gap between IN and OUT

  // Pointer down on trim handle
  function handleTrimPointerDown(pane, handle, e) {
    e.preventDefault();
    if (pane === 'A') {
      trimADragging = handle;
    } else {
      trimBDragging = handle;
    }
    // Add global listeners
    window.addEventListener('pointermove', handleTrimPointerMove);
    window.addEventListener('pointerup', handleTrimPointerUp);
  }

  // Pointer move while dragging
  function handleTrimPointerMove(e) {
    if (trimADragging && trimATrack) {
      const time = getTimeFromPointer(e, trimATrack, trimA.duration);
      if (trimADragging === 'in') {
        const clamped = Math.min(time, trimA.out - MIN_TRIM_GAP);
        trimA = { ...trimA, in: Math.max(0, clamped) };
        if (videoA) videoA.currentTime = trimA.in;
      } else {
        const clamped = Math.max(time, trimA.in + MIN_TRIM_GAP);
        trimA = { ...trimA, out: Math.min(trimA.duration, clamped) };
        if (videoA) videoA.currentTime = trimA.out;
      }
    }
    if (trimBDragging && trimBTrack) {
      const time = getTimeFromPointer(e, trimBTrack, trimB.duration);
      if (trimBDragging === 'in') {
        const clamped = Math.min(time, trimB.out - MIN_TRIM_GAP);
        trimB = { ...trimB, in: Math.max(0, clamped) };
        if (videoB) videoB.currentTime = trimB.in;
      } else {
        const clamped = Math.max(time, trimB.in + MIN_TRIM_GAP);
        trimB = { ...trimB, out: Math.min(trimB.duration, clamped) };
        if (videoB) videoB.currentTime = trimB.out;
      }
    }
  }

  // Pointer up - stop dragging
  function handleTrimPointerUp() {
    trimADragging = null;
    trimBDragging = null;
    window.removeEventListener('pointermove', handleTrimPointerMove);
    window.removeEventListener('pointerup', handleTrimPointerUp);
  }

  // Clamp currentTime and re-seek when trim or rate values change
  $effect(() => {
    if (getTrimsValid()) {
      const masterLen = getMasterSegmentLen();
      const safeRateA = rateA > 0 ? rateA : 1;
      const safeRateB = rateB > 0 ? rateB : 1;

      if (currentTime > masterLen) {
        currentTime = masterLen;
        // Seek both videos to clamped position
        if (videoA) videoA.currentTime = trimA.in + currentTime * safeRateA;
        if (videoB) videoB.currentTime = trimB.in + currentTime * safeRateB;

        // Handle end-of-track behavior
        if (isPlaying) {
          if (loopEnabled) {
            currentTime = 0;
            if (videoA) videoA.currentTime = trimA.in;
            if (videoB) videoB.currentTime = trimB.in;
          } else {
            if (videoA) videoA.pause();
            if (videoB) videoB.pause();
            isPlaying = false;
          }
        }
      }
    }
  });

  // Poll currentTime while playing (rate-aware)
  $effect(() => {
    if (!isPlaying || !videoA) return;

    let animationId;
    function updateTime() {
      if (!videoA || !isPlaying) return;

      if (getTrimsValid()) {
        // Derive compare-time from videoA position: t = (videoA.currentTime - inA) / rateA
        const safeRateA = rateA > 0 ? rateA : 1;
        const safeRateB = rateB > 0 ? rateB : 1;
        const t = (videoA.currentTime - trimA.in) / safeRateA;
        const masterLen = getMasterSegmentLen();

        if (t >= masterLen - PLAY_END_EPSILON) {
          if (loopEnabled) {
            // Loop back to start
            currentTime = 0;
            videoA.currentTime = trimA.in;
            if (videoB) videoB.currentTime = trimB.in;
          } else {
            // Reached end - pause
            videoA.pause();
            videoB?.pause();
            isPlaying = false;
            currentTime = masterLen;
            // Seek to end positions using rate-aware mapping
            videoA.currentTime = trimA.in + masterLen * safeRateA;
            if (videoB) videoB.currentTime = trimB.in + masterLen * safeRateB;
            return;
          }
        }

        currentTime = Math.max(0, t);
      } else {
        // Non-trim mode: check for end of master range
        if (videoA.currentTime >= maxDuration - PLAY_END_EPSILON) {
          if (loopEnabled) {
            currentTime = 0;
            videoA.currentTime = 0;
            if (videoB) videoB.currentTime = 0;
          } else {
            videoA.pause();
            videoB?.pause();
            isPlaying = false;
            currentTime = maxDuration;
            return;
          }
        } else {
          currentTime = videoA.currentTime;
        }
      }

      animationId = requestAnimationFrame(updateTime);
    }
    animationId = requestAnimationFrame(updateTime);

    return () => {
      if (animationId) cancelAnimationFrame(animationId);
    };
  });

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        goto('/login');
        return;
      }
      const userDoc = await getDoc(doc(db, 'user', user.uid));
      if (userDoc.exists()) {
        const role = userDoc.data().role;
        if (role === 'admin' || role === 'coach') {
          loading = false;
          return;
        }
      }
      goto('/');
    });

    // Cleanup on unmount
    return () => {
      if (paneA.localUrl) URL.revokeObjectURL(paneA.localUrl);
      if (paneB.localUrl) URL.revokeObjectURL(paneB.localUrl);
      destroyYTPlayer('A');
      destroyYTPlayer('B');
    };
  });

  function getYouTubeId(url) {
    if (!url) return null;
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  // Load the YouTube IFrame API script (once)
  function loadYTApi() {
    return new Promise((resolve, reject) => {
      if (typeof window !== 'undefined' && window.YT && window.YT.Player) {
        resolve();
        return;
      }
      if (ytApiLoading) {
        const check = setInterval(() => {
          if (window.YT && window.YT.Player) {
            clearInterval(check);
            resolve();
          }
        }, 100);
        setTimeout(() => { clearInterval(check); reject(new Error('YT API timeout')); }, 10000);
        return;
      }
      ytApiLoading = true;
      window.onYouTubeIframeAPIReady = () => {
        ytApiLoading = false;
        resolve();
      };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.onerror = () => { ytApiLoading = false; reject(new Error('Failed to load YT API')); };
      document.head.appendChild(tag);
    });
  }

  // Destroy a YouTube player instance and reset its state
  function destroyYTPlayer(pane) {
    if (pane === 'A') {
      if (ytPlayerA) {
        try { ytPlayerA.destroy(); } catch (e) { /* player already gone */ }
        ytPlayerA = null;
      }
      ytReadyA = false;
      ytDurationA = 0;
    } else {
      if (ytPlayerB) {
        try { ytPlayerB.destroy(); } catch (e) { /* player already gone */ }
        ytPlayerB = null;
      }
      ytReadyB = false;
      ytDurationB = 0;
    }
  }

  function selectSourceType(pane, type) {
    clearPane(pane);
    if (pane === 'A') {
      paneA = { ...paneA, sourceType: type, error: null };
    } else {
      paneB = { ...paneB, sourceType: type, error: null };
    }
  }

  function handleFileSelect(pane, event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const paneState = pane === 'A' ? paneA : paneB;

    // Revoke old URL if exists
    if (paneState.localUrl) {
      URL.revokeObjectURL(paneState.localUrl);
    }

    const url = URL.createObjectURL(file);
    if (pane === 'A') {
      paneA = { ...paneA, localUrl: url, fileName: file.name, youtubeId: null, error: null };
    } else {
      paneB = { ...paneB, localUrl: url, fileName: file.name, youtubeId: null, error: null };
    }
  }

  async function loadYoutube(pane) {
    const input = pane === 'A' ? paneAYoutubeInput : paneBYoutubeInput;
    const videoId = getYouTubeId(input);

    if (!videoId) {
      if (pane === 'A') {
        paneA = { ...paneA, error: 'Invalid YouTube link' };
      } else {
        paneB = { ...paneB, error: 'Invalid YouTube link' };
      }
      return;
    }

    const paneState = pane === 'A' ? paneA : paneB;

    // Revoke old local URL if switching from local
    if (paneState.localUrl) {
      URL.revokeObjectURL(paneState.localUrl);
    }

    // Destroy any existing YT player for this pane
    destroyYTPlayer(pane);

    if (pane === 'A') {
      paneA = { ...paneA, youtubeId: videoId, localUrl: null, fileName: null, error: null };
    } else {
      paneB = { ...paneB, youtubeId: videoId, localUrl: null, fileName: null, error: null };
    }

    // Wait for Svelte to render the player div, then init YT player
    await tick();

    try {
      await loadYTApi();
      const elementId = pane === 'A' ? 'yt-player-a' : 'yt-player-b';
      const el = document.getElementById(elementId);
      if (!el) return;

      const player = new window.YT.Player(elementId, {
        videoId,
        playerVars: { controls: 1, modestbranding: 1, rel: 0, origin: window.location.origin },
        events: {
          onReady: (event) => {
            if (pane === 'A') {
              ytPlayerA = player;
              ytReadyA = true;
              ytDurationA = event.target.getDuration() || 0;
            } else {
              ytPlayerB = player;
              ytReadyB = true;
              ytDurationB = event.target.getDuration() || 0;
            }
          },
          onStateChange: (event) => {
            // Capture duration if it wasn't available at onReady
            const dur = event.target.getDuration();
            if (dur > 0) {
              if (pane === 'A' && ytDurationA === 0) ytDurationA = dur;
              if (pane === 'B' && ytDurationB === 0) ytDurationB = dur;
            }
          }
        }
      });
    } catch (e) {
      console.error('Failed to init YouTube player:', e);
    }
  }

  function clearPane(pane) {
    // Stop playback when clearing
    if (videoA) videoA.pause();
    if (videoB) videoB.pause();
    isPlaying = false;
    currentTime = 0;
    maxDuration = 0;
    loopEnabled = false;

    // Destroy YT player before state changes remove the DOM element
    destroyYTPlayer(pane);

    if (pane === 'A') {
      if (paneA.localUrl) URL.revokeObjectURL(paneA.localUrl);
      paneA = { sourceType: null, localUrl: null, fileName: null, youtubeId: null, error: null };
      paneAYoutubeInput = '';
      videoA = null;
      trimA = { in: 0, out: 0, duration: 0 };
      rateA = 1;
    } else {
      if (paneB.localUrl) URL.revokeObjectURL(paneB.localUrl);
      paneB = { sourceType: null, localUrl: null, fileName: null, youtubeId: null, error: null };
      paneBYoutubeInput = '';
      videoB = null;
      trimB = { in: 0, out: 0, duration: 0 };
      rateB = 1;
    }
  }

  function hasVideo(paneState) {
    return paneState.localUrl || paneState.youtubeId;
  }

  // Playback rate options
  const rateOptions = [0.25, 0.5, 1, 1.5, 2];

  function handleRateChange(pane, rate) {
    if (pane === 'A') {
      rateA = rate;
      if (videoA) videoA.playbackRate = rate;
    } else {
      rateB = rate;
      if (videoB) videoB.playbackRate = rate;
    }
  }

  // Apply rate when video element becomes available
  $effect(() => {
    if (videoA) videoA.playbackRate = rateA;
  });

  $effect(() => {
    if (videoB) videoB.playbackRate = rateB;
  });
</script>

{#if !loading}
  <h1>Compare</h1>

  <!-- Shared controls (when both panes have local videos, or Local+YouTube) -->
  {#if getMasterControlsVisible()}
    {@const mixed = getMixedMode()}
    {@const scrubberDisabled = mixed ? !getMixedScrubberEnabled() : false}
    <div class="shared-controls">
      {#if !mixed}
        <button class="play-pause-btn" onclick={togglePlayPause}>
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
      {:else}
        <button class="play-pause-btn" disabled title="Play not available for Local+YouTube yet">
          ▶ Play
        </button>
      {/if}
      <span class="time-display">{formatTime(currentTime)}</span>
      <input
        type="range"
        class="scrubber"
        min="0"
        max={getScrubberMax() || 1}
        step="0.1"
        value={currentTime}
        oninput={handleSeek}
        onchange={handleSeekEnd}
        disabled={scrubberDisabled}
      />
      <span class="time-display">{formatTime(getScrubberMax())}</span>
      {#if !mixed}
        <label class="loop-toggle">
          <input type="checkbox" bind:checked={loopEnabled} />
          Loop
        </label>
      {/if}
    </div>
  {/if}

  <div class="compare-container">
    <!-- Pane A -->
    <div class="pane">
      <div class="pane-header">
        <span class="pane-label">Pane A</span>
        {#if paneA.sourceType}
          <button class="clear-btn" onclick={() => clearPane('A')}>Clear</button>
        {/if}
      </div>

      {#if !paneA.sourceType}
        <div class="source-chooser">
          <p>Choose source:</p>
          <button class="source-btn" onclick={() => selectSourceType('A', 'local')}>Local</button>
          <button class="source-btn" onclick={() => selectSourceType('A', 'youtube')}>YouTube</button>
        </div>
      {:else if paneA.sourceType === 'local' && !paneA.localUrl}
        <div class="local-picker">
          <button class="local-btn" onclick={() => document.getElementById('selectA').click()}>
            Select Video
          </button>
          <input id="selectA" type="file" accept="video/*" onchange={(e) => handleFileSelect('A', e)} hidden />
        </div>
      {:else if paneA.sourceType === 'youtube' && !paneA.youtubeId}
        <div class="youtube-input">
          <input
            type="text"
            bind:value={paneAYoutubeInput}
            placeholder="Paste YouTube URL"
            onblur={() => paneAYoutubeInput && loadYoutube('A')}
          />
          <button onclick={() => loadYoutube('A')}>Load</button>
          {#if paneA.error}
            <p class="error">{paneA.error}</p>
          {/if}
        </div>
      {:else if paneA.localUrl}
        <div class="video-container">
          <p class="file-name">{paneA.fileName}</p>
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            bind:this={videoA}
            src={paneA.localUrl}
            controls
            playsinline
            onloadedmetadata={(e) => { updateMaxDuration(); initTrim('A', e.target.duration); }}
            onended={handleEnded}
          ></video>
          <!-- Trim controls for Pane A -->
          {#if trimA.duration > 0}
            <div class="trim-control">
              <div class="trim-readouts">
                <span>IN: {formatTimeDetailed(trimA.in)}</span>
                <button class="reset-trim-btn" onclick={() => resetTrim('A')}>Reset Trim</button>
                <span>OUT: {formatTimeDetailed(trimA.out)}</span>
              </div>
              <div class="trim-track" bind:this={trimATrack}>
                <div class="trim-range" style="left: {(trimA.in / trimA.duration) * 100}%; right: {100 - (trimA.out / trimA.duration) * 100}%"></div>
                <div
                  class="trim-handle trim-handle-in"
                  style="left: {(trimA.in / trimA.duration) * 100}%"
                  onpointerdown={(e) => handleTrimPointerDown('A', 'in', e)}
                  role="slider"
                  aria-label="Trim in point"
                  aria-valuenow={trimA.in}
                  tabindex="0"
                ></div>
                <div
                  class="trim-handle trim-handle-out"
                  style="left: {(trimA.out / trimA.duration) * 100}%"
                  onpointerdown={(e) => handleTrimPointerDown('A', 'out', e)}
                  role="slider"
                  aria-label="Trim out point"
                  aria-valuenow={trimA.out}
                  tabindex="0"
                ></div>
              </div>
            </div>
          {/if}
          <!-- Speed control for Pane A -->
          <div class="speed-control">
            <span class="speed-label">Speed:</span>
            <div class="speed-buttons">
              {#each rateOptions as opt}
                <button
                  class="speed-btn"
                  class:selected={rateA === opt}
                  onclick={() => handleRateChange('A', opt)}
                >{opt}x</button>
              {/each}
            </div>
          </div>
          <div class="duration-readouts">
            <span>Segment: {trimA.duration > 0 ? (trimA.out - trimA.in).toFixed(2) + 's' : '—'}</span>
            <span>Effective: {trimA.duration > 0 ? ((trimA.out - trimA.in) / rateA).toFixed(2) + 's' : '—'}</span>
          </div>
        </div>
      {:else if paneA.youtubeId}
        <div class="video-container">
          <div class="youtube-wrapper">
            <div id="yt-player-a"></div>
          </div>
        </div>
      {/if}
    </div>

    <!-- Pane B -->
    <div class="pane">
      <div class="pane-header">
        <span class="pane-label">Pane B</span>
        {#if paneB.sourceType}
          <button class="clear-btn" onclick={() => clearPane('B')}>Clear</button>
        {/if}
      </div>

      {#if !paneB.sourceType}
        <div class="source-chooser">
          <p>Choose source:</p>
          <button class="source-btn" onclick={() => selectSourceType('B', 'local')}>Local</button>
          <button class="source-btn" onclick={() => selectSourceType('B', 'youtube')}>YouTube</button>
        </div>
      {:else if paneB.sourceType === 'local' && !paneB.localUrl}
        <div class="local-picker">
          <button class="local-btn" onclick={() => document.getElementById('selectB').click()}>
            Select Video
          </button>
          <input id="selectB" type="file" accept="video/*" onchange={(e) => handleFileSelect('B', e)} hidden />
        </div>
      {:else if paneB.sourceType === 'youtube' && !paneB.youtubeId}
        <div class="youtube-input">
          <input
            type="text"
            bind:value={paneBYoutubeInput}
            placeholder="Paste YouTube URL"
            onblur={() => paneBYoutubeInput && loadYoutube('B')}
          />
          <button onclick={() => loadYoutube('B')}>Load</button>
          {#if paneB.error}
            <p class="error">{paneB.error}</p>
          {/if}
        </div>
      {:else if paneB.localUrl}
        <div class="video-container">
          <p class="file-name">{paneB.fileName}</p>
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            bind:this={videoB}
            src={paneB.localUrl}
            controls
            playsinline
            onloadedmetadata={(e) => { updateMaxDuration(); initTrim('B', e.target.duration); }}
            onended={handleEnded}
          ></video>
          <!-- Trim controls for Pane B -->
          {#if trimB.duration > 0}
            <div class="trim-control">
              <div class="trim-readouts">
                <span>IN: {formatTimeDetailed(trimB.in)}</span>
                <button class="reset-trim-btn" onclick={() => resetTrim('B')}>Reset Trim</button>
                <span>OUT: {formatTimeDetailed(trimB.out)}</span>
              </div>
              <div class="trim-track" bind:this={trimBTrack}>
                <div class="trim-range" style="left: {(trimB.in / trimB.duration) * 100}%; right: {100 - (trimB.out / trimB.duration) * 100}%"></div>
                <div
                  class="trim-handle trim-handle-in"
                  style="left: {(trimB.in / trimB.duration) * 100}%"
                  onpointerdown={(e) => handleTrimPointerDown('B', 'in', e)}
                  role="slider"
                  aria-label="Trim in point"
                  aria-valuenow={trimB.in}
                  tabindex="0"
                ></div>
                <div
                  class="trim-handle trim-handle-out"
                  style="left: {(trimB.out / trimB.duration) * 100}%"
                  onpointerdown={(e) => handleTrimPointerDown('B', 'out', e)}
                  role="slider"
                  aria-label="Trim out point"
                  aria-valuenow={trimB.out}
                  tabindex="0"
                ></div>
              </div>
            </div>
          {/if}
          <!-- Speed control for Pane B -->
          <div class="speed-control">
            <span class="speed-label">Speed:</span>
            <div class="speed-buttons">
              {#each rateOptions as opt}
                <button
                  class="speed-btn"
                  class:selected={rateB === opt}
                  onclick={() => handleRateChange('B', opt)}
                >{opt}x</button>
              {/each}
            </div>
          </div>
          <div class="duration-readouts">
            <span>Segment: {trimB.duration > 0 ? (trimB.out - trimB.in).toFixed(2) + 's' : '—'}</span>
            <span>Effective: {trimB.duration > 0 ? ((trimB.out - trimB.in) / rateB).toFixed(2) + 's' : '—'}</span>
          </div>
        </div>
      {:else if paneB.youtubeId}
        <div class="video-container">
          <div class="youtube-wrapper">
            <div id="yt-player-b"></div>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .shared-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: #333;
    border-radius: 8px;
    margin-bottom: 16px;
  }

  .play-pause-btn {
    padding: 8px 16px;
    background: #4CAF50;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.95em;
    min-width: 90px;
  }

  .play-pause-btn:hover:not(:disabled) {
    background: #45a049;
  }

  .play-pause-btn:disabled {
    background: #888;
    cursor: not-allowed;
    opacity: 0.6;
  }

  .time-display {
    color: white;
    font-size: 0.85em;
    font-family: monospace;
    min-width: 45px;
  }

  .scrubber {
    flex: 1;
    height: 6px;
    cursor: pointer;
    accent-color: #4CAF50;
  }

  .scrubber:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .loop-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    color: white;
    font-size: 0.85em;
    cursor: pointer;
    user-select: none;
  }

  .loop-toggle input {
    accent-color: #4CAF50;
    cursor: pointer;
  }

  .compare-container {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }

  .pane {
    flex: 1;
    min-width: 280px;
    border: 1px solid #ccc;
    border-radius: 8px;
    padding: 12px;
    background: #fafafa;
  }

  .pane-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid #eee;
  }

  .pane-label {
    font-weight: 600;
    color: #333;
  }

  .clear-btn {
    padding: 4px 10px;
    background: #fff;
    border: 1px solid #f44336;
    color: #f44336;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
  }

  .clear-btn:hover {
    background: #ffebee;
  }

  .source-chooser {
    text-align: center;
    padding: 20px 0;
  }

  .source-chooser p {
    margin: 0 0 12px 0;
    color: #666;
  }

  .source-btn {
    padding: 10px 20px;
    margin: 0 6px;
    background: #fff;
    border: 1px solid #2196F3;
    color: #2196F3;
    border-radius: 4px;
    cursor: pointer;
    font-size: 1em;
  }

  .source-btn:hover {
    background: #e3f2fd;
  }

  .local-picker {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 20px 0;
    align-items: center;
  }

  .local-btn {
    padding: 12px 20px;
    background: #fff;
    border: 1px solid #4CAF50;
    color: #4CAF50;
    border-radius: 4px;
    cursor: pointer;
    font-size: 1em;
    min-width: 180px;
  }

  .local-btn:hover {
    background: #e8f5e9;
  }

  .file-picker {
    padding: 20px 0;
  }

  .file-picker input {
    width: 100%;
  }

  .youtube-input {
    padding: 10px 0;
  }

  .youtube-input input {
    width: 100%;
    padding: 8px;
    margin-bottom: 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
  }

  .youtube-input button {
    padding: 8px 16px;
    background: #2196F3;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .youtube-input button:hover {
    background: #1976D2;
  }

  .error {
    color: #f44336;
    font-size: 0.85em;
    margin: 8px 0 0 0;
  }

  .video-container {
    width: 100%;
  }

  .file-name {
    margin: 0 0 8px 0;
    font-size: 0.85em;
    color: #666;
    word-break: break-all;
  }

  .video-container video {
    width: 100%;
    max-height: 300px;
    border-radius: 4px;
    background: #000;
  }

  .youtube-wrapper {
    position: relative;
    padding-bottom: 56.25%;
    height: 0;
    overflow: hidden;
  }

  .youtube-wrapper :global(iframe) {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    border-radius: 4px;
  }

  /* Speed control */
  .speed-control {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .speed-label {
    font-size: 0.85em;
    color: #555;
  }

  .speed-buttons {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .speed-btn {
    padding: 6px 10px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #fff;
    font-size: 0.85em;
    cursor: pointer;
    min-width: 44px;
    color: #555;
    transition: background-color 0.15s, border-color 0.15s;
  }

  .speed-btn:hover {
    border-color: #4CAF50;
    background: #f5f5f5;
  }

  .speed-btn.selected {
    background: #4CAF50;
    border-color: #4CAF50;
    color: white;
    font-weight: 600;
  }

  .duration-readouts {
    margin-top: 8px;
    display: flex;
    gap: 16px;
    font-size: 0.8em;
    color: #777;
    font-family: monospace;
  }

  /* Trim controls */
  .trim-control {
    margin-top: 12px;
    padding: 10px;
    background: #f0f0f0;
    border-radius: 6px;
  }

  .trim-readouts {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    font-size: 0.8em;
    font-family: monospace;
    color: #555;
  }

  .reset-trim-btn {
    padding: 4px 10px;
    background: #fff;
    border: 1px solid #888;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
    color: #555;
  }

  .reset-trim-btn:hover {
    background: #eee;
    border-color: #666;
  }

  .trim-track {
    position: relative;
    height: 24px;
    background: #ddd;
    border-radius: 4px;
    cursor: pointer;
    touch-action: none;
  }

  .trim-range {
    position: absolute;
    top: 0;
    bottom: 0;
    background: rgba(76, 175, 80, 0.3);
    border-radius: 4px;
  }

  .trim-handle {
    position: absolute;
    top: -2px;
    width: 14px;
    height: 28px;
    background: #4CAF50;
    border: 2px solid #fff;
    border-radius: 4px;
    cursor: ew-resize;
    transform: translateX(-50%);
    touch-action: none;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  }

  .trim-handle:hover,
  .trim-handle:active {
    background: #45a049;
  }

  .trim-handle-in {
    border-left: 3px solid #fff;
  }

  .trim-handle-out {
    border-right: 3px solid #fff;
  }

  @media (max-width: 640px) {
    .compare-container {
      flex-direction: column;
    }

    .pane {
      min-width: 100%;
    }

    .shared-controls {
      flex-wrap: wrap;
    }

    .scrubber {
      width: 100%;
      order: 3;
    }

    .trim-handle {
      width: 18px;
      height: 32px;
    }

    .trim-track {
      height: 28px;
    }
  }
</style>
