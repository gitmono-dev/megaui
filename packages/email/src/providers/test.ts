// megaui:libs/email/providers/test.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-07 task card):
// - Upstream keeps recordings in module-level mutable state
//   (`const recorded: RecordedTestEmail[] = []`), shared across every
//   import of the module — tests must remember to call
//   `clearTestEmailRecordings()` between cases (GC-09: unisolated global
//   state). This port wraps the recordings in a factory
//   (`createTestEmailProvider`) so each test constructs its own isolated
//   in-memory store; no shared global, no manual reset needed.
import { randomUUID } from "node:crypto";
import type { EmailOptions, EmailProviderClient, EmailResponse } from "../types";

export interface RecordedTestEmail {
  id: string;
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string | undefined;
  cc: string | string[] | undefined;
  bcc: string | string[] | undefined;
  replyTo: string | undefined;
  recordedAt: string;
}

/** In-memory capture provider — succeeds and records every message for assertions. */
export interface TestEmailProvider extends EmailProviderClient {
  getAll(): readonly RecordedTestEmail[];
  getLast(): RecordedTestEmail | undefined;
  clear(): void;
}

export function createTestEmailProvider(): TestEmailProvider {
  const recorded: RecordedTestEmail[] = [];

  return {
    async send(options: EmailOptions): Promise<EmailResponse> {
      const id = randomUUID();
      recorded.push({
        id,
        to: options.to,
        from: options.from,
        subject: options.subject,
        html: options.html,
        text: options.text,
        cc: options.cc,
        bcc: options.bcc,
        replyTo: options.replyTo,
        recordedAt: new Date().toISOString(),
      });
      return { success: true, id };
    },
    getAll() {
      return recorded;
    },
    getLast() {
      return recorded[recorded.length - 1];
    },
    clear() {
      recorded.length = 0;
    },
  };
}
