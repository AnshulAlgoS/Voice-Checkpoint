import type { Checkpoint, SemanticState } from '../state/types.ts';
import type { Candidate } from './types.ts';

const INDIAN_NUMERALS: Record<string, number> = {
  ek: 1, ik: 1, ekh: 1,
  do: 2, dono: 2,
  teen: 3,
  char: 4, chaar: 4,
  paanch: 5, pach: 5,
  chhe: 6, chah: 6,
  saat: 7,
  aath: 8, aat: 8,
  nau: 9, nao: 9,
  das: 10,
  bara: 12,
  pandrah: 15,
  bees: 20,
  pachchis: 25,
  tees: 30,
  chalis: 40, chaalis: 40,
  pachaas: 50,
  saath: 60, sath: 60,
  sattar: 70,
  assi: 80,
  nabbe: 90,
  sau: 100,
  hazar: 1000, hazaar: 1000,
  lakh: 100000, lac: 100000,
};

const ENGLISH_NUMERALS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, thousand: 1000, lakh: 100000, lac: 100000, million: 1000000,
};

function parseIndianNumerals(text: string): number | undefined {
  const tokens = text.toLowerCase().split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  let matched = false;
  for (const token of tokens) {
    const val = INDIAN_NUMERALS[token];
    if (val === undefined) return undefined;
    matched = true;
    if (val >= 100) {
      total += (current || 1) * val;
      current = 0;
    } else {
      current += val;
    }
  }
  if (!matched) return undefined;
  return total + current;
}

function parseEnglishNumerals(text: string): number | undefined {
  const tokens = text.toLowerCase().split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  let matched = false;
  for (const token of tokens) {
    const val = ENGLISH_NUMERALS[token];
    if (val === undefined) return undefined;
    matched = true;
    if (val >= 100) {
      total += (current || 1) * val;
      current = 0;
    } else {
      current += val;
    }
  }
  if (!matched) return undefined;
  return total + current;
}

export function parseCurrencyAmount(text: string): number | undefined {
  const cleaned = text.replace(/[,，]/g, '').replace(/[.!?。]+$/g, '').toLowerCase().trim();

  const symbolMatch = cleaned.match(/(?:₹|rs\.?|rupees?|inr)\s*(\d+(?:\.\d+)?)\s*(k|thousand|lakh|lac|hazar|hazaar|crore)?\b/);
  if (symbolMatch) {
    const base = Number(symbolMatch[1]);
    const suffix = (symbolMatch[2] || '').toLowerCase();
    const multiplier =
      suffix === 'lakh' || suffix === 'lac' ? 100000 :
      suffix === 'k' || suffix === 'thousand' || suffix === 'hazar' || suffix === 'hazaar' ? 1000 :
      suffix === 'crore' ? 10000000 : 1;
    return Math.round(base * multiplier);
  }

  const suffixMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*(k|thousand|lakh|lac|hazar|hazaar|crore)\b/);
  if (suffixMatch) {
    const base = Number(suffixMatch[1]);
    const suffix = suffixMatch[2].toLowerCase();
    const multiplier =
      suffix === 'lakh' || suffix === 'lac' ? 100000 :
      suffix === 'k' || suffix === 'thousand' || suffix === 'hazar' || suffix === 'hazaar' ? 1000 :
      suffix === 'crore' ? 10000000 : 1;
    return Math.round(base * multiplier);
  }

  const suffixMultiplier: Record<string, number> = {
    thousand: 1000, k: 1000, hazar: 1000, hazaar: 1000,
    lakh: 100000, lac: 100000, crore: 10000000,
    hundred: 100, sau: 100,
  };

  const tokenSplit = cleaned.split(/[\s-]+/).filter(Boolean);
  for (let start = 0; start < tokenSplit.length; start += 1) {
    for (let end = tokenSplit.length; end > start; end -= 1) {
      const slice = tokenSplit.slice(start, end).join(' ');
      const withSuffix = slice.match(/^([a-z\s-]+?)\s*(thousand|k|hazar|hazaar|lakh|lac|crore|hundred|sau)?$/);
      if (withSuffix) {
        const core = withSuffix[1].trim();
        const suf = withSuffix[2] || '';
        const sufMul = suf ? (suffixMultiplier[suf] ?? 1) : 1;
        const eng = core ? parseEnglishNumerals(core) : undefined;
        if (eng !== undefined) return Math.round(eng * sufMul);
        const hin = core ? parseIndianNumerals(core) : undefined;
        if (hin !== undefined) return Math.round(hin * sufMul);
      }
      const eng = parseEnglishNumerals(slice);
      if (eng !== undefined) return eng;
      const hin = parseIndianNumerals(slice);
      if (hin !== undefined) return hin;
    }
  }

  return undefined;
}

function toCandidate(checkpoint: Checkpoint, reasons: string[]): Candidate {
  return {
    id: checkpoint.id,
    label: checkpoint.label,
    versionNumber: checkpoint.versionNumber,
    whyMatched: reasons.length ? reasons : ['matched'],
  };
}

