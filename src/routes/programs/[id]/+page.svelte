<script>
  import { page } from '$app/stores';
  import { auth, db } from '$lib/firebase.js';
  import { doc, onSnapshot, updateDoc, getDoc, collection, addDoc, getDocs, query, where } from 'firebase/firestore';
  import { onAuthStateChanged } from 'firebase/auth';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let program = $state(null);
  let userRole = $state(null);
  let clients = $state([]);
  let exercises = $state([]);
  let hasUnpublishedChanges = $state(false);
  let publishing = $state(false);
  let showCopyModal = $state(false);
  let selectedClientForCopy = $state('');

  // Copy day to another program
  let allPrograms = $state([]);
  let showCopyDayModal = $state(false);
  let copyDayIndex = $state(null);
  let selectedDestinationProgram = $state('');
  let programSearchQuery = $state('');
  let copyingDay = $state(false);
  let toastMessage = $state('');

  // Copy section to another program
  let showCopySectionModal = $state(false);
  let copySectionDayIndex = $state(null);
  let copySectionIndex = $state(null);
  let copyingSection = $state(false);

  // Day management
  let newDayName = $state('');
  let editingDayIndex = $state(null);
  let editDayName = $state('');

  // Section management
  let expandedDay = $state(null);
  let newSectionName = $state('');
  let newSectionMode = $state('full'); // 'full' or 'checkbox'
  let editingSectionIndex = $state(null);
  let editSectionName = $state('');
  let editSectionMode = $state('full');

  // Assign users search
  let assignUserSearch = $state('');

  // Exercise in section
  let addingExerciseToSection = $state(null);
  let exerciseSearchQuery = $state('');
  let exerciseTypeFilter = $state('');
  let selectedExerciseId = $state('');
  let isPickerOpen = $state(false);
  let pickerContainerRef = $state(null);
  let exerciseDetails = $state({ sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [], repsMetric: 'reps', weightMetric: 'weight' });

  // Video modal
  let videoModalExercise = $state(null);
  let pendingVideoExercise = $state(null);

  // Editing exercise in section
  let editingExercise = $state(null); // format: "dayIndex-sectionIndex-exerciseIndex"
  let editExerciseDetails = $state({ sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [], repsMetric: 'reps', weightMetric: 'weight' });

  // Drag and drop (exercises)
  let draggedExercise = $state(null); // { dayIndex, sectionIndex, exerciseIndex, exercise }
  let dropTargetSection = $state(null); // "dayIndex-sectionIndex"
  let dropTargetExerciseIndex = $state(null); // index within section for reorder

  // Drag and drop (sections)
  let draggedSection = $state(null); // { dayIndex, sectionIndex, section }
  let dropTargetSectionIndex = $state(null); // target index for section reorder

  // Generate stable unique IDs (Firestore-based, works on all browsers including mobile Safari)
  function generateId() {
    return doc(collection(db, '_')).id;
  }

  // Backfill missing IDs on days/sections/exercises, returns true if any were added
  function backfillIds(days) {
    if (!days) return false;
    let changed = false;
    for (const day of days) {
      if (!day.workoutTemplateId) { day.workoutTemplateId = generateId(); changed = true; }
      for (const section of day.sections || []) {
        if (!section.sectionTemplateId) { section.sectionTemplateId = generateId(); changed = true; }
        for (const exercise of section.exercises || []) {
          if (!exercise.workoutExerciseId) { exercise.workoutExerciseId = generateId(); changed = true; }
        }
      }
    }
    return changed;
  }

  let currentUserId = $state(null);
  let accessChecked = $state(false);

  // Check if current user owns this client-created program
  function isOwnClientProgram() {
    return program?.createdByRole === 'client' && program?.createdByUserId === currentUserId;
  }

  // Check access and redirect if needed - only runs once when both userRole and program are loaded
  function checkAccessAndRedirect() {
    const programId = $page.params.id;

    // DEBUG logging (REMOVE AFTER FIX)
    console.log('[DEBUG] checkAccessAndRedirect called:', {
      userRole,
      currentUserId,
      programId,
      programExists: !!program,
      createdByRole: program?.createdByRole,
      createdByUserId: program?.createdByUserId,
      assignedTo: program?.assignedTo,
      assignedToType: typeof program?.assignedTo,
      accessChecked
    });

    // Wait for both userRole and program to be loaded
    if (!userRole || !program || !currentUserId) {
      console.log('[DEBUG] Waiting for data - userRole:', userRole, 'program:', !!program, 'currentUserId:', currentUserId);
      return;
    }

    // Only check once
    if (accessChecked) return;
    accessChecked = true;

    // Admin/Coach can access any program (except client-created, but UI filters that)
    if (userRole === 'admin' || userRole === 'coach') {
      console.log('[DEBUG] Admin/Coach access granted');
      return;
    }

    // Client access check
    const isOwner = program.createdByRole === 'client' && program.createdByUserId === currentUserId;
    const isAssigned = Array.isArray(program.assignedTo) && program.assignedTo.includes(currentUserId);

    console.log('[DEBUG] Client access check:', { isOwner, isAssigned });

    if (!isOwner && !isAssigned) {
      console.log('[DEBUG] Redirecting - client does not own and is not assigned');
      goto(`/programs/${programId}/days`);
    } else {
      console.log('[DEBUG] Client access granted - isOwner:', isOwner, 'isAssigned:', isAssigned);
    }
  }

  onMount(() => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUserId = user.uid;
        const userDoc = await getDoc(doc(db, 'user', user.uid));
        if (userDoc.exists()) {
          userRole = userDoc.data().role;
          // Check access after role is loaded
          checkAccessAndRedirect();
        }
      }
    });

    const programId = $page.params.id;
    onSnapshot(doc(db, 'programs', programId), (snapshot) => {
      if (snapshot.exists()) {
        program = { id: snapshot.id, ...snapshot.data() };

        // Check access after program is loaded
        checkAccessAndRedirect();

        // Backfill missing IDs in both days and publishedDays
        const daysChanged = backfillIds(program.days);
        const publishedChanged = backfillIds(program.publishedDays);
        if (daysChanged || publishedChanged) {
          const updates = {};
          if (daysChanged) updates.days = program.days;
          if (publishedChanged) updates.publishedDays = program.publishedDays;
          updateDoc(doc(db, 'programs', programId), updates);
        }
        // Check for unpublished changes
        hasUnpublishedChanges = checkForUnpublishedChanges();
      }
    });

    onSnapshot(collection(db, 'user'), (snapshot) => {
      clients = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    });

    onSnapshot(collection(db, 'exercises'), (snapshot) => {
      exercises = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    });

    // Load all programs for copy day feature (admin/coach only)
    // This will be re-initialized after role is determined
  });

  // Watch for role changes and load programs appropriately
  $effect(() => {
    if (!userRole || !currentUserId) return;

    if (userRole === 'admin' || userRole === 'coach') {
      // Admin/Coach can load all programs for copy feature
      const unsub = onSnapshot(collection(db, 'programs'),
        (snapshot) => {
          allPrograms = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        },
        (error) => {
          console.error('Failed to load programs for copy feature:', error.code, error.message);
          toastMessage = `Failed to load programs: ${error.code}`;
          setTimeout(() => { toastMessage = ''; }, 5000);
        }
      );
      return () => unsub();
    } else if (userRole === 'client') {
      // Client: load only their own programs for copy feature
      const ownedQuery = query(
        collection(db, 'programs'),
        where('createdByUserId', '==', currentUserId)
      );
      const unsub = onSnapshot(ownedQuery,
        (snapshot) => {
          allPrograms = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        },
        (error) => {
          console.error('Failed to load programs for copy feature:', error.code, error.message);
          toastMessage = `Failed to load programs: ${error.code}`;
          setTimeout(() => { toastMessage = ''; }, 5000);
        }
      );
      return () => unsub();
    }
  });

  // Outside click detection for exercise picker
  $effect(() => {
    if (!isPickerOpen || !pickerContainerRef) return;
    function handleOutsideClick(e) {
      if (pickerContainerRef && !pickerContainerRef.contains(e.target)) {
        isPickerOpen = false;
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  });

  async function toggleAssignment(clientId) {
    // Use assignedToUids as canonical, fall back to assignedTo for legacy data
    const currentAssigned = program.assignedToUids || program.assignedTo || [];
    // Handle legacy string format
    const currentList = Array.isArray(currentAssigned) ? currentAssigned : [currentAssigned];
    const newAssigned = currentList.includes(clientId)
      ? currentList.filter(id => id !== clientId)
      : [...currentList, clientId];
    // Write to both assignedToUids (canonical) and assignedTo (backward compat)
    await updateDoc(doc(db, 'programs', program.id), {
      assignedToUids: newAssigned,
      assignedTo: newAssigned
    });
  }

  // Day functions
  async function addDay(e) {
    e.preventDefault();
    if (!newDayName.trim()) return;
    const newDay = { workoutTemplateId: generateId(), name: newDayName, sections: [] };
    await updateDoc(doc(db, 'programs', program.id), {
      days: [...(program.days || []), newDay]
    });
    newDayName = '';
  }

  async function deleteDay(dayIndex) {
    if (!confirm('Delete this day and all its exercises?')) return;
    const updatedDays = program.days.filter((_, i) => i !== dayIndex);
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
  }

  function startEditDay(dayIndex) {
    editingDayIndex = dayIndex;
    editDayName = program.days[dayIndex].name;
  }

  async function saveEditDay() {
    const updatedDays = [...program.days];
    updatedDays[editingDayIndex].name = editDayName;
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
    editingDayIndex = null;
    editDayName = '';
  }

  // Section functions
  async function addSection(dayIndex) {
    if (!newSectionName.trim()) return;
    const updatedDays = [...program.days];
    updatedDays[dayIndex].sections = [...(updatedDays[dayIndex].sections || []), {
      sectionTemplateId: generateId(),
      name: newSectionName,
      mode: newSectionMode,
      exercises: []
    }];
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
    newSectionName = '';
    newSectionMode = 'full';
  }

  async function deleteSection(dayIndex, sectionIndex) {
    if (!confirm('Delete this section?')) return;
    const updatedDays = [...program.days];
    updatedDays[dayIndex].sections = updatedDays[dayIndex].sections.filter((_, i) => i !== sectionIndex);
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
  }

  function startEditSection(dayIndex, sectionIndex) {
    const section = program.days[dayIndex].sections[sectionIndex];
    editingSectionIndex = `${dayIndex}-${sectionIndex}`;
    editSectionName = section.name;
    editSectionMode = section.mode || 'full';
  }

  async function saveEditSection(dayIndex, sectionIndex) {
    const updatedDays = [...program.days];
    updatedDays[dayIndex].sections[sectionIndex].name = editSectionName;
    updatedDays[dayIndex].sections[sectionIndex].mode = editSectionMode;
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
    editingSectionIndex = null;
    editSectionName = '';
    editSectionMode = 'full';
  }

  function cancelEditSection() {
    editingSectionIndex = null;
    editSectionName = '';
    editSectionMode = 'full';
  }

  // Exercise in section functions
  async function addExerciseToSection(dayIndex, sectionIndex) {
    if (!selectedExerciseId) return;
    const exercise = exercises.find(e => e.id === selectedExerciseId);
    if (!exercise) return;

    const updatedDays = [...program.days];
    const exerciseEntry = {
      workoutExerciseId: generateId(),
      exerciseId: selectedExerciseId,
      name: exercise.name,
      type: exercise.type,
      sets: exerciseDetails.sets,
      reps: exerciseDetails.reps,
      weight: exerciseDetails.weight,
      rir: exerciseDetails.rir,
      notes: exerciseDetails.notes,
      customReqs: exerciseDetails.customReqs || [],
      repsMetric: exerciseDetails.repsMetric || 'reps',
      weightMetric: exerciseDetails.weightMetric || 'weight'
    };
    updatedDays[dayIndex].sections[sectionIndex].exercises.push(exerciseEntry);
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });

    selectedExerciseId = '';
    exerciseDetails = { sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [], repsMetric: 'reps', weightMetric: 'weight' };
    exerciseSearchQuery = '';
    exerciseTypeFilter = '';
    isPickerOpen = false;
    addingExerciseToSection = null;
  }

  async function deleteExerciseFromSection(dayIndex, sectionIndex, exerciseIndex) {
    const updatedDays = [...program.days];
    updatedDays[dayIndex].sections[sectionIndex].exercises =
      updatedDays[dayIndex].sections[sectionIndex].exercises.filter((_, i) => i !== exerciseIndex);
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
  }

  function startEditExercise(dayIndex, sectionIndex, exerciseIndex) {
    const ex = program.days[dayIndex].sections[sectionIndex].exercises[exerciseIndex];
    editingExercise = `${dayIndex}-${sectionIndex}-${exerciseIndex}`;
    editExerciseDetails = {
      sets: ex.sets || '',
      reps: ex.reps || '',
      weight: ex.weight || '',
      rir: ex.rir || '',
      notes: ex.notes || '',
      customReqs: ex.customReqs ? [...ex.customReqs] : [],
      repsMetric: ex.repsMetric || 'reps',
      weightMetric: ex.weightMetric || 'weight'
    };
  }

  function cancelEditExercise() {
    editingExercise = null;
    editExerciseDetails = { sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [], repsMetric: 'reps', weightMetric: 'weight' };
  }

  async function saveEditExercise(dayIndex, sectionIndex, exerciseIndex) {
    const updatedDays = [...program.days];
    const ex = updatedDays[dayIndex].sections[sectionIndex].exercises[exerciseIndex];
    ex.sets = editExerciseDetails.sets;
    ex.reps = editExerciseDetails.reps;
    ex.weight = editExerciseDetails.weight;
    ex.rir = editExerciseDetails.rir;
    ex.notes = editExerciseDetails.notes;
    ex.customReqs = editExerciseDetails.customReqs;
    ex.repsMetric = editExerciseDetails.repsMetric;
    ex.weightMetric = editExerciseDetails.weightMetric;
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
    editingExercise = null;
    editExerciseDetails = { sets: '', reps: '', weight: '', rir: '', notes: '', customReqs: [], repsMetric: 'reps', weightMetric: 'weight' };
  }

  // Custom requirements for adding new exercise
  function addCustomReq() {
    exerciseDetails.customReqs = [...exerciseDetails.customReqs, { name: '', value: '' }];
  }

  function removeCustomReq(index) {
    exerciseDetails.customReqs = exerciseDetails.customReqs.filter((_, i) => i !== index);
  }

  // Custom requirements for editing exercise
  function addEditCustomReq() {
    editExerciseDetails.customReqs = [...editExerciseDetails.customReqs, { name: '', value: '' }];
  }

  function removeEditCustomReq(index) {
    editExerciseDetails.customReqs = editExerciseDetails.customReqs.filter((_, i) => i !== index);
  }

  // Normalize string for sorting: lowercase, remove common punctuation
  function normalizeForSort(str) {
    return (str || '').toLowerCase().replace(/[\s\-_\/\(\)]/g, '');
  }

  // Fuzzy match: ordered subsequence (case-insensitive)
  function fuzzyMatch(query, text) {
    if (!query) return true;
    const q = query.toLowerCase();
    const t = (text || '').toLowerCase();
    let qi = 0;
    for (let i = 0; i < t.length && qi < q.length; i++) {
      if (t[i] === q[qi]) qi++;
    }
    return qi === q.length;
  }

  // Get filtered and sorted clients for Assign-to-Users
  function getFilteredClients() {
    const q = assignUserSearch.trim();
    return clients
      .filter(c => {
        if (!q) return true;
        // Match displayName if present, otherwise match email
        const target = c.displayName || c.email || '';
        return fuzzyMatch(q, target);
      })
      .sort((a, b) => (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '', undefined, { sensitivity: 'base' }));
  }

  function getExercisesByType(type) {
    const query = exerciseSearchQuery.trim();
    return exercises
      .filter(e => e.type === type && fuzzyMatch(query, e.name))
      .sort((a, b) => normalizeForSort(a.name).localeCompare(normalizeForSort(b.name)));
  }

  function getAllTypesUnfiltered() {
    return [...new Set(exercises.map(e => e.type))]
      .sort((a, b) => normalizeForSort(a).localeCompare(normalizeForSort(b)));
  }

  function getAllExerciseTypes() {
    const baseTypes = exerciseTypeFilter
      ? [exerciseTypeFilter]
      : [...new Set(exercises.map(e => e.type))];
    return baseTypes
      .filter(type => getExercisesByType(type).length > 0)
      .sort((a, b) => normalizeForSort(a).localeCompare(normalizeForSort(b)));
  }

  // Extract YouTube video ID from URL (returns null if not YouTube)
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

  function openVideoModal(exercise) {
    pendingVideoExercise = exercise;
  }

  function confirmOpenVideo() {
    videoModalExercise = pendingVideoExercise;
    pendingVideoExercise = null;
  }

  function cancelOpenVideo() {
    pendingVideoExercise = null;
  }

  function closeVideoModal() {
    videoModalExercise = null;
  }

  function handleVideoModalKeydown(e) {
    if (e.key === 'Escape') closeVideoModal();
  }

  function handleConfirmKeydown(e) {
    if (e.key === 'Escape') cancelOpenVideo();
  }

  // Check if there are unpublished changes
  function checkForUnpublishedChanges() {
    if (!program) return false;
    // If never published, there are unpublished changes (if there are days)
    if (!program.publishedDays && program.days?.length > 0) return true;
    // Compare current days with published days
    return JSON.stringify(program.days) !== JSON.stringify(program.publishedDays);
  }

  // Publish current changes to clients
  async function publishChanges() {
    if (!program) return;
    publishing = true;
    try {
      // Deep copy days to publishedDays and ensure all IDs exist
      const publishedDays = JSON.parse(JSON.stringify(program.days || []));
      for (const day of publishedDays) {
        if (!day.workoutTemplateId) day.workoutTemplateId = generateId();
        for (const section of day.sections || []) {
          if (!section.sectionTemplateId) section.sectionTemplateId = generateId();
          for (const exercise of section.exercises || []) {
            if (!exercise.workoutExerciseId) exercise.workoutExerciseId = generateId();
          }
        }
      }
      await updateDoc(doc(db, 'programs', program.id), {
        publishedDays,
        lastPublished: new Date()
      });
      hasUnpublishedChanges = false;
    } catch (e) {
      console.error('Error publishing:', e);
    }
    publishing = false;
  }

  // Create a copy of this program for a specific client
  async function createClientCopy() {
    if (!selectedClientForCopy || !program) return;

    const client = clients.find(c => c.id === selectedClientForCopy);
    if (!client) return;

    const clientName = client.displayName || client.email.split('@')[0];

    // Create new program with client's name
    const newProgram = {
      name: `${program.name} (${clientName})`,
      description: program.description || '',
      days: JSON.parse(JSON.stringify(program.days || [])), // Deep copy
      publishedDays: JSON.parse(JSON.stringify(program.days || [])), // Already published
      assignedTo: [selectedClientForCopy],
      parentProgramId: program.id, // Reference to original
      isClientCopy: true,
      createdFor: selectedClientForCopy,
      createdAt: new Date(),
      lastPublished: new Date()
    };

    const docRef = await addDoc(collection(db, 'programs'), newProgram);

    showCopyModal = false;
    selectedClientForCopy = '';

    // Navigate to the new program
    goto(`/programs/${docRef.id}`);
  }

  function getClientName(clientId) {
    const client = clients.find(c => c.id === clientId);
    return client?.displayName || client?.email?.split('@')[0] || 'Unknown';
  }

  // Copy day to another program
  function openCopyDayModal(dayIndex) {
    copyDayIndex = dayIndex;
    selectedDestinationProgram = '';
    programSearchQuery = '';
    showCopyDayModal = true;
  }

  function closeCopyDayModal() {
    showCopyDayModal = false;
    copyDayIndex = null;
    selectedDestinationProgram = '';
    programSearchQuery = '';
  }

  function getFilteredPrograms() {
    return allPrograms
      .filter(p => p.id !== program.id)
      .filter(p => !programSearchQuery || p.name?.toLowerCase().includes(programSearchQuery.toLowerCase()))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  function getRecentPrograms() {
    return allPrograms
      .filter(p => p.id !== program.id && p.lastPublished)
      .sort((a, b) => {
        const da = a.lastPublished?.toDate ? a.lastPublished.toDate() : new Date(a.lastPublished);
        const db = b.lastPublished?.toDate ? b.lastPublished.toDate() : new Date(b.lastPublished);
        return db - da;
      })
      .slice(0, 5);
  }

  async function copyDayToProgram() {
    if (!selectedDestinationProgram || copyDayIndex === null) return;
    copyingDay = true;
    try {
      const destSnap = await getDoc(doc(db, 'programs', selectedDestinationProgram));
      if (!destSnap.exists()) throw new Error('Destination program not found');
      const destProgram = destSnap.data();
      const sourceDay = program.days[copyDayIndex];
      const copiedDay = JSON.parse(JSON.stringify(sourceDay));
      copiedDay.workoutTemplateId = generateId();
      for (const section of copiedDay.sections || []) {
        section.sectionTemplateId = generateId();
        for (const exercise of section.exercises || []) {
          exercise.workoutExerciseId = generateId();
        }
      }
      const updatedDays = [...(destProgram.days || []), copiedDay];
      await updateDoc(doc(db, 'programs', selectedDestinationProgram), { days: updatedDays });
      const destName = allPrograms.find(p => p.id === selectedDestinationProgram)?.name || 'program';
      toastMessage = `Copied to ${destName}`;
      setTimeout(() => { toastMessage = ''; }, 3000);
      closeCopyDayModal();
    } catch (e) {
      console.error('Copy day failed:', e);
      toastMessage = `Failed to copy day: ${e.message ?? 'Unknown error'}`;
      setTimeout(() => { toastMessage = ''; }, 5000);
    } finally {
      copyingDay = false;
    }
  }

  // Copy section to another program
  function openCopySectionModal(dayIndex, sectionIndex) {
    copySectionDayIndex = dayIndex;
    copySectionIndex = sectionIndex;
    selectedDestinationProgram = '';
    programSearchQuery = '';
    showCopySectionModal = true;
  }

  function closeCopySectionModal() {
    showCopySectionModal = false;
    copySectionDayIndex = null;
    copySectionIndex = null;
    selectedDestinationProgram = '';
    programSearchQuery = '';
  }

  async function copySectionToProgram() {
    if (!selectedDestinationProgram || copySectionDayIndex === null || copySectionIndex === null) return;
    copyingSection = true;
    try {
      const destSnap = await getDoc(doc(db, 'programs', selectedDestinationProgram));
      if (!destSnap.exists()) throw new Error('Destination program not found');
      const destProgram = destSnap.data();
      const updatedDays = [...(destProgram.days || [])];
      if (updatedDays.length === 0) {
        updatedDays.push({ workoutTemplateId: generateId(), name: 'Day 1', sections: [] });
      }
      const sourceSection = program.days[copySectionDayIndex].sections[copySectionIndex];
      const copiedSection = JSON.parse(JSON.stringify(sourceSection));
      copiedSection.sectionTemplateId = generateId();
      for (const exercise of copiedSection.exercises || []) {
        exercise.workoutExerciseId = generateId();
      }
      updatedDays[updatedDays.length - 1].sections.push(copiedSection);
      await updateDoc(doc(db, 'programs', selectedDestinationProgram), { days: updatedDays });
      const destName = allPrograms.find(p => p.id === selectedDestinationProgram)?.name || 'program';
      toastMessage = `Copied to ${destName}`;
      setTimeout(() => { toastMessage = ''; }, 3000);
      closeCopySectionModal();
    } catch (e) {
      console.error('Copy section failed:', e);
      toastMessage = `Failed to copy section: ${e.message ?? 'Unknown error'}`;
      setTimeout(() => { toastMessage = ''; }, 5000);
    } finally {
      copyingSection = false;
    }
  }

  // Drag and drop functions (exercises)
  function handleDragStart(e, dayIndex, sectionIndex, exerciseIndex) {
    if (draggedSection) return; // Don't start exercise drag while section is being dragged
    const exercise = program.days[dayIndex].sections[sectionIndex].exercises[exerciseIndex];
    draggedExercise = { dayIndex, sectionIndex, exerciseIndex, exercise };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ''); // Required for Firefox
  }

  function handleDragOver(e, dayIndex, sectionIndex) {
    if (draggedSection) return; // Ignore exercise drop zones when dragging a section
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dropTargetSection = `${dayIndex}-${sectionIndex}`;
  }

  function handleDragLeave(e) {
    // Only clear if leaving the section entirely
    if (!e.currentTarget.contains(e.relatedTarget)) {
      dropTargetSection = null;
    }
  }

  function handleDragEnd() {
    draggedExercise = null;
    dropTargetSection = null;
  }

  async function handleDrop(e, targetDayIndex, targetSectionIndex) {
    e.preventDefault();
    if (!draggedExercise || draggedSection) return; // Ignore if no exercise or section is being dragged

    const { dayIndex: sourceDayIndex, sectionIndex: sourceSectionIndex, exerciseIndex: sourceExerciseIndex, exercise } = draggedExercise;

    // Don't do anything if dropping in same section
    if (sourceDayIndex === targetDayIndex && sourceSectionIndex === targetSectionIndex) {
      draggedExercise = null;
      dropTargetSection = null;
      return;
    }

    const updatedDays = [...program.days];

    // Remove from source section
    updatedDays[sourceDayIndex].sections[sourceSectionIndex].exercises =
      updatedDays[sourceDayIndex].sections[sourceSectionIndex].exercises.filter((_, i) => i !== sourceExerciseIndex);

    // Add to target section
    updatedDays[targetDayIndex].sections[targetSectionIndex].exercises.push(exercise);

    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });

    draggedExercise = null;
    dropTargetSection = null;
  }

  function handleExerciseDragOver(e, dayIndex, sectionIndex, exIndex) {
    if (draggedSection) return; // Ignore when dragging a section
    e.preventDefault();
    e.stopPropagation();
    if (!draggedExercise) return;
    if (draggedExercise.dayIndex === dayIndex && draggedExercise.sectionIndex === sectionIndex) {
      dropTargetExerciseIndex = exIndex;
    }
  }

  async function handleExerciseReorder(e, dayIndex, sectionIndex, targetExIndex) {
    if (!draggedExercise) return;
    if (draggedExercise.dayIndex !== dayIndex || draggedExercise.sectionIndex !== sectionIndex) return;
    e.preventDefault();
    e.stopPropagation();
    if (draggedExercise.exerciseIndex === targetExIndex) { draggedExercise = null; dropTargetExerciseIndex = null; return; }
    const updatedDays = [...program.days];
    const exercises = updatedDays[dayIndex].sections[sectionIndex].exercises;
    const [moved] = exercises.splice(draggedExercise.exerciseIndex, 1);
    exercises.splice(targetExIndex, 0, moved);
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
    draggedExercise = null;
    dropTargetSection = null;
    dropTargetExerciseIndex = null;
  }

  // Section drag handlers
  function handleSectionDragStart(e, dayIndex, sectionIndex) {
    if (draggedExercise) return; // Don't start section drag while exercise is being dragged
    const section = program.days[dayIndex].sections[sectionIndex];
    draggedSection = { dayIndex, sectionIndex, section };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  }

  function handleSectionDragOver(e, dayIndex, sectionIndex) {
    if (!draggedSection || draggedSection.dayIndex !== dayIndex) return;
    e.preventDefault();
    e.stopPropagation();
    dropTargetSectionIndex = sectionIndex;
  }

  function handleSectionDragEnd() {
    draggedSection = null;
    dropTargetSectionIndex = null;
  }

  async function handleSectionReorder(e, dayIndex, targetSectionIndex) {
    if (!draggedSection || draggedSection.dayIndex !== dayIndex) return;
    e.preventDefault();
    e.stopPropagation();
    if (draggedSection.sectionIndex === targetSectionIndex) {
      draggedSection = null;
      dropTargetSectionIndex = null;
      return;
    }
    const updatedDays = [...program.days];
    const sections = updatedDays[dayIndex].sections;
    const [moved] = sections.splice(draggedSection.sectionIndex, 1);
    sections.splice(targetSectionIndex, 0, moved);
    await updateDoc(doc(db, 'programs', program.id), { days: updatedDays });
    draggedSection = null;
    dropTargetSectionIndex = null;
  }
