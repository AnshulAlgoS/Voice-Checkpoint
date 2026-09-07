import { StateGraph } from './state/StateGraph.ts';

export interface TripState extends Record<string, import('./state/types.ts').JsonValue> {
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
  destination: 'Goa', budget: 40000, currency: 'INR', duration: 5, travelers: 2,
  accommodation: 'Casa Baga', transportation: 'Konkan Express', priorities: ['value', 'local food'],
  constraints: ['under ₹40,000'], activities: ['Old Goa walk', 'Palolem beach'], preferences: { pace: 'balanced' },
};

export function createDemoGraph(): StateGraph<TripState> {
  const graph = new StateGraph<TripState>();
  graph.create(practicalTrip, { label: '₹40k practical', userInstruction: 'Plan a five-day trip to Goa for forty thousand rupees.', summary: 'Five days in Goa with a value-first plan.' });
  return graph;
}
