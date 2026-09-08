import type { GenerationToken } from './types.ts';

export class GenerationGate {
  private counter = 0;
  private current: GenerationToken;

  constructor() {
    this.current = this.make(this.counter);
  }

  get currentGeneration(): GenerationToken {
    return this.current;
  }

  issueToken(): GenerationToken {
    this.counter += 1;
    this.current = this.make(this.counter);
    return this.current;
  }

  isCurrent(token: GenerationToken): boolean {
    return token === this.current;
  }

  authorize(token: GenerationToken): boolean {
    return this.isCurrent(token);
  }

  private make(n: number): GenerationToken {
    return `gen-${n}` as GenerationToken;
  }
}
