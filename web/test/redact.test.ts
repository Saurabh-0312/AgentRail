import { describe, expect, it } from "vitest";

import { firstLine, redact } from "../lib/redact";

describe("no server error text can carry a credential", () => {
  it("scrubs a keyed RPC URL's query string, a bearer token and a long path secret", () => {
    const msg = 'An internal error was received.\n\nURL: https://devnet.helius-rpc.com/?api-key=d6ed267c-24e1-43f2-a6c8-d34e3ac83471\nRequest body: {"method":"eth_blockNumber"}';
    const out = redact(msg);
    expect(out).not.toContain("d6ed267c");
    expect(out).toContain("https://devnet.helius-rpc.com/?api-key=…");
    expect(redact("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: Bearer …");
    expect(redact("URL: https://eth-sepolia.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz123456")).toBe("URL: https://eth-sepolia.g.alchemy.com/…");
    // ordinary URLs and addresses stay readable
    expect(redact("URL: https://sepolia.base.org/")).toBe("URL: https://sepolia.base.org/");
    expect(redact("address: 0x68822ce9109D9d71e99b07703cF6c851D0229AA9")).toContain("0x68822ce9109D9d71e99b07703cF6c851D0229AA9");
  });

  it("keeps the first line only, scrubbed and bounded", () => {
    const e = new Error("The contract function reverted\n\nURL: https://x.io/?token=secret-token-value\nDetails: Method not found");
    expect(firstLine(e)).toBe("The contract function reverted");
    expect(firstLine(new Error("x".repeat(500)), 50)).toHaveLength(50);
    expect(firstLine("plain string")).toBe("plain string");
  });
});
