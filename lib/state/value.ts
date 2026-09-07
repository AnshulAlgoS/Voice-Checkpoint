import type { JsonValue, SemanticState } from './types.ts';

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function getAtPath(state: SemanticState, path: string): JsonValue | undefined {
  const parts = path.split('.').filter(Boolean);
  let current: JsonValue | undefined = state;
  for (const part of parts) {
    if (!current || Array.isArray(current) || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

export function setAtPath(state: SemanticState, path: string, value: JsonValue | undefined): void {
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) throw new Error('A merge field path cannot be empty.');
  let current: Record<string, JsonValue> = state;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || Array.isArray(next) || typeof next !== 'object') current[part] = {};
    current = current[part] as Record<string, JsonValue>;
  }
  const leaf = parts.at(-1)!;
  if (value === undefined) delete current[leaf];
  else current[leaf] = clone(value);
}