</script>

{#if program && (userRole === 'admin' || userRole === 'coach' || isOwnClientProgram())}
  <h1>{program.name}</h1>
  {#if program.description}
    <p style="color: #666;">{program.description}</p>
  {/if}

  {#if isOwnClientProgram()}
    <div style="background: #e8f5e9; padding: 10px 15px; border-radius: 5px; margin-bottom: 15px; font-size: 0.9em;">
      <strong style="color: #388E3C;">Self-made Program</strong> — You can edit this program
    </div>

    <!-- Client Publish Section -->
    {#if hasUnpublishedChanges}
      <div style="background: #fff3e0; border: 2px solid #ff9800; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div>
            <strong style="color: #e65100;">Unpublished Changes</strong>
            <p style="margin: 5px 0 0 0; font-size: 0.9em; color: #666;">
              Your workouts won't reflect edits until you publish.
            </p>
          </div>
          <button
            onclick={publishChanges}
            disabled={publishing}
            style="padding: 10px 20px; background: #ff9800; color: white; border: none; cursor: pointer; font-weight: bold; border-radius: 5px;"
          >
            {publishing ? 'Publishing...' : 'Publish Changes'}
          </button>
        </div>
      </div>
    {:else if program.lastPublished}
      <div style="background: #e8f5e9; padding: 10px 15px; border-radius: 5px; margin-bottom: 15px; font-size: 0.9em; color: #2e7d32;">
        ✓ Published — Your workouts are up to date
      </div>
    {:else if program.days && program.days.length > 0}
      <!-- Has days but never published -->
      <div style="background: #fff3e0; border: 2px solid #ff9800; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div>
            <strong style="color: #e65100;">Ready to Publish</strong>
            <p style="margin: 5px 0 0 0; font-size: 0.9em; color: #666;">
              Publish your program to start workouts.
            </p>
          </div>
          <button
            onclick={publishChanges}
            disabled={publishing}
            style="padding: 10px 20px; background: #ff9800; color: white; border: none; cursor: pointer; font-weight: bold; border-radius: 5px;"
          >
            {publishing ? 'Publishing...' : 'Publish Changes'}
          </button>
        </div>
      </div>
    {/if}
  {:else if program.isClientCopy}
    <div style="background: #e3f2fd; padding: 10px 15px; border-radius: 5px; margin-bottom: 15px; font-size: 0.9em;">
      <strong>Custom Program</strong> — Created for {getClientName(program.createdFor)}
    </div>
  {/if}

  <!-- Admin/Coach only features -->
  {#if userRole === 'admin' || userRole === 'coach'}
    <!-- Publish Status Banner -->
    {#if hasUnpublishedChanges}
      <div style="background: #fff3e0; border: 2px solid #ff9800; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div>
            <strong style="color: #e65100;">Unpublished Changes</strong>
            <p style="margin: 5px 0 0 0; font-size: 0.9em; color: #666;">
              Clients won't see your changes until you publish.
            </p>
          </div>
          <button
            onclick={publishChanges}
            disabled={publishing}
            style="padding: 10px 20px; background: #ff9800; color: white; border: none; cursor: pointer; font-weight: bold; border-radius: 5px;"
          >
            {publishing ? 'Publishing...' : 'Publish to Clients'}
          </button>
        </div>
      </div>
    {:else if program.lastPublished}
      <div style="background: #e8f5e9; padding: 10px 15px; border-radius: 5px; margin-bottom: 15px; font-size: 0.9em; color: #2e7d32;">
        Published — Clients see the latest version
      </div>
    {/if}

    <!-- Action Buttons -->
    <div style="display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap;">
      <button onclick={() => showCopyModal = true} style="padding: 10px 15px; background: #2196F3; color: white; border: none; cursor: pointer; border-radius: 5px;">
        Create Copy for Client
      </button>
    </div>

    <!-- Copy Modal -->
    {#if showCopyModal}
      <div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 20px;">
        <div style="background: white; padding: 25px; border-radius: 10px; max-width: 400px; width: 100%;">
          <h3 style="margin: 0 0 15px 0;">Create Custom Copy</h3>
          <p style="color: #666; margin-bottom: 15px;">
            This will create a separate version of "{program.name}" specifically for one client. Changes to this copy won't affect the original.
          </p>

          <label style="display: block; margin-bottom: 15px;">
            <strong>Select Client:</strong>
            <select bind:value={selectedClientForCopy} style="width: 100%; padding: 10px; margin-top: 5px;">
              <option value="">-- Choose a client --</option>
              {#each clients.toSorted((a, b) => (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '', undefined, { sensitivity: 'base' })) as client}
                <option value={client.id}>{client.displayName || client.email}</option>
              {/each}
            </select>
          </label>

          {#if selectedClientForCopy}
            <p style="background: #f5f5f5; padding: 10px; border-radius: 5px; font-size: 0.9em;">
              New program will be named: <strong>"{program.name} ({getClientName(selectedClientForCopy)})"</strong>
            </p>
          {/if}

          <div style="display: flex; gap: 10px; margin-top: 20px;">
            <button
              onclick={createClientCopy}
              disabled={!selectedClientForCopy}
              style="flex: 1; padding: 12px; background: {selectedClientForCopy ? '#4CAF50' : '#ccc'}; color: white; border: none; cursor: {selectedClientForCopy ? 'pointer' : 'not-allowed'}; border-radius: 5px;"
            >
              Create Copy
            </button>
            <button onclick={() => { showCopyModal = false; selectedClientForCopy = ''; }} style="flex: 1; padding: 12px; background: #f5f5f5; border: 1px solid #ccc; cursor: pointer; border-radius: 5px;">
              Cancel
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Assign to Users -->
    <details style="margin-bottom: 20px;" ontoggle={(e) => { if (!e.currentTarget.open) assignUserSearch = ''; }}>
      <summary style="cursor: pointer; font-weight: bold;">Assign to Users ({program.assignedTo?.length || 0} assigned)</summary>
      <div style="padding: 10px; background: #f5f5f5; margin-top: 5px;">
        {#if clients.length === 0}
          <p>No users yet.</p>
        {:else}
          <input type="text" bind:value={assignUserSearch} placeholder="Search users…" style="width: 100%; padding: 6px 8px; margin-bottom: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9em;" />
          {@const filtered = getFilteredClients()}
          {#if filtered.length === 0}
            <p style="color: #999; font-size: 0.9em; margin: 8px 0;">No matches</p>
          {:else}
            {#each filtered as client}
              <label style="display: block; margin: 5px 0;">
                <input
                  type="checkbox"
                  checked={program.assignedTo?.includes(client.id)}
                  onchange={() => toggleAssignment(client.id)}
                />
                {client.displayName || client.email}
                {#if client.role && client.role !== 'client'}
                  <span style="background: #e3f2fd; color: #1565c0; padding: 1px 6px; border-radius: 8px; font-size: 0.7em; margin-left: 5px;">{client.role}</span>
                {/if}
                {#if client.displayName}
                  <span style="color: #888; font-size: 0.85em;">({client.email})</span>
                {/if}
              </label>
            {/each}
          {/if}
        {/if}
      </div>
    </details>
  {/if}

  <!-- Add Day -->
  <h2>Days</h2>
  <form onsubmit={addDay} style="margin-bottom: 15px;">
    <input type="text" bind:value={newDayName} placeholder="Day name (e.g. Leg Day, Push A)" style="padding: 8px; margin-right: 5px;" />
    <button type="submit">Add Day</button>
  </form>

  <!-- Days List -->
  {#if !program.days || program.days.length === 0}
    <p>No days added yet. Add a day to get started.</p>
  {:else}
    {#each program.days as day, dayIndex}
      <div style="border: 2px solid #333; padding: 15px; margin: 15px 0; border-radius: 8px;">
        <!-- Day Header -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          {#if editingDayIndex === dayIndex}
            <input type="text" bind:value={editDayName} style="padding: 5px; font-size: 1.1em;" />
            <div>
              <button onclick={saveEditDay}>Save</button>
              <button onclick={() => editingDayIndex = null}>Cancel</button>
            </div>
          {:else}
            <h3 style="margin: 0;">{day.name}</h3>
            <div>
              <button onclick={() => expandedDay = expandedDay === dayIndex ? null : dayIndex}>
                {expandedDay === dayIndex ? 'Collapse' : 'Expand'}
              </button>
              {#if userRole === 'admin' || userRole === 'coach'}
                <button onclick={() => openCopyDayModal(dayIndex)} style="background: #e3f2fd; border: 1px solid #2196F3; color: #1976D2;">Copy to…</button>
              {/if}
              <button onclick={() => startEditDay(dayIndex)}>Rename</button>
              <button onclick={() => deleteDay(dayIndex)}>Delete</button>
            </div>
          {/if}
        </div>

        <!-- Day Content (expanded) -->
        {#if expandedDay === dayIndex}
          <!-- Add Section -->
          <div style="margin: 10px 0; padding: 10px; background: #f0f0f0; border-radius: 5px;">
            <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center;">
              <input type="text" bind:value={newSectionName} placeholder="Section name (e.g. Warm-up, Main)" style="padding: 8px; flex: 1; min-width: 150px;" />
              <select bind:value={newSectionMode} style="padding: 8px;">
                <option value="full">Full Tracking (sets, reps, weight)</option>
                <option value="checkbox">Checkbox Only (just complete)</option>
              </select>
              <button onclick={() => addSection(dayIndex)}>Add Section</button>
            </div>
          </div>

          <!-- Sections -->
          {#if !day.sections || day.sections.length === 0}
            <p style="color: #888;">No sections yet. Add sections like "Warm-up", "Main", "Cool-down".</p>
          {:else}
            {#each day.sections as section, sectionIndex}
              <div
                style="border: 1px solid #ccc; padding: 10px; margin: 10px 0; background: {dropTargetSection === `${dayIndex}-${sectionIndex}` ? '#e3f2fd' : 'white'}; transition: background 0.2s; {dropTargetSection === `${dayIndex}-${sectionIndex}` ? 'border: 2px dashed #2196F3;' : ''} {dropTargetSectionIndex === sectionIndex && draggedSection && draggedSection.sectionIndex !== sectionIndex ? 'border-top: 3px solid #2196F3;' : ''} {draggedSection?.sectionIndex === sectionIndex ? 'opacity: 0.5;' : ''}"
                ondragover={(e) => { handleDragOver(e, dayIndex, sectionIndex); handleSectionDragOver(e, dayIndex, sectionIndex); }}
                ondragenter={() => { if (draggedExercise && (draggedExercise.dayIndex !== dayIndex || draggedExercise.sectionIndex !== sectionIndex)) dropTargetExerciseIndex = null; }}
                ondragleave={(e) => { handleDragLeave(e); if (!e.currentTarget.contains(e.relatedTarget)) dropTargetSectionIndex = null; }}
                ondrop={(e) => { handleDrop(e, dayIndex, sectionIndex); handleSectionReorder(e, dayIndex, sectionIndex); }}
              >
                {#if editingSectionIndex === `${dayIndex}-${sectionIndex}`}
                  <!-- Edit Section Mode -->
                  <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 10px;">
                    <input type="text" bind:value={editSectionName} style="padding: 5px; flex: 1;" />
                    <select bind:value={editSectionMode} style="padding: 5px;">
                      <option value="full">Full Tracking</option>
                      <option value="checkbox">Checkbox Only</option>
                    </select>
                    <button onclick={() => saveEditSection(dayIndex, sectionIndex)}>Save</button>
                    <button onclick={cancelEditSection}>Cancel</button>
                  </div>
                {:else}
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <!-- Section drag handle -->
                      <span
                        draggable="true"
                        ondragstart={(e) => handleSectionDragStart(e, dayIndex, sectionIndex)}
                        ondragend={handleSectionDragEnd}
                        style="cursor: grab; color: #999; font-size: 1.1em; padding: 4px; user-select: none;"
                        title="Drag to reorder section"
                      >⋮⋮</span>
                      <strong>{section.name}</strong>
                      <span style="background: {section.mode === 'checkbox' ? '#fff3e0' : '#e8f5e9'}; padding: 2px 8px; border-radius: 10px; font-size: 0.75em;">
                        {section.mode === 'checkbox' ? 'Checkbox' : 'Full Tracking'}
                      </span>
                    </div>
                    <div style="display: flex; gap: 5px;">
                      <button onclick={() => startEditSection(dayIndex, sectionIndex)} style="font-size: 0.8em;">Edit</button>
                      {#if userRole === 'admin' || userRole === 'coach'}
                        <button onclick={() => openCopySectionModal(dayIndex, sectionIndex)} style="font-size: 0.8em; background: #e3f2fd; border: 1px solid #2196F3; color: #1976D2;">Copy to…</button>
                      {/if}
                      <button onclick={() => deleteSection(dayIndex, sectionIndex)} style="font-size: 0.8em;">Remove</button>
                    </div>
                  </div>
                {/if}

                <!-- Exercises in Section -->
                {#if section.exercises && section.exercises.length > 0}
                  {#each section.exercises as ex, exIndex}
                    <div
                      draggable="true"
                      ondragstart={(e) => handleDragStart(e, dayIndex, sectionIndex, exIndex)}
                      ondragend={handleDragEnd}
                      ondragover={(e) => handleExerciseDragOver(e, dayIndex, sectionIndex, exIndex)}
                      ondragleave={() => { if (dropTargetExerciseIndex === exIndex) dropTargetExerciseIndex = null; }}
                      ondrop={(e) => handleExerciseReorder(e, dayIndex, sectionIndex, exIndex)}
                      style="padding: 10px; margin: 5px 0; background: #f9f9f9; border-left: 3px solid #4CAF50; cursor: grab; {draggedExercise?.dayIndex === dayIndex && draggedExercise?.sectionIndex === sectionIndex && draggedExercise?.exerciseIndex === exIndex ? 'opacity: 0.5;' : ''} {dropTargetExerciseIndex === exIndex && draggedExercise && draggedExercise.exerciseIndex !== exIndex ? 'border-top: 3px solid #2196F3;' : ''}"
                    >
                      {#if editingExercise === `${dayIndex}-${sectionIndex}-${exIndex}`}
                        <!-- Edit Mode -->
                        <strong>{ex.name}</strong>
                        <span style="color: #888; font-size: 0.8em;">({ex.type})</span>
                        <!-- Metric selectors -->
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; padding: 10px; background: #f0f7ff; border-radius: 5px;">
                          <div>
                            <label style="font-size: 0.8em; color: #666;">Reps measured as:</label>
                            <select bind:value={editExerciseDetails.repsMetric} style="width: 100%; padding: 5px; margin-top: 3px;">
                              <option value="reps">Reps (count)</option>
                              <option value="distance">Distance</option>
                            </select>
                          </div>
                          <div>
                            <label style="font-size: 0.8em; color: #666;">Weight measured as:</label>
                            <select bind:value={editExerciseDetails.weightMetric} style="width: 100%; padding: 5px; margin-top: 3px;">
                              <option value="weight">Weight (lbs)</option>
                              <option value="time">Time</option>
                            </select>
                          </div>
                        </div>
                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin: 10px 0;">
                          <input type="text" bind:value={editExerciseDetails.sets} placeholder="Sets" style="padding: 5px;" />
                          <input type="text" bind:value={editExerciseDetails.reps} placeholder={editExerciseDetails.repsMetric === 'distance' ? 'Distance' : 'Reps'} style="padding: 5px;" />
                          <input type="text" bind:value={editExerciseDetails.weight} placeholder={editExerciseDetails.weightMetric === 'time' ? 'Time' : 'Weight'} style="padding: 5px;" />
                        </div>
                        <div style="margin-bottom: 8px;">
                          <input type="text" bind:value={editExerciseDetails.rir} placeholder="RIR" style="padding: 5px; width: 100%;" />
                        </div>
                        <div style="margin-bottom: 8px;">
                          <input type="text" bind:value={editExerciseDetails.notes} placeholder="Notes" style="padding: 5px; width: 100%;" />
                        </div>

                        <!-- Custom Requirements -->
                        <div style="margin: 10px 0; padding: 10px; background: #fff3e0; border-radius: 5px;">
                          <strong style="font-size: 0.9em;">Custom Requirements:</strong>
                          {#each editExerciseDetails.customReqs as req, reqIndex}
                            <div style="display: flex; gap: 5px; margin-top: 5px; align-items: center;">
                              <input type="text" bind:value={editExerciseDetails.customReqs[reqIndex].name} placeholder="Category (e.g. Tempo)" style="flex: 1; padding: 5px;" />
                              <input type="text" bind:value={editExerciseDetails.customReqs[reqIndex].value} placeholder="Value (e.g. 3-1-2)" style="flex: 1; padding: 5px;" />
                              <label style="display: flex; align-items: center; gap: 3px; font-size: 0.75em; white-space: nowrap;">
                                <input type="checkbox" bind:checked={editExerciseDetails.customReqs[reqIndex].clientInput} />
                                Client input
                              </label>
                              <button onclick={() => removeEditCustomReq(reqIndex)} style="padding: 5px 10px;">✕</button>
                            </div>
                          {/each}
                          <button onclick={addEditCustomReq} style="margin-top: 8px; font-size: 0.85em;">+ Add Requirement</button>
                        </div>

                        <div style="margin-top: 10px;">
                          <button onclick={() => saveEditExercise(dayIndex, sectionIndex, exIndex)}>Save</button>
                          <button onclick={cancelEditExercise}>Cancel</button>
                        </div>
                      {:else}
                        <!-- View Mode -->
                        {@const repsLabel = ex.repsMetric === 'distance' ? '' : 'reps'}
                        {@const weightLabel = ex.weightMetric === 'time' ? '' : ''}
                        {@const libraryEx = exercises.find(e => e.id === ex.exerciseId)}
                        <div style="display: flex; justify-content: space-between; align-items: start;">
                          <div style="display: flex; align-items: start; gap: 10px;">
                            <span style="color: #999; cursor: grab; font-size: 1.2em; user-select: none;" title="Drag to move">⋮⋮</span>
                            <div>
                              <strong>{ex.name}</strong>
                              <span style="color: #888; font-size: 0.8em;">({ex.type})</span>
                              {#if libraryEx?.videoUrl?.trim()}
                                <button
                                  type="button"
                                  aria-label="Play video"
                                  onclick={(e) => { e.stopPropagation(); openVideoModal(libraryEx); }}
                                  style="background: #fff; border: 1px solid #9C27B0; color: #9C27B0; padding: 2px 6px; border-radius: 3px; font-size: 0.7em; margin-left: 5px; cursor: pointer;"
                                >▶ Video</button>
                              {/if}
                              {#if ex.repsMetric === 'distance' || ex.weightMetric === 'time'}
                                <span style="background: #e8f5e9; color: #2e7d32; padding: 2px 6px; border-radius: 3px; font-size: 0.7em; margin-left: 5px;">
                                  {ex.repsMetric === 'distance' ? 'Distance' : ''}{ex.repsMetric === 'distance' && ex.weightMetric === 'time' ? '/' : ''}{ex.weightMetric === 'time' ? 'Time' : ''}
                                </span>
                              {/if}
                              <br />
                              {#if ex.sets}{ex.sets} sets{/if}
                              {#if ex.reps} × {ex.reps} {ex.repsMetric === 'distance' ? '' : 'reps'}{/if}
                              {#if ex.weight} @ {ex.weight}{ex.weightMetric === 'time' ? '' : ''}{/if}
                              {#if ex.rir} (RIR: {ex.rir}){/if}
                              {#if ex.notes}<br /><em style="color: #666;">{ex.notes}</em>{/if}
                              {#if ex.customReqs && ex.customReqs.length > 0}
                                <div style="margin-top: 5px;">
                                  {#each ex.customReqs as req}
                                    {#if req.name && req.value}
                                      <span style="display: inline-block; background: #e3f2fd; padding: 2px 6px; border-radius: 3px; font-size: 0.8em; margin-right: 5px;">
                                        {req.name}: {req.value}
                                      </span>
                                    {/if}
                                  {/each}
                                </div>
                              {/if}
                            </div>
                          </div>
                          <div style="display: flex; gap: 5px;">
                            <button onclick={() => startEditExercise(dayIndex, sectionIndex, exIndex)} style="font-size: 0.8em;">Edit</button>
                            <button onclick={() => deleteExerciseFromSection(dayIndex, sectionIndex, exIndex)} style="font-size: 0.8em;">Remove</button>
                          </div>
                        </div>
                      {/if}
                    </div>
                  {/each}
                {/if}

                <!-- Add Exercise to Section -->
                {#if addingExerciseToSection === `${dayIndex}-${sectionIndex}`}
                  <div style="margin-top: 10px; padding: 10px; background: #e8f5e9; border-radius: 5px;">
                    <div style="margin-bottom: 8px; position: relative;" bind:this={pickerContainerRef}>
                      <input
                        type="text"
                        bind:value={exerciseSearchQuery}
                        placeholder="Select exercise…"
                        onfocus={() => isPickerOpen = true}
                        onkeydown={(e) => e.key === 'Escape' && (isPickerOpen = false)}
                        style="padding: 6px 8px; width: 100%; box-sizing: border-box; border: 1px solid #ccc; border-radius: {isPickerOpen ? '4px 4px 0 0' : '4px'}; font-size: 0.9em;"
                      />
                      {#if isPickerOpen}
                        <div style="border: 1px solid #ccc; border-top: none; border-radius: 0 0 4px 4px; background: white; position: absolute; left: 0; right: 0; z-index: 10;">
                          <div style="padding: 4px 6px; border-bottom: 1px solid #e0e0e0; background: #fafafa;">
                            <select bind:value={exerciseTypeFilter} style="width: 100%; padding: 3px 4px; font-size: 0.8em; border: 1px solid #ccc; border-radius: 3px;">
                              <option value="">All types</option>
                              {#each getAllTypesUnfiltered() as t}
                                <option value={t}>{t}</option>
                              {/each}
                            </select>
                          </div>
                          <div style="max-height: 180px; overflow-y: auto;">
                          {#each getAllExerciseTypes() as type}
                            <div style="padding: 4px 8px; background: #f5f5f5; font-weight: 600; font-size: 0.8em; color: #555; position: sticky; top: 0; border-bottom: 1px solid #e0e0e0;">{type}</div>
                            {#each getExercisesByType(type) as ex}
                              <div
                                role="option"
                                aria-selected={selectedExerciseId === ex.id}
                                onclick={() => { selectedExerciseId = ex.id; isPickerOpen = false; }}
                                onkeydown={(e) => e.key === 'Enter' && (selectedExerciseId = ex.id, isPickerOpen = false)}
                                tabindex="0"
                                style="padding: 4px 8px 4px 16px; cursor: pointer; font-size: 0.85em; line-height: 1.3; background: {selectedExerciseId === ex.id ? '#e3f2fd' : 'white'}; border-bottom: 1px solid #f0f0f0;"
                                onmouseenter={(e) => { if (selectedExerciseId !== ex.id) e.currentTarget.style.background = '#f5f5f5'; }}
                                onmouseleave={(e) => { e.currentTarget.style.background = selectedExerciseId === ex.id ? '#e3f2fd' : 'white'; }}
                              >{ex.name}</div>
                            {/each}
                          {/each}
                          {#if getAllExerciseTypes().length === 0}
                            <div style="padding: 8px; text-align: center; color: #999; font-size: 0.85em;">No matches</div>
                          {/if}
                          </div>
                        </div>
                      {/if}
                    </div>
                    <!-- Selected exercise info with video chip -->
                    {#if selectedExerciseId}
                      {@const selectedEx = exercises.find(e => e.id === selectedExerciseId)}
                      {#if selectedEx}
                        <div style="margin-bottom: 8px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 0.9em;">
                          <strong>{selectedEx.name}</strong>
                          <span style="color: #666;">({selectedEx.type})</span>
                          {#if selectedEx.videoUrl?.trim()}
                            <button
                              type="button"
                              onclick={(e) => { e.stopPropagation(); openVideoModal(selectedEx); }}
                              style="background: #fff; border: 1px solid #9C27B0; color: #9C27B0; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; cursor: pointer;"
                            >▶ Video</button>
                          {/if}
                        </div>
                      {/if}
                    {/if}
                    <!-- Metric selectors -->
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; padding: 10px; background: #f0f7ff; border-radius: 5px;">
                      <div>
                        <label style="font-size: 0.8em; color: #666;">Reps measured as:</label>
                        <select bind:value={exerciseDetails.repsMetric} style="width: 100%; padding: 5px; margin-top: 3px;">
                          <option value="reps">Reps (count)</option>
                          <option value="distance">Distance</option>
                        </select>
                      </div>
                      <div>
                        <label style="font-size: 0.8em; color: #666;">Weight measured as:</label>
                        <select bind:value={exerciseDetails.weightMetric} style="width: 100%; padding: 5px; margin-top: 3px;">
                          <option value="weight">Weight (lbs)</option>
                          <option value="time">Time</option>
                        </select>
                      </div>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-bottom: 8px;">
                      <input type="text" bind:value={exerciseDetails.sets} placeholder="Sets" style="padding: 5px;" />
                      <input type="text" bind:value={exerciseDetails.reps} placeholder={exerciseDetails.repsMetric === 'distance' ? 'Distance' : 'Reps'} style="padding: 5px;" />
                      <input type="text" bind:value={exerciseDetails.weight} placeholder={exerciseDetails.weightMetric === 'time' ? 'Time' : 'Weight'} style="padding: 5px;" />
                    </div>
                    <div style="margin-bottom: 8px;">
                      <input type="text" bind:value={exerciseDetails.rir} placeholder="RIR (Reps in Reserve)" style="padding: 5px; width: 100%;" />
                    </div>
                    <div style="margin-bottom: 8px;">
                      <input type="text" bind:value={exerciseDetails.notes} placeholder="Notes" style="padding: 5px; width: 100%;" />
                    </div>

                    <!-- Custom Requirements -->
                    <div style="margin: 10px 0; padding: 10px; background: #fff3e0; border-radius: 5px;">
                      <strong style="font-size: 0.9em;">Custom Requirements (optional):</strong>
                      {#each exerciseDetails.customReqs as req, reqIndex}
                        <div style="display: flex; gap: 5px; margin-top: 5px; align-items: center;">
                          <input type="text" bind:value={exerciseDetails.customReqs[reqIndex].name} placeholder="Category (e.g. Tempo)" style="flex: 1; padding: 5px;" />
                          <input type="text" bind:value={exerciseDetails.customReqs[reqIndex].value} placeholder="Value (e.g. 3-1-2)" style="flex: 1; padding: 5px;" />
                          <label style="display: flex; align-items: center; gap: 3px; font-size: 0.75em; white-space: nowrap;">
                            <input type="checkbox" bind:checked={exerciseDetails.customReqs[reqIndex].clientInput} />
                            Client input
                          </label>
                          <button onclick={() => removeCustomReq(reqIndex)} style="padding: 5px 10px;">✕</button>
                        </div>
                      {/each}
                      <button onclick={addCustomReq} style="margin-top: 8px; font-size: 0.85em;">+ Add Requirement</button>
                    </div>

                    <button onclick={() => addExerciseToSection(dayIndex, sectionIndex)}>Add Exercise</button>
                    <button onclick={() => { exerciseSearchQuery = ''; exerciseTypeFilter = ''; isPickerOpen = false; addingExerciseToSection = null; }}>Cancel</button>
                  </div>
                {:else}
                  <button onclick={() => addingExerciseToSection = `${dayIndex}-${sectionIndex}`} style="margin-top: 8px;">
                    + Add Exercise
                  </button>
                {/if}
              </div>
            {/each}
          {/if}
        {/if}
      </div>
    {/each}
  {/if}
{:else if !program || !userRole}
  <p>Loading...</p>
{:else}
  <!-- User doesn't have access - redirect in progress -->
  <p>Redirecting...</p>
{/if}

<!-- Copy Day Modal -->
{#if showCopyDayModal && copyDayIndex !== null}
  <div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 20px;" onclick={closeCopyDayModal}>
    <div style="background: white; padding: 25px; border-radius: 10px; max-width: 450px; width: 100%;" onclick={(e) => e.stopPropagation()}>
      <h3 style="margin: 0 0 15px 0;">Copy Day to Another Program</h3>
      <p style="color: #666; margin-bottom: 15px;">
        Copy "<strong>{program.days[copyDayIndex]?.name}</strong>" to another program.
      </p>

      {#if getRecentPrograms().length > 0}
        <div style="margin-bottom: 15px;">
          <label style="font-size: 0.85em; color: #666;">Recent Programs:</label>
          <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 5px;">
            {#each getRecentPrograms() as p}
              <button
                onclick={() => selectedDestinationProgram = p.id}
                style="padding: 6px 12px; border-radius: 20px; border: 1px solid {selectedDestinationProgram === p.id ? '#2196F3' : '#ddd'}; background: {selectedDestinationProgram === p.id ? '#e3f2fd' : 'white'}; cursor: pointer; font-size: 0.85em;"
              >
                {p.name}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <label style="display: block; margin-bottom: 15px;">
        <strong>Destination Program:</strong>
        <input type="text" bind:value={programSearchQuery} placeholder="Search programs…" style="width: 100%; padding: 8px; margin-top: 5px; margin-bottom: 5px; border: 1px solid #ddd; border-radius: 5px;" />
        <select bind:value={selectedDestinationProgram} style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
          <option value="">-- Select program --</option>
          {#each getFilteredPrograms() as p}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </label>

      {#if selectedDestinationProgram}
        <p style="background: #e8f5e9; padding: 10px; border-radius: 5px; font-size: 0.9em; color: #2e7d32;">
          Day will be added to the end of <strong>"{allPrograms.find(p => p.id === selectedDestinationProgram)?.name}"</strong>
        </p>
      {/if}

      <div style="display: flex; gap: 10px; margin-top: 20px;">
        <button
          onclick={copyDayToProgram}
          disabled={!selectedDestinationProgram || copyingDay}
          style="flex: 1; padding: 12px; background: {selectedDestinationProgram && !copyingDay ? '#4CAF50' : '#ccc'}; color: white; border: none; cursor: {selectedDestinationProgram && !copyingDay ? 'pointer' : 'not-allowed'}; border-radius: 5px;"
        >
          {copyingDay ? 'Copying…' : 'Copy Day'}
        </button>
        <button onclick={closeCopyDayModal} style="flex: 1; padding: 12px; background: #f5f5f5; border: 1px solid #ccc; cursor: pointer; border-radius: 5px;">
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Copy Section Modal -->
{#if showCopySectionModal && copySectionDayIndex !== null && copySectionIndex !== null}
  <div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 20px;" onclick={closeCopySectionModal}>
    <div style="background: white; padding: 25px; border-radius: 10px; max-width: 450px; width: 100%;" onclick={(e) => e.stopPropagation()}>
      <h3 style="margin: 0 0 15px 0;">Copy Section to Another Program</h3>
      <p style="color: #666; margin-bottom: 15px;">
        Copy "<strong>{program.days[copySectionDayIndex]?.sections[copySectionIndex]?.name}</strong>" to another program's last day.
      </p>

      {#if getRecentPrograms().length > 0}
        <div style="margin-bottom: 15px;">
          <label style="font-size: 0.85em; color: #666;">Recent Programs:</label>
          <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 5px;">
            {#each getRecentPrograms() as p}
              <button
                onclick={() => selectedDestinationProgram = p.id}
                style="padding: 6px 12px; border-radius: 20px; border: 1px solid {selectedDestinationProgram === p.id ? '#2196F3' : '#ddd'}; background: {selectedDestinationProgram === p.id ? '#e3f2fd' : 'white'}; cursor: pointer; font-size: 0.85em;"
              >
                {p.name}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <label style="display: block; margin-bottom: 15px;">
        <strong>Destination Program:</strong>
        <input type="text" bind:value={programSearchQuery} placeholder="Search programs…" style="width: 100%; padding: 8px; margin-top: 5px; margin-bottom: 5px; border: 1px solid #ddd; border-radius: 5px;" />
        <select bind:value={selectedDestinationProgram} style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
          <option value="">-- Select program --</option>
          {#each getFilteredPrograms() as p}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </label>

      {#if selectedDestinationProgram}
        <p style="background: #e8f5e9; padding: 10px; border-radius: 5px; font-size: 0.9em; color: #2e7d32;">
          Section will be added to the last day of <strong>"{allPrograms.find(p => p.id === selectedDestinationProgram)?.name}"</strong>{allPrograms.find(p => p.id === selectedDestinationProgram)?.days?.length ? '' : ' (Day 1 will be created)'}
        </p>
      {/if}

      <div style="display: flex; gap: 10px; margin-top: 20px;">
        <button
          onclick={copySectionToProgram}
          disabled={!selectedDestinationProgram || copyingSection}
          style="flex: 1; padding: 12px; background: {selectedDestinationProgram && !copyingSection ? '#4CAF50' : '#ccc'}; color: white; border: none; cursor: {selectedDestinationProgram && !copyingSection ? 'pointer' : 'not-allowed'}; border-radius: 5px;"
        >
          {copyingSection ? 'Copying…' : 'Copy Section'}
        </button>
        <button onclick={closeCopySectionModal} style="flex: 1; padding: 12px; background: #f5f5f5; border: 1px solid #ccc; cursor: pointer; border-radius: 5px;">
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Video Confirm Dialog -->
{#if pendingVideoExercise}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Open video confirmation"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2001;"
    onclick={(e) => { if (e.target === e.currentTarget) cancelOpenVideo(); }}
    onkeydown={handleConfirmKeydown}
  >
    <div style="background: white; border-radius: 8px; padding: 20px; max-width: 90%; width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <h3 style="margin: 0 0 12px 0; font-size: 1.1em;">Open video?</h3>
      <p style="margin: 0 0 20px 0; color: #666; font-size: 0.9em;">This video may load content from an external site (e.g., YouTube).</p>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button
          onclick={cancelOpenVideo}
          style="padding: 8px 16px; background: #fff; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;"
        >Cancel</button>
        <button
          onclick={confirmOpenVideo}
          style="padding: 8px 16px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer;"
        >Continue</button>
      </div>
    </div>
  </div>
{/if}

<!-- Video Modal -->
{#if videoModalExercise}
  {@const ytId = getYouTubeId(videoModalExercise.videoUrl)}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Video player"
    style="position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 2000;"
    onclick={(e) => { if (e.target === e.currentTarget) closeVideoModal(); }}
    onkeydown={handleVideoModalKeydown}
  >
    <div style="background: white; border-radius: 8px; max-width: 90%; width: 640px; max-height: 90vh; overflow: auto;">
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px; border-bottom: 1px solid #eee;">
        <h3 style="margin: 0;">{videoModalExercise.name}</h3>
        <button
          onclick={closeVideoModal}
          aria-label="Close"
          style="background: none; border: none; font-size: 1.5em; cursor: pointer; padding: 4px 8px;"
        >&times;</button>
      </div>
      <div style="padding: 16px;">
        {#if ytId}
          <div style="position: relative; padding-bottom: 56.25%; height: 0;">
            <iframe
              src="https://www.youtube.com/embed/{ytId}"
              title="Video player"
              frameborder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen
              style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border-radius: 4px;"
            ></iframe>
          </div>
        {:else}
          <p style="margin: 0 0 12px 0;">This video cannot be embedded.</p>
          <a
            href={videoModalExercise.videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            style="display: inline-block; padding: 10px 20px; background: #2196F3; color: white; text-decoration: none; border-radius: 4px;"
          >Open link</a>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- Toast -->
{#if toastMessage}
  <div style="position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #323232; color: white; padding: 12px 24px; border-radius: 8px; z-index: 2000; font-size: 0.95em;">
    {toastMessage}
  </div>
{/if}

