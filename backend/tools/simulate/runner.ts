/**
 * Flows, steps and failures. Every HTTP call and every named assertion is one step. A failed step records what
 * happened (method, URL, status, error body) and ends its flow; flows that need what the failed flow would have
 * made are skipped, and the run goes on with the rest.
 */

export interface Failure {
  flow: string;
  step: string;
  method?: string;
  url?: string;
  status?: number;
  expected?: string;
  body?: unknown;
  message: string;
}

export interface FlowResult {
  name: string;
  steps: number;
  passed: number;
  failed: number;
  ms: number;
  /** Why the flow did not run (a flow it needs failed) */
  skipped?: string;
  failures: Failure[];
}

/** Thrown by a failed step: stops the current flow (or the current `attempt`) */
export class StepFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

export class Runner {
  readonly flows: FlowResult[] = [];
  #current: FlowResult | undefined;

  get current(): FlowResult {
    if (!this.#current) throw new Error('no flow is running');
    return this.#current;
  }

  /**
   * Runs one flow. `needs` names the earlier flows it builds on: when one of them failed or was skipped, this
   * flow is skipped too (its data would be missing). A flow passes when none of its steps failed.
   */
  async flow(name: string, needs: string[], fn: () => Promise<void>): Promise<boolean> {
    const result: FlowResult = { name, steps: 0, passed: 0, failed: 0, ms: 0, failures: [] };
    this.flows.push(result);
    const missing = needs.filter((n) => !this.ok(n));
    if (missing.length) {
      result.skipped = `needs ${missing.join(', ')}`;
      console.log(`- ${name}: skipped (${result.skipped})`);
      return false;
    }
    this.#current = result;
    const t0 = Date.now();
    console.log(`> ${name}`);
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof StepFailure)) this.#record({ flow: name, step: 'unexpected error', message: (err as Error).stack ?? String(err) });
    } finally {
      result.ms = Date.now() - t0;
      this.#current = undefined;
    }
    const line = `  ${result.failed ? 'FAILED' : 'ok'}: ${result.passed}/${result.steps} steps in ${(result.ms / 1000).toFixed(1)}s`;
    console.log(line);
    return result.failed === 0;
  }

  /** True when the named flow ran without a failed step */
  ok(name: string): boolean {
    const f = this.flows.find((x) => x.name === name);
    return Boolean(f && !f.skipped && f.failed === 0);
  }

  /**
   * Runs part of a flow (one customer, one seller) so that its failure is recorded without ending the whole flow.
   * Returns undefined when it failed.
   */
  async attempt<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StepFailure) {
        console.log(`  ! ${label}: stopped after a failed step`);
        return undefined;
      }
      this.#record({ flow: this.current.name, step: label, message: (err as Error).stack ?? String(err) });
      return undefined;
    }
  }

  /** A passed step */
  pass(): void {
    this.current.steps++;
    this.current.passed++;
  }

  /** A failed step: recorded, then thrown to stop the flow */
  fail(f: Omit<Failure, 'flow'>): never {
    const failure = { flow: this.current.name, ...f };
    this.#record(failure);
    throw new StepFailure(failure);
  }

  /** A named assertion on what the API answered */
  check(step: string, ok: boolean, detail?: unknown): void {
    if (ok) return this.pass();
    this.fail({ step, message: `check failed: ${step}`, body: detail });
  }

  #record(f: Failure) {
    const r = this.current;
    r.steps++;
    r.failed++;
    r.failures.push(f);
    const where = f.method ? ` ${f.method} ${f.url} → ${f.status}${f.expected ? ` (expected ${f.expected})` : ''}` : '';
    const body = f.body === undefined ? '' : ` ${JSON.stringify(f.body).slice(0, 400)}`;
    console.log(`  ✗ ${f.step}:${where} ${f.message.split('\n')[0]}${body}`);
  }
}
