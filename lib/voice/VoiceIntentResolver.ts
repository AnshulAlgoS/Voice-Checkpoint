import type { Checkpoint, CheckpointMeta, SemanticState } from '../state/types.ts';
import { parseCurrencyAmount, ReferenceResolver } from './ReferenceResolver.ts';
import type { Candidate, ResolutionResult } from './types.ts';

const FIELD_ALIASES: Record<string, string[]> = {
  accommodation: ['hotel', 'stay', 'accommodation', 'rahena', 'rahna', 'room', 'hotel room', 'ghar', 'lodging', 'resort'],
  transportation: ['travel', 'transportation', 'flight', 'train', 'yatra', 'aana jaana', 'safar', 'flight ticket', 'plane', 'airplane', 'rail', 'taxi', 'cab', 'bus'],
  budget: ['budget', 'budget amount', 'cost', 'price', 'kharcha', 'paisa', 'daam', 'rate', 'expense', 'total cost'],
  duration: ['duration', 'days', 'length of trip', 'kitne din', 'kitne dino ke liye', 'trip length', 'stay duration', 'number of days', 'din'],
  priorities: ['priorities', 'priority', 'pahle', 'pehle', 'important', 'first priority', 'preferences', 'prafarans'],
  destination: ['destination', 'jagah', 'jgh', 'place', 'city', 'go to', 'visiting', 'ghumne'],
  travelers: ['travelers', 'people', 'logo', 'log', 'number of people', 'members', 'passengers'],
  activities: ['activities', 'karenge', 'kya karenge', 'things to do', 'planned', 'sites', 'tourist spots'],
  currency: ['currency', 'mudra', 'inr', 'usd', 'rupee', 'dollars'],
  constraints: ['constraints', 'restrictions', 'rules', 'nishedh', 'simai'],
};

function flattenAliases(): Array<{ field: string; alias: string }> {
  const result: Array<{ field: string; alias: string }> = [];
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) result.push({ field, alias });
  }
  result.sort((a, b) => b.alias.length - a.alias.length);
  return result;
}

const FLAT_ALIASES = flattenAliases();

function detectFields(text: string): string[] {
  const found: Set<string> = new Set();
  for (const { field, alias } of FLAT_ALIASES) {
    if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) found.add(field);
  }
  return [...found];
}

function parseDuration(text: string): number | undefined {
  const direct = text.match(/(\d+)\s*(?:days?|din|dino?)\b/i);
  if (direct) return Number(direct[1]);
  const match = text.match(/([a-z-]+)\s*(?:days?|din|dino?)\b/i);
  if (match) {
    const eng = match[1].replace(/-/g, ' ');
    const tokens = eng.toLowerCase().split(/\s+/).filter(Boolean);
    const ENGLISH_NUMERALS_LOCAL: Record<string, number> = {
      zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
      eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
      eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
    };
    const HINDI_NUMERALS_LOCAL: Record<string, number> = {
      ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, pach: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
      bara: 12, pandrah: 15, bees: 20, pachchis: 25, tees: 30, chalis: 40, pachaas: 50, saath: 60, sattar: 70, assi: 80, nabbe: 90, sau: 100,
    };
    let total = 0; let current = 0; let matched = false;
    for (const t of tokens) {
      const v1 = ENGLISH_NUMERALS_LOCAL[t];
      const v2 = HINDI_NUMERALS_LOCAL[t];
      const v = v1 !== undefined ? v1 : v2;
      if (v === undefined) return undefined;
      matched = true;
      if (v >= 100) { total += (current || 1) * v; current = 0; }
      else current += v;
    }
    if (!matched) return undefined;
    return total + current;
  }
  return undefined;
}

function parsePriorities(text: string): string[] | undefined {
  const priorities: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => { if (!seen.has(p)) { seen.add(p); priorities.push(p); } };
  const m = text.match(/prioritize\s+(\w[\w\s-]*?)(?:,|\.|and|$)/i);
  if (m) add(m[1].trim().toLowerCase());
  if (/comfort|aram|araam|aaram|shandaar|shaandaar/i.test(text)) add('comfort');
  if (/value|sasta|kam kharch|budget first/i.test(text)) add('value');
  if (/local food|khaana|desi khana/i.test(text)) add('local food');
  if (/luxury|luxurious/i.test(text)) add('luxury');
  return priorities.length ? priorities : undefined;
}

function parseGenericNumber(text: string): number | undefined {
  const digits = text.match(/(\d+(?:\.\d+)?)/);
  if (digits) return Number(digits[1]);
  const words = parseCurrencyAmount(text);
  if (words !== undefined) return words;
  return undefined;
}

