// megaui:libs/auth/auth.ts@0ff3a9d (socialProviders slice)
//
// Diff vs upstream (GC-03, registered on the PK-06 task card):
// - Google/GitHub are opt-in via explicit credentials (default off /
//   fail-closed). Upstream always registered both providers from `@config`
//   and assumed clientId/clientSecret were present (`!` assertions).
// - Wechat social provider removed (SaaS strip / ADR-ARCH-04).

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface SocialProvidersInput {
  google?: OAuthClientCredentials | undefined;
  github?: OAuthClientCredentials | undefined;
}

export type ResolvedSocialProviders = {
  google?: {
    clientId: string;
    clientSecret: string;
  };
  github?: {
    clientId: string;
    clientSecret: string;
    mapProfileToUser: (profile: unknown) => { emailVerified: true };
  };
};

function hasCredentials(
  value: OAuthClientCredentials | undefined,
): value is OAuthClientCredentials {
  return Boolean(value?.clientId?.trim() && value?.clientSecret?.trim());
}

/**
 * Build better-auth `socialProviders` from optional credentials.
 * Missing / blank credentials omit that provider entirely (no throw).
 */
export function resolveSocialProviders(input: SocialProvidersInput): ResolvedSocialProviders {
  const providers: ResolvedSocialProviders = {};

  if (hasCredentials(input.google)) {
    providers.google = {
      clientId: input.google.clientId.trim(),
      clientSecret: input.google.clientSecret.trim(),
    };
  }

  if (hasCredentials(input.github)) {
    providers.github = {
      clientId: input.github.clientId.trim(),
      clientSecret: input.github.clientSecret.trim(),
      mapProfileToUser() {
        return { emailVerified: true };
      },
    };
  }

  return providers;
}

/**
 * Read Google/GitHub OAuth credentials from env. Blank / missing → omitted.
 */
export function resolveSocialProvidersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSocialProviders {
  return resolveSocialProviders({
    google: {
      clientId: env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    },
    github: {
      clientId: env.GITHUB_CLIENT_ID ?? "",
      clientSecret: env.GITHUB_CLIENT_SECRET ?? "",
    },
  });
}
