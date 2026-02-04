<script>
  import { auth, db } from '$lib/firebase.js';
  import { doc, getDoc } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let loading = $state(true);

  // Pane A state
  let paneA = $state({ sourceType: null, localUrl: null, fileName: null, youtubeId: null, error: null });
  let paneAYoutubeInput = $state('');
  let videoA = $state(null);

  // Pane B state
  let paneB = $state({ sourceType: null, localUrl: null, fileName: null, youtubeId: null, error: null });
  let paneBYoutubeInput = $state('');
  let videoB = $state(null);

  // Shared controls state
  let isPlaying = $state(false);
  let currentTime = $state(0);
  let maxDuration = $state(0);

  // Check if both panes have local videos loaded
  function getBothLocalLoaded() {
    return paneA.sourceType === 'local' && paneA.localUrl &&
           paneB.sourceType === 'local' && paneB.localUrl;
  }

  // Update max duration when videos are loaded
  function updateMaxDuration() {
    if (videoA && videoB && !isNaN(videoA.duration) && !isNaN(videoB.duration)) {
      maxDuration = Math.min(videoA.duration, videoB.duration);
    }
  }

  // Shared play/pause
  function togglePlayPause() {
    if (!videoA || !videoB) return;

    if (isPlaying) {
      videoA.pause();
      videoB.pause();
      isPlaying = false;
    } else {
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

  // Seek both videos
  function handleSeek(e) {
    const time = parseFloat(e.target.value);
    currentTime = time;
    if (videoA) videoA.currentTime = time;
    if (videoB) videoB.currentTime = time;
  }

  // Format time as MM:SS
  function formatTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Poll currentTime while playing
  $effect(() => {
    if (!isPlaying || !videoA) return;

    let animationId;
    function updateTime() {
      if (videoA && isPlaying) {
        currentTime = videoA.currentTime;
        animationId = requestAnimationFrame(updateTime);
      }
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

  function loadYoutube(pane) {
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

    if (pane === 'A') {
      paneA = { ...paneA, youtubeId: videoId, localUrl: null, fileName: null, error: null };
    } else {
      paneB = { ...paneB, youtubeId: videoId, localUrl: null, fileName: null, error: null };
    }
  }

  function clearPane(pane) {
    // Stop playback when clearing
    if (videoA) videoA.pause();
    if (videoB) videoB.pause();
    isPlaying = false;
    currentTime = 0;
    maxDuration = 0;

    if (pane === 'A') {
      if (paneA.localUrl) URL.revokeObjectURL(paneA.localUrl);
      paneA = { sourceType: null, localUrl: null, fileName: null, youtubeId: null, error: null };
      paneAYoutubeInput = '';
      videoA = null;
    } else {
      if (paneB.localUrl) URL.revokeObjectURL(paneB.localUrl);
      paneB = { sourceType: null, localUrl: null, fileName: null, youtubeId: null, error: null };
      paneBYoutubeInput = '';
      videoB = null;
    }
  }

  function hasVideo(paneState) {
    return paneState.localUrl || paneState.youtubeId;
  }
</script>

{#if !loading}
  <h1>Compare</h1>

  <!-- Shared controls (only when both panes have local videos) -->
  {#if getBothLocalLoaded()}
    <div class="shared-controls">
      <button class="play-pause-btn" onclick={togglePlayPause}>
        {isPlaying ? '⏸ Pause' : '▶ Play'}
      </button>
      <span class="time-display">{formatTime(currentTime)}</span>
      <input
        type="range"
        class="scrubber"
        min="0"
        max={maxDuration || 1}
        step="0.1"
        value={currentTime}
        oninput={handleSeek}
      />
      <span class="time-display">{formatTime(maxDuration)}</span>
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
        <div class="file-picker">
          <input
            type="file"
            accept="video/*"
            capture="environment"
            onchange={(e) => handleFileSelect('A', e)}
          />
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
            onloadedmetadata={updateMaxDuration}
            onended={handleEnded}
          ></video>
        </div>
      {:else if paneA.youtubeId}
        <div class="video-container">
          <div class="youtube-wrapper">
            <iframe
              src="https://www.youtube.com/embed/{paneA.youtubeId}"
              title="Pane A YouTube video"
              frameborder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen
            ></iframe>
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
        <div class="file-picker">
          <input
            type="file"
            accept="video/*"
            capture="environment"
            onchange={(e) => handleFileSelect('B', e)}
          />
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
            onloadedmetadata={updateMaxDuration}
            onended={handleEnded}
          ></video>
        </div>
      {:else if paneB.youtubeId}
        <div class="video-container">
          <div class="youtube-wrapper">
            <iframe
              src="https://www.youtube.com/embed/{paneB.youtubeId}"
              title="Pane B YouTube video"
              frameborder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen
            ></iframe>
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

  .play-pause-btn:hover {
    background: #45a049;
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
  }

  .youtube-wrapper iframe {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    border-radius: 4px;
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
  }
</style>
