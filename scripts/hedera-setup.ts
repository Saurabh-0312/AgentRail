/**
 * One-time Hedera testnet setup for the x402 leg:
 *   1. associate the buyer (agent) account with HTS USDC 0.0.429274, so the Circle faucet can fund it
 *   2. create the seller account (payTo) with unlimited automatic token associations, so it can
 *      receive USDC without holding a key that ever has to sign
 *
 * Idempotent: skips whatever already exists. Prints the seller id + key to append to .env.
 * Run: node --env-file=.env scripts/hedera-setup.ts
 */
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
} from "@hiero-ledger/sdk";

const USDC = TokenId.fromString(process.env.HEDERA_TESTNET_USDC ?? "0.0.429274");
const buyerId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID!);
const buyerKey = PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY!);
const client = Client.forTestnet().setOperator(buyerId, buyerKey);

const mirror = async (path: string) =>
  (await fetch(`https://testnet.mirrornode.hedera.com/api/v1${path}`)).json() as Promise<any>;

async function associated(account: string): Promise<boolean> {
  const d = await mirror(`/accounts/${account}/tokens?token.id=${USDC.toString()}`);
  return (d.tokens ?? []).length > 0;
}

async function main() {
  console.log("buyer", buyerId.toString());
  if (await associated(buyerId.toString())) {
    console.log("  already associated with", USDC.toString());
  } else {
    const rx = await (await new TokenAssociateTransaction().setAccountId(buyerId).setTokenIds([USDC]).execute(client)).getReceipt(client);
    console.log("  associated:", rx.status.toString());
  }

  const existing = process.env.HEDERA_SELLER_PRIVATE_KEY;
  if (existing && process.env.HEDERA_SELLER_ACCOUNT_ID) {
    const info = await mirror(`/accounts/${process.env.HEDERA_SELLER_ACCOUNT_ID}`);
    console.log("seller", process.env.HEDERA_SELLER_ACCOUNT_ID, "exists; max auto associations:", info.max_automatic_token_associations);
    return;
  }

  const sellerKey = PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(sellerKey)
    .setInitialBalance(new Hbar(5))
    .setMaxAutomaticTokenAssociations(-1) // HIP-904: receive any token without an explicit association
    .execute(client);
  const rx = await tx.getReceipt(client);
  const sellerId = rx.accountId!.toString();
  console.log("seller created", sellerId, "tx", tx.transactionId.toString());
  console.log("\nappend to .env:");
  console.log(`HEDERA_SELLER_ACCOUNT_ID=${sellerId}`);
  console.log(`HEDERA_SELLER_PRIVATE_KEY=${sellerKey.toStringRaw()}`);
  console.log(`HEDERA_SELLER_EVM_ADDRESS=0x${sellerKey.publicKey.toEvmAddress()}`);
}

main()
  .then(() => client.close())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
