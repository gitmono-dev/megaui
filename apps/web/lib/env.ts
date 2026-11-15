import { z } from "zod";

/**
 * Build-time env schema (imported by `next.config.ts`).
 * Runtime-only secrets (auth / DB) are read lazily in `lib/auth.ts`
 * and health so CI build stays green without baking secrets into the image.
 * Auth-mail configuration is parsed only in `lib/email-runtime.ts`.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  MEGAUI_APP_NAME: z.string().min(1).default("megaui"),
  // Shared authentication mode; an absent value keeps legacy behaviour.
  AUTH_MODE: z.enum(["legacy", "enterprise", "maintenance"]).default("legacy"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }

  return parsed.data;
}

export const env: Env = loadEnv();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `[@megaui/web] ${name} is required at runtime (GC-07 fail-closed)`,
    );
  }
  return value;
}

/** Runtime config for auth / DB (not validated at build). */
export function getRuntimeSecrets() {
  return {
    appName: env.MEGAUI_APP_NAME,
    databaseUrl: requireEnv("DATABASE_URL"),
    betterAuthSecret: requireEnv("BETTER_AUTH_SECRET"),
    betterAuthUrl: requireEnv("BETTER_AUTH_URL"),
    appBaseUrl: process.env.APP_BASE_URL?.trim() || requireEnv("BETTER_AUTH_URL"),
    trustedOrigins: process.env.BETTER_AUTH_TRUSTED_ORIGINS?.trim(),
    s3PublicUrl: process.env.S3_PUBLIC_URL?.trim(),
  };
}
