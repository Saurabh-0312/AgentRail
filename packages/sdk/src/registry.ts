/**
 * Adapter selection by chain id. The id is the string ENS `rail.chain` will carry in Phase 3;
 * today callers pass it from config. No service URL lives here.
 */
import type { ChainId, PaymentAdapter } from "./types.ts";

export type AdapterFactory = () => PaymentAdapter;

export class AdapterRegistry {
  private readonly factories = new Map<ChainId, AdapterFactory>();

  register(chain: ChainId, factory: AdapterFactory): this {
    this.factories.set(chain, factory);
    return this;
  }

  chains(): ChainId[] {
    return [...this.factories.keys()];
  }

  /** Throws on an unknown chain: an agent must never pay on a rail it has no gate for. */
  select(chain: string): PaymentAdapter {
    const factory = this.factories.get(chain as ChainId);
    if (!factory) throw new Error(`no payment adapter for chain "${chain}" (known: ${this.chains().join(", ")})`);
    const adapter = factory();
    if (adapter.chain !== chain) throw new Error(`adapter registered for ${chain} reports ${adapter.chain}`);
    return adapter;
  }
}