export class ReferenceResolver<T extends SemanticState = SemanticState> {
  resolve(
    input: string,
    checkpoints: Checkpoint<T>[],
    activeCheckpointId: string | null,
    options: { excludeActive?: boolean } = {},
  ): Candidate[] {
    const text = input.trim().toLowerCase();
    if (!text || !checkpoints.length) return [];

    const sorted = [...checkpoints].sort((a, b) => a.versionNumber - b.versionNumber);
    const activeIndex = sorted.findIndex((c) => c.id === activeCheckpointId);
    const active = activeIndex >= 0 ? sorted[activeIndex] : null;
    const pool = options.excludeActive ? sorted.filter((c) => c.id !== activeCheckpointId) : sorted;

    const matches: Map<string, { checkpoint: Checkpoint<T>; reasons: Set<string> }> = new Map();
    const addMatch = (checkpoint: Checkpoint<T>, reason: string) => {
      if (options.excludeActive && checkpoint.id === activeCheckpointId) return;
      const existing = matches.get(checkpoint.id);
      if (existing) existing.reasons.add(reason);
      else matches.set(checkpoint.id, { checkpoint, reasons: new Set([reason]) });
    };

    for (const checkpoint of pool) {
      const labelLo = checkpoint.label.toLowerCase();
      if (labelLo && text.includes(labelLo)) addMatch(checkpoint, `label: ${checkpoint.label}`);
    }

    for (const checkpoint of pool) {
      const vn = checkpoint.versionNumber;
      if (new RegExp(`\\bv${vn}\\b`, 'i').test(text)) addMatch(checkpoint, `version ref: V${vn}`);
      if (new RegExp(`\\bversion\\s+${vn}\\b`, 'i').test(text)) addMatch(checkpoint, `version ref: version ${vn}`);
      if (new RegExp(`\\bcp[- ]?${vn}\\b`, 'i').test(text)) addMatch(checkpoint, `checkpoint id: cp-${vn}`);
    }

    if (/original|first one|first version|pehla|sabse pehla|root|shuruaat/.test(text)) {
      const first = sorted[0];
      if (first && (!options.excludeActive || first.id !== activeCheckpointId)) addMatch(first, 'original/first');
    }

    if (/latest|abhi tak ka|sabse naya|newest|most recent/.test(text)) {
      const latest = sorted[sorted.length - 1];
      if (latest && (!options.excludeActive || latest.id !== activeCheckpointId)) addMatch(latest, 'latest/newest');
    }

    if (/previous|pichhla|pichhle|before that|last one|version before|peechhe wala|purana/.test(text)) {
      if (active && activeIndex > 0) {
        const prev = sorted[activeIndex - 1];
        if (prev && (!options.excludeActive || prev.id !== activeCheckpointId)) addMatch(prev, 'previous/last');
      } else if (sorted.length >= 2) {
        const prev = sorted[sorted.length - 2];
        if (prev && (!options.excludeActive || prev.id !== activeCheckpointId)) addMatch(prev, 'previous/last (second-to-last)');
      }
    }

    if (/this one|current|yahi|ye wala|yhi|iss wala|active|selected/.test(text)) {
      if (active && !options.excludeActive) addMatch(active, 'this/current/active');
    }

    if (/that one|other|wo wala|woh wala|dusra|doosra|baki|another one|the other/.test(text)) {
      for (const checkpoint of pool) {
        if (checkpoint.id !== activeCheckpointId) addMatch(checkpoint, 'that/other/non-active');
      }
    }

    const amount = parseCurrencyAmount(text);
    if (amount !== undefined) {
      for (const checkpoint of pool) {
        const budget = checkpoint.structuredState.budget;
        if (typeof budget === 'number' && Math.abs(budget - amount) < 1) {
          addMatch(checkpoint, `budget match: ₹${amount.toLocaleString('en-IN')}`);
        }
      }
    }

    const attrMatchers: Array<{ regex: RegExp; reason: string; predicate: (state: T, label: string) => boolean }> = [
      {
        regex: /luxury|comfort|luxurious|aram|araam|aaram|aaraam|comfortable|shandaar|shaandaar/,
        reason: 'luxury/comfort attribute',
        predicate: (state, label) => {
          const stateText = JSON.stringify(state).toLowerCase();
          return (
            label.toLowerCase().includes('luxury') ||
            label.toLowerCase().includes('comfort') ||
            stateText.includes('luxury') ||
            stateText.includes('comfort') ||
            (Array.isArray(state.priorities) && (state.priorities as string[]).some((p) => typeof p === 'string' && /comfort|luxury/.test(p.toLowerCase())))
          );
        },
      },
      {
        regex: /cheap|cheaper|budget|value|sasta|kam kharcha|kam kharch|bazaar|saaf suthra/,
        reason: 'cheaper/value attribute',
        predicate: (state, label) => {
          const lo = label.toLowerCase();
          return lo.includes('cheap') || lo.includes('practical') || lo.includes('value') || lo.includes('budget');
        },
      },
    ];

    for (const { regex, reason, predicate } of attrMatchers) {
      if (regex.test(text)) {
        for (const checkpoint of pool) {
          if (predicate(checkpoint.structuredState, checkpoint.label)) addMatch(checkpoint, reason);
        }
      }
    }

    if (/cheapest|sabse sasta|lowest budget/.test(text)) {
      const withBudget = pool.filter((c) => typeof c.structuredState.budget === 'number');
      if (withBudget.length) {
        withBudget.sort((a, b) => Number(a.structuredState.budget) - Number(b.structuredState.budget));
        addMatch(withBudget[0], 'cheapest/lowest budget');
      }
    }

    return [...matches.values()].map(({ checkpoint, reasons }) => toCandidate(checkpoint, [...reasons]));
  }

  resolveOne(
    input: string,
    checkpoints: Checkpoint<T>[],
    activeCheckpointId: string | null,
    options: { excludeActive?: boolean } = {},
  ): { kind: 'exact'; candidate: Candidate } | { kind: 'ambiguous'; candidates: Candidate[] } | { kind: 'none' } {
    const list = this.resolve(input, checkpoints, activeCheckpointId, options);
    if (list.length === 0) return { kind: 'none' };
    if (list.length === 1) return { kind: 'exact', candidate: list[0] };
    return { kind: 'ambiguous', candidates: list };
  }
}
