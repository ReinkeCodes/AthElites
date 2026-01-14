import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Mock SvelteKit modules
vi.mock('$app/environment', () => ({
	browser: true,
	dev: true
}));