const HOTEL_NAMES = [
  'taj fort aguada', 'taj', 'casa baga', 'park hyatt', 'grand hyatt',
  'itc grand central', 'oberoi', 'leela', 'jw marriott', 'marriott',
  'ritz carlton', 'four seasons', 'novotel', 'radisson', 'hilton',
  'holiday inn', 'trident',
];
const TRANSPORT_VALUES: Record<string, string> = {
  flight: 'Flight', flights: 'Flight', airplane: 'Flight', plane: 'Flight', air: 'Flight',
  train: 'Konkan Express', railways: 'Konkan Express', rail: 'Konkan Express',
  bus: 'Bus', taxi: 'Taxi', cab: 'Cab', car: 'Car', own: 'Own vehicle',
};

function extractFieldValues(text: string, state: SemanticState | undefined): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  const budget = parseCurrencyAmount(text);
  if (budget !== undefined) changes.budget = budget;
  const duration = parseDuration(text);
  if (duration !== undefined) changes.duration = duration;
  const priorities = parsePriorities(text);
  if (priorities) changes.priorities = priorities;
  if (changes.accommodation === undefined) {
    for (const name of HOTEL_NAMES) {
      if (new RegExp(`\\b${name.replace(/\s+/g, '\\s+')}\\b`, 'i').test(text)) {
        changes.accommodation = name.replace(/\b\w/g, (c) => c.toUpperCase());
        break;
      }
    }
  }
  if (changes.transportation === undefined) {
    for (const [kw, val] of Object.entries(TRANSPORT_VALUES)) {
      if (new RegExp(`\\b${kw}\\b`, 'i').test(text)) {
        changes.transportation = val;
        break;
      }
    }
  }
  if (state && typeof state.destination === 'string') {
    const destMatch = text.match(/(?:destination|jagah|place|for)\s+(?:is|to|ko|mein|hai|trip)?\s*["'`]?([A-Z][A-Za-z\s-]{1,40})/);
    if (destMatch) changes.destination = destMatch[1].trim();
    if (!changes.destination) {
      const simple = text.match(/\b(Goa|Kerala|Rajasthan|Jaipur|Udaipur|Mumbai|Delhi|Bangalore|Chennai|Kolkata|Shimla|Manali|Ladakh|Andaman)\b/i);
      if (simple) changes.destination = simple[1].replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  for (const { field, alias } of FLAT_ALIASES) {
    if (changes[field] !== undefined) continue;
    const pat = new RegExp(`(?:change|update|set|make|ko)\\s+(?:the\\s+)?(${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s+(?:to|into|ko|mein|banao|kardo|kar do)\\s+["'\`]?([A-Za-z0-9][A-Za-z0-9\\s.,_-]{0,60})`, 'i');
    const m = text.match(pat);
    if (m) {
      const raw = m[2].trim().replace(/[.,!?"'`]+$/g, '');
      if (typeof state?.[field] === 'number') {
        const num = parseGenericNumber(raw);
        if (num !== undefined) changes[field] = num;
      } else if (Array.isArray(state?.[field])) {
        changes[field] = raw.split(/[,，]\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean);
      } else if (typeof state?.[field] === 'boolean') {
        changes[field] = /true|yes|haan|ji|on|enable|kar do|yes/i.test(raw);
      } else {
        changes[field] = raw;
      }
      continue;
    }
    const toPat = new RegExp(`${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?:to|ko|banaye|banao|badlo|kardo|kar do)\\s+["'\`]?([A-Za-z0-9][A-Za-z0-9\\s.,_-]{0,60})`, 'i');
    const tm = text.match(toPat);
    if (tm) {
      const raw = tm[1].trim().replace(/[.,!?"'`]+$/g, '');
      if (typeof state?.[field] === 'number') {
        const num = parseGenericNumber(raw);
        if (num !== undefined) changes[field] = num;
      } else {
        changes[field] = raw;
      }
    }
  }
  if (state) {
    const known = new Set(Object.keys(state));
    for (const key of known) {
      if (changes[key] !== undefined) continue;
      const genericPat = new RegExp(`(?:change|update|set)\\s+(?:the\\s+)?${key}\\s+(?:to|into)\\s+["'\`]?([A-Za-z0-9][A-Za-z0-9\\s.,_-]{0,60})`, 'i');
      const gm = text.match(genericPat);
      if (gm) {
        const raw = gm[1].trim().replace(/[.,!?"'`]+$/g, '');
        if (typeof (state as Record<string, unknown>)[key] === 'number') {
          const num = parseGenericNumber(raw);
          if (num !== undefined) changes[key] = num;
        } else {
          changes[key] = raw;
        }
      }
    }
  }
  return changes;
}

function extractChanges(text: string, state: SemanticState | undefined): Record<string, unknown> & { budget?: number; duration?: number; priorities?: string[] } {
  return extractFieldValues(text, state);
}

function makeMeta(label: string, instruction: string, summary?: string): CheckpointMeta {
  return {
    label,
    userInstruction: instruction,
    summary: summary ?? label,
  };
}

function clarify<T extends SemanticState>(text: string, fallback: Candidate[]): ResolutionResult<T> {
  if (!fallback.length) {
    return { kind: 'clarification', question: text, candidates: [] };
  }
  return { kind: 'clarification', question: text, candidates: fallback };
}

export class VoiceIntentResolver<T extends SemanticState = SemanticState> {
  private refs = new ReferenceResolver<T>();

  resolve(input: string, checkpoints: Checkpoint<T>[], activeCheckpointId: string | null): ResolutionResult<T> {
    const transcript = input.trim();
    if (!transcript) return { kind: 'unsupported', reason: 'Enter a voice instruction.' };
    const text = transcript.toLowerCase();
    const active = checkpoints.find((c) => c.id === activeCheckpointId) ?? null;

    if (/^(undo|undo that|wapas|wapas karo|wapas le lo|revert|u?ndo\s+that\.?|actually,?\s*undo|udne do|phir se pehle)[.!]?$/i.test(text)) {
      return { kind: 'resolved', operation: { type: 'UNDO' } };
    }

    if (/undo\s+(?:the\s+)?last|last\s+(?:action|operation|step|change|kaam)\s+undo/i.test(text)) {
      return { kind: 'resolved', operation: { type: 'UNDO' } };
    }

    if (/compare|mukabla|muqabla|kya antar hai|difference|kya farak hai|compare karo|tulna|what changed|kya badla/i.test(text)) {
      if (!active) return clarify('Which two versions should I compare?', checkpoints.map((c) => ({ id: c.id, label: c.label, versionNumber: c.versionNumber, whyMatched: ['all'] })));
      const candidates = this.refs.resolve(text, checkpoints, activeCheckpointId, { excludeActive: true });
      if (candidates.length === 1) {
        return { kind: 'resolved', operation: { type: 'COMPARE', fromCheckpointId: candidates[0].id, toCheckpointId: active.id } };
      }
      const others = checkpoints.filter((c) => c.id !== activeCheckpointId);
      const fallback = others.map((c) => ({ id: c.id, label: c.label, versionNumber: c.versionNumber, whyMatched: ['non-active'] }));
      if (candidates.length > 1) return clarify('Which version should I compare with the active one?', candidates);
      if (others.length === 1) return { kind: 'resolved', operation: { type: 'COMPARE', fromCheckpointId: others[0].id, toCheckpointId: active.id } };
      return clarify('Which two versions should I compare?', fallback);
    }

    if (/go back one step|rewind one step|ek step peeche|ek kadam peeche|peeche ek step/i.test(text)) {
      return { kind: 'resolved', operation: { type: 'REWIND', steps: 1 } };
    }

    const switchLike =
      /go back|switch|return to|continue from|use (?:the\s+)?(?:previous|active|that|this|other|original)|wapas jao|pe wapas|pe le jao|le jao|dikhao|dikhaye|use karo|select karo|chuno|chuniye|activate|chaloo|chalao|open karo/i.test(text);

    if (switchLike) {
      const result = this.refs.resolveOne(text, checkpoints, activeCheckpointId);
      if (result.kind === 'exact') {
        return { kind: 'resolved', operation: { type: 'SWITCH_CHECKPOINT', checkpointId: result.candidate.id } };
      }
      if (result.kind === 'ambiguous') {
        return clarify('Which checkpoint do you mean?', result.candidates);
      }
      const all = checkpoints.map((c) => ({ id: c.id, label: c.label, versionNumber: c.versionNumber, whyMatched: ['all-checkpoints'] }));
      if (!checkpoints.length) return { kind: 'unsupported', reason: 'No checkpoints exist to switch to.' };
      return clarify('Which checkpoint do you mean?', all);
    }

    const mergeLike = /(?:take|merge|copy|bring|le lo|le aao|laao|lao|use karo|include|add)\s+(?:the\s+)?([\w\s-]*?)\s*(?:from|se)\s+/i.test(text) ||
      /(?:merge|le lo|lao)\s+.*\s*(?:from|se)\s+/i.test(text) ||
      /(?:selective merge|merge only)/i.test(text) ||
      /le\s+lo\s+|(?:hotel|stay|room)\s+le\s+lo/i.test(text);

    if (mergeLike) {
      if (!active) return { kind: 'unsupported', reason: 'Create a checkpoint first before merging fields.' };
      const src = this.refs.resolveOne(text, checkpoints, activeCheckpointId, { excludeActive: true });
      const specifiedFields = detectFields(text);
      if (specifiedFields.length === 0 && /hotel|stay|room|accommodation/i.test(text)) specifiedFields.push('accommodation');
      if (specifiedFields.length === 0) specifiedFields.push('accommodation');
      const keepRest = /but\s+(?:keep|don.?t change|don't change|dont change|leave|mat karna|change mat karna|baaki|baki)/i.test(text) ||
        /(?:sirf|only|sif|bas)\s+.*\s*(?:le\s+lo|change|merge)/i.test(text);
      if (keepRest) {
        // no-op semantically — selective merge is naturally rest-preserving
      }
      if (src.kind === 'exact') {
        const srcCp = src.candidate;
        const label = `${active.label} · ${specifiedFields.join('+')} from ${srcCp.label}`;
        return {
          kind: 'resolved',
          operation: {
            type: 'MERGE',
            sourceCheckpointId: srcCp.id,
            targetCheckpointId: active.id,
            fields: [...new Set(specifiedFields)],
            meta: makeMeta(label, transcript, `Selective ${specifiedFields.join(', ')} merge`),
          },
        };
      }
      if (src.kind === 'ambiguous') {
        return clarify('Which version should supply the fields?', src.candidates);
      }
      const others = checkpoints.filter((c) => c.id !== activeCheckpointId);
      const fallback = others.map((c) => ({ id: c.id, label: c.label, versionNumber: c.versionNumber, whyMatched: ['non-active'] }));
      return clarify('Which version should supply the fields?', fallback);
    }

    const forkLike =
      /another version|new version|fork|try another|naya version|naya banao|banao|banaye|ek aur|aur ek|new branch|dobra|dubara|once more|phir se ek|alternative|variant/i.test(text);

    if (forkLike) {
      const baseSrc = this.refs.resolveOne(text, checkpoints, activeCheckpointId);
      let baseId: string | undefined;
      if (baseSrc.kind === 'exact') baseId = baseSrc.candidate.id;
      else if (active) baseId = active.id;
      if (!baseId) return { kind: 'unsupported', reason: 'Create a checkpoint first before forking.' };
      const base = checkpoints.find((c) => c.id === baseId)!;
      const changes = extractChanges(text, base.structuredState) as Partial<T>;
      const budgetLabel = changes.budget ? `₹${Math.round(Number(changes.budget) / 1000)}k` : '';
      const priorityLabel = (changes.priorities as string[] | undefined)?.[0] ?? '';
      const titleParts = [budgetLabel, priorityLabel].filter(Boolean);
      const label = titleParts.length ? titleParts.join(' ') : `Fork of ${base.label}`;
      return {
        kind: 'resolved',
        operation: {
          type: 'FORK',
          sourceCheckpointId: base.id,
          changes,
          meta: makeMeta(label, transcript, 'Forked decision state'),
        },
      };
    }

    const updateLike =
      /change (?:the\s+)?|update (?:the\s+)?|set (?:the\s+)?|make (?:the\s+)?|kar do|kardo|banao|banaye|badlo|bada do|chhota karo|kam karo|zyada karo|increase|decrease|badao|ghatao|badal do|modify|\bko\b.*\b(?:kar do|kardo|banao|banaye|badlo|change)\b/i.test(text);

    if (updateLike) {
      if (!active) return { kind: 'unsupported', reason: 'Create a checkpoint first before updating state.' };
      const changes = extractChanges(text, active.structuredState) as Partial<T>;
      if (!Object.keys(changes).length) {
        return { kind: 'unsupported', reason: `I could not identify which fields to change from: ${transcript}` };
      }
      const labelParts: string[] = [];
      if ('budget' in changes && typeof changes.budget === 'number') labelParts.push(`₹${Math.round(Number(changes.budget) / 1000)}k`);
      if ('duration' in changes && typeof changes.duration === 'number') labelParts.push(`${changes.duration}d`);
      if ('priorities' in changes && Array.isArray(changes.priorities)) labelParts.push((changes.priorities as string[]).join('/'));
      const label = labelParts.length ? `${active.label} · ${labelParts.join(' · ')}` : `${active.label} · updated`;
      return {
        kind: 'resolved',
        operation: {
          type: 'UPDATE_STATE',
          changes,
          meta: makeMeta(label, transcript, 'State update on active branch'),
        },
      };
    }

    return { kind: 'unsupported', reason: `That instruction does not map to a Phase 2 state operation: ${transcript}` };
  }
}
