/**
 * The owner alert channel: a message on the AgentRail HCS audit topic (Hedera Consensus Service),
 * the same topic the Phase 2 demo writes `mandate.issued` / `payment.settled` / `payment.refused`
 * to. An alert is therefore a public, timestamped record next to the payments it is about.
 *
 * Signed by the agent's Hedera account (the x402 payer): posting an alert is the one thing the
 * agent does on Hedera outside a payment, and it costs a fraction of a cent.
 */
import { AccountId, Client, PrivateKey, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";

import type { Alert, AlertFn, AlertReceipt } from "./response.ts";

export interface HcsAlertConfig {
  accountId: string;
  privateKey: string;
  topicId: string;
  agentName?: string;
}

export function hcsAlert(cfg: HcsAlertConfig): AlertFn {
  const client = Client.forTestnet().setOperator(AccountId.fromString(cfg.accountId), PrivateKey.fromStringECDSA(cfg.privateKey));
  return async (alert: Alert): Promise<AlertReceipt> => {
    const message = JSON.stringify({
      v: 1,
      agent: cfg.agentName ?? "databot.agentrail.eth",
      event: "risk.alert",
      at: alert.at,
      severity: alert.severity,
      subject: alert.subject,
      findings: alert.findings,
      message: alert.message.slice(0, 700),
    });
    const tx = await new TopicMessageSubmitTransaction().setTopicId(cfg.topicId).setMessage(message).execute(client);
    await tx.getReceipt(client);
    const id = tx.transactionId.toString();
    return { channel: `hcs:${cfg.topicId}`, id, explorer: `https://hashscan.io/testnet/topic/${cfg.topicId}` };
  };
}
