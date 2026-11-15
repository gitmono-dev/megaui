// megaui-only (FS-81): trusted environment for admin mutation boundaries.
// A handler must not choose the deployment key, instance or role used by the
// mutation guard. Only the process environment reaches the transaction.
export function trustedAdminEnv(): Record<string, string | undefined> {
  return process.env;
}
