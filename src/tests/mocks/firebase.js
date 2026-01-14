import { vi } from 'vitest';

// Mock Firestore data
export const mockHistory = [
	{ id: '1', exercise: 'Squat', weight: 225, reps: 5, date: '2025-01-13' },
	{ id: '2', exercise: 'Bench Press', weight: 185, reps: 8, date: '2025-01-12' }
];

// Mock functions
export const mockAddDoc = vi.fn().mockResolvedValue({ id: 'new-doc-id' });
export const mockDeleteDoc = vi.fn().mockResolvedValue(undefined);
export const mockOnSnapshot = vi.fn((query, callback) => {
	// Simulate snapshot with mock data
	callback({
		docs: mockHistory.map(item => ({
			id: item.id,
			data: () => ({ exercise: item.exercise, weight: item.weight, reps: item.reps, date: item.date })
		}))
	});
	// Return unsubscribe function
	return vi.fn();
});

export const mockCollection = vi.fn().mockReturnValue('mock-collection-ref');
export const mockDoc = vi.fn().mockReturnValue('mock-doc-ref');
export const mockQuery = vi.fn().mockReturnValue('mock-query');
export const mockOrderBy = vi.fn().mockReturnValue('mock-order-by');

// Mock db object
export const mockDb = {};

// Setup the mock for $lib/firebase
export function setupFirebaseMock() {
	vi.mock('$lib/firebase.js', () => ({
		db: mockDb
	}));

	vi.mock('firebase/firestore', () => ({
		collection: mockCollection,
		addDoc: mockAddDoc,
		onSnapshot: mockOnSnapshot,
		orderBy: mockOrderBy,
		query: mockQuery,
		deleteDoc: mockDeleteDoc,
		doc: mockDoc
	}));
}

// Reset all mocks
export function resetFirebaseMocks() {
	mockAddDoc.mockClear();
	mockDeleteDoc.mockClear();
	mockOnSnapshot.mockClear();
	mockCollection.mockClear();
	mockDoc.mockClear();
	mockQuery.mockClear();
	mockOrderBy.mockClear();
}
