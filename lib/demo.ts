import { StateGraph } from './state/StateGraph.ts';
import type { GraphSnapshot } from './state/types.ts';

export interface TripState extends Record<
  string,
  import('./state/types.ts').JsonValue
> {
  destination: string;
  budget: number;
  currency: string;
  duration: number;
  travelers: number;
  accommodation: string;
  transportation: string;
  priorities: string[];
  constraints: string[];
  activities: string[];
  preferences: Record<string, import('./state/types.ts').JsonValue>;
}

export const practicalTrip: TripState = {
  destination: 'Goa',
  budget: 40000,
  currency: 'INR',
  duration: 5,
  travelers: 2,
  accommodation: 'Casa Baga',
  transportation: 'Konkan Express',
  priorities: ['value', 'local food'],
  constraints: ['under ₹40,000'],
  activities: ['Old Goa walk', 'Palolem beach'],
  preferences: { pace: 'balanced' },
};

export const INITIAL_DEMO_INSTRUCTION =
  'Plan a five-day trip to Goa for forty thousand rupees.';

function buildInitialSnapshot(): GraphSnapshot<TripState> {
  const g = new StateGraph<TripState>();
  g.create(practicalTrip, {
    label: '₹40k practical',
    userInstruction: INITIAL_DEMO_INSTRUCTION,
    summary: 'Five days in Goa with a value-first plan.',
  });
  const snap = g.export();
  const cp0 = snap.checkpoints[0]!;
  cp0.createdAt = '1970-01-01T00:00:00.000Z';
  return snap;
}

export const INITIAL_DEMO_SNAPSHOT: GraphSnapshot<TripState> =
  buildInitialSnapshot();

export function createDemoGraph(): StateGraph<TripState> {
  const graph = new StateGraph<TripState>();
  graph.create(practicalTrip, {
    label: '₹40k practical',
    userInstruction: INITIAL_DEMO_INSTRUCTION,
    summary: 'Five days in Goa with a value-first plan.',
  });
  return graph;
}

export function resetDemoGraph(graph: StateGraph<TripState>): void {
  graph.restore(structuredClone(INITIAL_DEMO_SNAPSHOT));
}

export const DEMO_SEQUENCE: ReadonlyArray<{
  label: string;
  transcript: string;
}> = [
  {
    label: 'Step 1: initial plan',
    transcript: 'Plan a five-day trip to Goa for forty thousand rupees.',
  },
  {
    label: 'Step 2: fork luxury',
    transcript:
      'Make another version assuming I can spend sixty thousand rupees, stay at Taj Fort Aguada, take a flight, and prioritize comfort.',
  },
  { label: 'Step 3: compare', transcript: 'Compare this with the original.' },
  { label: 'Step 4: switch original', transcript: 'Go back to the original.' },
  {
    label: 'Step 5: selective merge hotel',
    transcript:
      "Take the hotel from the luxury version but don't change anything else.",
  },
  { label: 'Step 6: what changed', transcript: 'What changed?' },
  { label: 'Step 7: undo', transcript: 'Undo that.' },
];
