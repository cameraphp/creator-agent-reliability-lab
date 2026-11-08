export interface Clock {
  now(): Date;
  /** Simulated latency. FakeClock advances logical time; SystemClock does not sleep. */
  elapse(ms: number): void;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  elapse(_ms: number): void {
    // Real time passes on its own; simulated provider latency is not slept.
  }
}

/** Deterministic logical clock for evaluation and tests. No sleeps, no timers. */
export class FakeClock implements Clock {
  private ms: number;
  constructor(start = Date.parse("2026-01-05T09:00:00.000Z")) {
    this.ms = start;
  }
  now(): Date {
    return new Date(this.ms);
  }
  elapse(ms: number): void {
    this.ms += ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(date: Date): void {
    if (date.getTime() > this.ms) this.ms = date.getTime();
  }
}
