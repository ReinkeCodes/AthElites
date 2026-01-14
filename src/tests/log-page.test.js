import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

// Mock data - must be defined before vi.mock calls
const mockHistory = [
	{ id: '1', exercise: 'Squat', weight: 225, reps: 5, date: '2025-01-13' },
	{ id: '2', exercise: 'Bench Press', weight: 185, reps: 8, date: '2025-01-12' }
];

// Mock Firebase - using factory functions to avoid hoisting issues
vi.mock('$lib/firebase.js', () => ({
	db: {}
}));

vi.mock('firebase/firestore', () => {
	const mockAddDoc = vi.fn().mockResolvedValue({ id: 'new-doc-id' });
	const mockDeleteDoc = vi.fn().mockResolvedValue(undefined);
	const mockOnSnapshot = vi.fn((query, callback) => {
		callback({
			docs: [
				{ id: '1', data: () => ({ exercise: 'Squat', weight: 225, reps: 5, date: '2025-01-13' }) },
				{ id: '2', data: () => ({ exercise: 'Bench Press', weight: 185, reps: 8, date: '2025-01-12' }) }
			]
		});
		return vi.fn();
	});
	const mockCollection = vi.fn().mockReturnValue('mock-collection-ref');
	const mockDoc = vi.fn().mockReturnValue('mock-doc-ref');
	const mockQuery = vi.fn().mockReturnValue('mock-query');
	const mockOrderBy = vi.fn().mockReturnValue('mock-order-by');

	return {
		collection: mockCollection,
		addDoc: mockAddDoc,
		onSnapshot: mockOnSnapshot,
		orderBy: mockOrderBy,
		query: mockQuery,
		deleteDoc: mockDeleteDoc,
		doc: mockDoc
	};
});

// Import component after mocks
import LogPage from '../routes/log/+page.svelte';
import { collection, addDoc, deleteDoc, onSnapshot, orderBy, query, doc } from 'firebase/firestore';

describe('Log Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders the page title', () => {
		render(LogPage);
		expect(screen.getByRole('heading', { name: 'AthElites' })).toBeInTheDocument();
	});

	it('renders the exercise form with all inputs', () => {
		render(LogPage);

		expect(screen.getByLabelText(/exercise/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/weight/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/reps/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/date/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /log exercise/i })).toBeInTheDocument();
	});

	it('renders history section', () => {
		render(LogPage);
		expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /clear all history/i })).toBeInTheDocument();
	});

	it('displays exercise history from Firebase', async () => {
		render(LogPage);

		// Check that mock history items are displayed
		expect(screen.getByText(/Squat.*225lbs.*5 reps/)).toBeInTheDocument();
		expect(screen.getByText(/Bench Press.*185lbs.*8 reps/)).toBeInTheDocument();
	});

	it('sets up Firestore listener on mount', () => {
		render(LogPage);

		expect(query).toHaveBeenCalled();
		expect(collection).toHaveBeenCalled();
		expect(orderBy).toHaveBeenCalledWith('date', 'desc');
		expect(onSnapshot).toHaveBeenCalled();
	});

	it('submits new exercise to Firebase', async () => {
		render(LogPage);

		const exerciseInput = screen.getByLabelText(/exercise/i);
		const weightInput = screen.getByLabelText(/weight/i);
		const repsInput = screen.getByLabelText(/reps/i);
		const submitButton = screen.getByRole('button', { name: /log exercise/i });

		await fireEvent.input(exerciseInput, { target: { value: 'Deadlift' } });
		await fireEvent.input(weightInput, { target: { value: '315' } });
		await fireEvent.input(repsInput, { target: { value: '3' } });
		await fireEvent.click(submitButton);

		expect(addDoc).toHaveBeenCalledWith('mock-collection-ref', expect.objectContaining({
			exercise: 'Deadlift',
			weight: 315,
			reps: 3
		}));
	});

	it('clears form after submission', async () => {
		render(LogPage);

		const exerciseInput = screen.getByLabelText(/exercise/i);
		const weightInput = screen.getByLabelText(/weight/i);
		const repsInput = screen.getByLabelText(/reps/i);
		const submitButton = screen.getByRole('button', { name: /log exercise/i });

		await fireEvent.input(exerciseInput, { target: { value: 'Deadlift' } });
		await fireEvent.input(weightInput, { target: { value: '315' } });
		await fireEvent.input(repsInput, { target: { value: '3' } });
		await fireEvent.click(submitButton);

		// Wait for async operations
		await vi.waitFor(() => {
			expect(exerciseInput).toHaveValue('');
			expect(weightInput).toHaveValue(0);
			expect(repsInput).toHaveValue(0);
		});
	});

	it('calls deleteDoc for each entry when clearing history', async () => {
		// Mock window.confirm
		const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

		render(LogPage);

		const clearButton = screen.getByRole('button', { name: /clear all history/i });
		await fireEvent.click(clearButton);

		expect(confirmSpy).toHaveBeenCalledWith('Delete all entries? This cannot be undone.');

		// Should delete all entries in history (2 items in mock)
		await vi.waitFor(() => {
			expect(deleteDoc).toHaveBeenCalledTimes(2);
		});

		confirmSpy.mockRestore();
	});

	it('does not delete when confirm is cancelled', async () => {
		const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

		render(LogPage);

		const clearButton = screen.getByRole('button', { name: /clear all history/i });
		await fireEvent.click(clearButton);

		expect(confirmSpy).toHaveBeenCalled();
		expect(deleteDoc).not.toHaveBeenCalled();

		confirmSpy.mockRestore();
	});

	it('has a link back to home', () => {
		render(LogPage);
		const homeLink = screen.getByRole('link', { name: /back to home/i });
		expect(homeLink).toHaveAttribute('href', '/');
	});
});
