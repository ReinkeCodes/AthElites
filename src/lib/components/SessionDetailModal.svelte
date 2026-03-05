<script>
  /** @type {{ session: any, groupedLogs: any[], onClose: () => void, onDeleteSession?: () => void, onDeleteExercise?: (sessionId: string, exercise: any) => void, getCustomReqs?: (programId: string, workoutExerciseId: string) => any[] | null, missingSets?: { name: string, count: number }[], missingPlacement?: 'top' | 'bottom' }} */
  let {
    session,
    groupedLogs,
    onClose,
    onDeleteSession = null,
    onDeleteExercise = null,
    getCustomReqs = null,
    missingSets = null,
    missingPlacement = 'top'
  } = $props();

  function formatFullDate(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  // metricsV2 helpers
  function getMetric(metricsV2, key) {
    if (!metricsV2 || !Array.isArray(metricsV2)) return null;
    return metricsV2.find(m => m.key === key) || null;
  }

  function formatTimeValue(seconds) {
    if (seconds == null || isNaN(seconds)) return '-';
    if (seconds < 60) return `${Math.round(seconds)} s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function formatPrimaryMetric(set) {
    if (set.metricsV2 && Array.isArray(set.metricsV2)) {
      const time = getMetric(set.metricsV2, 'time');
      if (time) return { value: formatTimeValue(time.value), label: '' };
      const reps = getMetric(set.metricsV2, 'reps');
      if (reps) return { value: reps.value ?? '-', label: 'reps' };
    }
    // Legacy fallback
    if (set.repsMetric === 'time') {
      return { value: set.reps || '-', label: '' };
    }
    return { value: set.reps || '-', label: 'reps' };
  }

  function formatSecondaryMetric(set) {
    if (set.metricsV2 && Array.isArray(set.metricsV2)) {
      const load = getMetric(set.metricsV2, 'load');
      if (load) return { value: load.value, label: 'lbs' };
      const distance = getMetric(set.metricsV2, 'distance');
      if (distance) return { value: distance.value, label: 'dist' };
      return null;
    }
    // Legacy fallback
    if (!set.weight) return null;
    if (set.weightMetric === 'distance') {
      return { value: set.weight, label: 'dist' };
    }
    return { value: set.weight, label: 'lbs' };
  }
</script>

<!-- Session Detail Modal -->
<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
  <button onclick={onClose} style="padding: 8px 16px; background: #f5f5f5; border: 1px solid #ddd; cursor: pointer; border-radius: 5px;">
    ← Back
  </button>
  {#if onDeleteSession}
    <button onclick={onDeleteSession} style="padding: 8px 16px; background: #ffebee; border: 1px solid #ef5350; color: #c62828; cursor: pointer; border-radius: 5px;">
      Delete Workout
    </button>
  {/if}
</div>

<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; margin-bottom: 20px;">
  <h2 style="margin: 0 0 5px 0;">{session.dayName}</h2>
  <p style="margin: 0; opacity: 0.9;">{session.programName}</p>
  <p style="margin: 10px 0 0 0; font-size: 0.9em; opacity: 0.85;">
    {formatFullDate(session.finishedAt)}
    {#if session.durationMinutes}
      • {session.durationMinutes} minutes
    {/if}
  </p>
</div>

{#if missingSets && missingSets.length > 0 && missingPlacement === 'top'}
<div style="background: #ffebee; border: 1px solid #ffcdd2; border-radius: 8px; padding: 12px 15px; margin-bottom: 20px;">
  <div style="font-weight: 600; color: #c62828; margin-bottom: 8px;">Missing</div>
  {#each missingSets as item}
    <div style="color: #c62828; font-size: 0.9em; margin-bottom: 4px;">
      {item.count} {item.count === 1 ? 'set' : 'sets'} of {item.name}
    </div>
  {/each}
</div>
{/if}

<h3>Exercises</h3>
{#each groupedLogs as exercise}
  <div style="background: white; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px 15px; margin-bottom: 12px;">
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <strong style="font-size: 1.05em;">{exercise.exerciseName}</strong>
      {#if onDeleteExercise}
        <button
          onclick={(e) => { e.stopPropagation(); onDeleteExercise(session.id, exercise); }}
          style="background: none; border: none; color: #999; cursor: pointer; font-size: 1.1em; padding: 4px 8px; line-height: 1;"
          title="Delete all sets for this exercise"
        >×</button>
      {/if}
    </div>
    <div style="margin-top: 8px;">
      {#each exercise.sets as set}
        {@const primary = formatPrimaryMetric(set)}
        {@const secondary = formatSecondaryMetric(set)}
        <div style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; margin-bottom: 4px; background: #f8f9fa; border-radius: 5px; font-size: 0.9em;">
          <span style="font-weight: bold; color: #667eea; min-width: 35px;">Set {set.setNumber}</span>
          <span style="color: #333;"><strong>{primary.value}</strong>{#if primary.label}&nbsp;{primary.label}{/if}{#if secondary}&nbsp;@&nbsp;<strong>{secondary.value}</strong>{#if secondary.label}&nbsp;{secondary.label}{/if}{/if}{#if set.rir}&nbsp;<span style="color: #888;">(RIR: {set.rir})</span>{/if}</span>
        </div>
        {#if set.customInputs && getCustomReqs}{#each Object.entries(set.customInputs) as [idx, val]}{#if val}{@const reqs = getCustomReqs(set.programId, set.workoutExerciseId)}{@const req = reqs?.[parseInt(idx)]}<div style="color: #9c27b0; font-size: 0.8em; margin: 2px 0 0 45px;">{req?.name || `Custom ${parseInt(idx)+1}`}: {val}{#if req?.value}&nbsp;(Target: {req.value}){/if}</div>{/if}{/each}{/if}
        {#if set.notes && set.notes !== 'Did not complete'}
          <div style="color: #666; font-style: italic; font-size: 0.85em; margin: 0 0 6px 45px;">"{set.notes}"</div>
        {/if}
      {/each}
    </div>
  </div>
{/each}

{#if groupedLogs.length === 0}
  <p style="color: #888;">No exercise logs found for this session.</p>
{/if}

{#if missingSets && missingSets.length > 0 && missingPlacement === 'bottom'}
<div style="background: #ffebee; border: 1px solid #ffcdd2; border-radius: 8px; padding: 12px 15px; margin-top: 20px;">
  <div style="font-weight: 600; color: #c62828; margin-bottom: 8px;">Missing</div>
  {#each missingSets as item}
    <div style="color: #c62828; font-size: 0.9em; margin-bottom: 4px;">
      {item.count} {item.count === 1 ? 'set' : 'sets'} of {item.name}
    </div>
  {/each}
</div>
{/if}
