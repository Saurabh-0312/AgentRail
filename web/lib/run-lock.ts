/**
 * One run at a time, globally, plus a short cooldown per client. Every run spends the owner's
 * budget, so two judges clicking together must not spend twice; a refused second click gets a
 * sentence, not a spinner. In-process by design: this is a demo trigger, not a scheduler.
 */
export interface Lease {
  ok: true;
  id: string;
  release(): void;
}

export interface Refusal {
  ok: false;
  status: 429;
  reason: string;
  retryAfterMs: number;
}

export interface RunLock {
  acquire(client: string, now?: number): Lease | Refusal;
  status(now?: number): { running: string | null; runningFor: number | null };
}

export function createRunLock(opts: { cooldownMs?: number } = {}): RunLock {
  const cooldownMs = opts.cooldownMs ?? 20_000;
  let running: { id: string; client: string; since: number } | null = null;
  const lastByClient = new Map<string, number>();
  let seq = 0;
  return {
    acquire(client, now = Date.now()) {
      if (running) {
        return { ok: false, status: 429, reason: `A run is already in progress (started ${Math.round((now - running.since) / 1000)} s ago). One run at a time: it spends the owner's budget.`, retryAfterMs: 5_000 };
      }
      const last = lastByClient.get(client);
      if (last !== undefined && now - last < cooldownMs) {
        const wait = cooldownMs - (now - last);
        return { ok: false, status: 429, reason: `You just ran the agent. Wait ${Math.ceil(wait / 1000)} s before the next run; each one spends real testnet USDC.`, retryAfterMs: wait };
      }
      const id = `run-${++seq}`;
      running = { id, client, since: now };
      lastByClient.set(client, now);
      return {
        ok: true,
        id,
        release: () => {
          if (running?.id === id) running = null;
        },
      };
    },
    status(now = Date.now()) {
      return { running: running?.id ?? null, runningFor: running ? now - running.since : null };
    },
  };
}
