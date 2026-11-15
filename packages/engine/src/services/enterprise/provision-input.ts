// megaui-only (FS-05): approved manifest parsing is shared by execution and replay.
import { z } from "zod";

export class ProvisionInputError extends Error {
  constructor() { super("INVALID_ARGUMENT"); this.name = "ProvisionInputError"; }
}
const text = (limit: number) => z.string().refine(value =>
  value.trim() !== "" && !value.includes("\0") && [...value].length <= limit &&
  ![...value].some(character => {
    const point = character.codePointAt(0) ?? 0;
    return point >= 0xd800 && point <= 0xdfff;
  }));
const memberSchema = z.object({
  tenant_key: text(256), app_id: text(256), open_id: text(256),
  login_name: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  display_name: text(256).nullable().optional(),
  notification_email: z.string().max(254).email().nullable().optional(),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1), members: z.array(memberSchema).min(1).max(100),
}).strict();

export interface ProvisionMember {
  readonly tenantKey: string;
  readonly appId: string;
  readonly openId: string;
  readonly loginName: string;
  readonly displayName: string;
  readonly notificationEmail: string | null;
}

/** No filesystem, deployment authority or provider access; consumes only pinned bytes. */
export function parseProvisionManifest(bytes: Uint8Array | undefined): readonly ProvisionMember[] {
  try {
    if (!bytes || bytes.byteLength > 1024 * 1024) throw new ProvisionInputError();
    const parsed = manifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (new Set(parsed.members.map(member => member.open_id)).size !== parsed.members.length ||
      new Set(parsed.members.map(member => member.login_name)).size !== parsed.members.length) {
      throw new ProvisionInputError();
    }
    return Object.freeze(parsed.members.map(member => Object.freeze({
      tenantKey: member.tenant_key, appId: member.app_id, openId: member.open_id,
      loginName: member.login_name, displayName: member.display_name ?? member.login_name,
      notificationEmail: member.notification_email ?? null,
    })));
  } catch { throw new ProvisionInputError(); }
}
