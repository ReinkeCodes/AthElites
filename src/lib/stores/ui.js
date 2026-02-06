import { writable } from 'svelte/store';

/** When true, the global nav bar is hidden (used by Focus Mode in /compare) */
export const hideNav = writable(false);
