import type { SemanticState } from './types.ts';
import { clone, getAtPath, setAtPath } from './value.ts';

export class MergeEngine {
  static selective<T extends SemanticState>(target: T, source: T, fields: string[]): T {
    if (!fields.length) throw new Error('Selective merge requires at least one field.');
    const uniqueFields = [...new Set(fields)];
    const result = clone(target);
    for (const field of uniqueFields) setAtPath(result, field, getAtPath(source, field));
    return result;
  }
}
