// megaui:apps/next-app/components/login-form.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-02):
// - Validation: inline zod schema (no `@libs/validators` / `createValidators`).
//   Schema built inside `useMemo` so messages update with locale changes.
// - No `react-hook-form` / `@hookform/resolvers` — native React state +
//   `schema.safeParse()` on submit and per-field onBlur; lockfile unchanged.
// - No Turnstile/captcha (permanent non-goal, ADR-ARCH-04).
// - No `ResendVerificationDialog` (WA-02 scope: not building resend flow).
// - `FormError` receives pre-resolved `message` string (no `errorMessages`
//   map needed; simplifies this component's responsibility).
// - `authClient` from local `@/lib/auth-client` (WA-02) instead of
//   upstream's module-level `authClientReact`.
// - `callbackURL` defaults to `/{locale}/workspace` (not `/dashboard`).

"use client";

import { useEffect, useMemo, useState } from "react";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";

import { Alert, AlertDescription, AlertTitle, Button, FormError, Input, Label } from "@megaui/ui";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { resolvePostAuthPath } from "@/lib/post-auth-redirect";

export function LoginForm({ enterprise = false }: { enterprise?: boolean }) {
  if (enterprise) return <EnterpriseLoginForm />;

  const { t, locale } = useTranslation();

  const schema = useMemo(
    () =>
      z.object({
        email: z
          .string()
          .min(1, t.auth.signin.errors.requiredEmail)
          .email(t.auth.signin.errors.invalidEmail),
        password: z.string().min(1, t.auth.signin.errors.requiredPassword),
        remember: z.boolean(),
      }),
    [t],
  );

  type FormValues = z.infer<typeof schema>;

  const [values, setValues] = useState<FormValues>({
    email: "",
    password: "",
    remember: true,
  });
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof FormValues, string>>
  >({});
  const [error, setError] = useState<{
    code?: string;
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const validateAll = (): boolean => {
    const result = schema.safeParse(values);
    if (!result.success) {
      const errs: Partial<Record<keyof FormValues, string>> = {};
      for (const [k, msgs] of Object.entries(
        result.error.flatten().fieldErrors,
      )) {
        const key = k as keyof FormValues;
        errs[key] = (msgs as string[] | undefined)?.[0];
      }
      setFieldErrors(errs);
      return false;
    }
    setFieldErrors({});
    return true;
  };

  const validateField = (field: keyof FormValues) => {
    const result = schema.safeParse(values);
    if (!result.success) {
      const msgs = result.error.flatten().fieldErrors[field] as
        | string[]
        | undefined;
      setFieldErrors((prev) => ({ ...prev, [field]: msgs?.[0] }));
    } else {
      setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateAll()) return;

    setLoading(true);
    setError(null);

    const params = new URLSearchParams(window.location.search);
    const callbackURL = resolvePostAuthPath(params, locale);

    const { error: authError } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
      callbackURL,
      ...(values.remember ? { rememberMe: true } : {}),
    });

    if (authError) {
      const code = authError.code ?? "UNKNOWN_ERROR";
      const msg =
        t.auth.authErrors[code as keyof typeof t.auth.authErrors] ??
        t.auth.authErrors.UNKNOWN_ERROR;
      setError({ code, message: msg });
    }

    setLoading(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <FormError message={error?.message} code={error?.code} />
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="grid gap-6">
          {/* Email */}
          <div className="grid gap-2">
            <Label htmlFor="email">{t.auth.signin.email}</Label>
            <Input
              id="email"
              type="email"
              value={values.email}
              onChange={(e) =>
                setValues((v) => ({ ...v, email: e.target.value }))
              }
              onBlur={() => validateField("email")}
              placeholder={t.auth.signin.emailPlaceholder}
              autoComplete="email"
              disabled={loading}
              aria-invalid={Boolean(fieldErrors.email)}
            />
            {fieldErrors.email && (
              <span className="text-destructive text-xs">
                {fieldErrors.email}
              </span>
            )}
          </div>

          {/* Password */}
          <div className="grid gap-2">
            <div className="flex items-center">
              <Label htmlFor="password">{t.auth.signin.password}</Label>
              <Link
                href={`/${locale}/forgot-password`}
                className="ml-auto text-sm underline-offset-4 hover:underline"
              >
                {t.auth.signin.forgotPassword}
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              value={values.password}
              onChange={(e) =>
                setValues((v) => ({ ...v, password: e.target.value }))
              }
              onBlur={() => validateField("password")}
              autoComplete="current-password"
              disabled={loading}
              aria-invalid={Boolean(fieldErrors.password)}
            />
            {fieldErrors.password && (
              <span className="text-destructive text-xs">
                {fieldErrors.password}
              </span>
            )}
          </div>

          {/* Remember me */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="remember"
              checked={values.remember}
              onChange={(e) =>
                setValues((v) => ({ ...v, remember: e.target.checked }))
              }
              className="h-4 w-4 rounded border border-primary accent-primary"
            />
            <label
              htmlFor="remember"
              className="text-sm font-medium leading-none"
            >
              {t.auth.signin.rememberMe}
            </label>
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {loading ? t.auth.signin.submitting : t.auth.signin.submit}
          </Button>
        </div>

        <div className="text-center text-sm">
          {t.auth.signin.noAccount}{" "}
          <Link
            href={`/${locale}/signup`}
            className="underline underline-offset-4"
          >
            {t.auth.signin.signupLink}
          </Link>
        </div>
      </form>
    </div>
  );
}

const ENTERPRISE_CODE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{8}$/;

function EnterpriseLoginForm() {
  const router = useRouter();
  const { t, locale } = useTranslation();
  const copy = t.auth.signin.enterprise;
  const [alias, setAlias] = useState("");
  const [code, setCode] = useState("");
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [pairingToken, setPairingToken] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "pending" | "confirmed" | "expired">("idle");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  useEffect(() => {
    if (!pairingId || status !== "pending") return undefined;
    let active = true;
    const poll = async () => {
      const result = await authClient.enterprise.status(pairingId);
      if (!active || !result.ok) return;
      setStatus(result.status);
      if (result.status === "confirmed") setChallengeId(result.challengeId ?? null);
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [pairingId, status]);

  const errorText = (code: string) =>
    copy.errors[code as keyof typeof copy.errors] ?? copy.errors.UNKNOWN_ERROR;

  const requestPairing = async () => {
    const value = alias.trim();
    if (value.length < 3 || value.length > 64) {
      setError(errorText("INVALID_INPUT"));
      return;
    }
    setLoading(true);
    setError(null);
    setChallengeId(null);
    setStatus("idle");
    const result = await authClient.enterprise.request(value);
    if (!result.ok) {
      setError(errorText(result.error));
      setLoading(false);
      return;
    }
    setPairingId(result.pairingId);
    setPairingToken(result.pairingToken);
    setCooldownUntil(Date.now() + result.resendAfter * 1_000);
    setStatus("pending");
    setLoading(false);
  };

  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (!challengeId || !ENTERPRISE_CODE.test(normalized)) {
      setError(errorText("INVALID_INPUT"));
      return;
    }
    setLoading(true);
    setError(null);
    const result = await authClient.enterprise.verify(challengeId, normalized);
    if (!result.ok) {
      setError(errorText(result.error));
      setLoading(false);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    router.push(resolvePostAuthPath(params, locale));
  };

  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1_000));

  return (
    <div className="flex flex-col gap-4" data-testid="enterprise-login">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
      </div>
      <FormError message={error ?? undefined} />
      {!pairingId && (
        <form onSubmit={(event) => { event.preventDefault(); void requestPairing(); }} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="enterprise-alias">{copy.alias}</Label>
            <Input
              id="enterprise-alias"
              data-testid="enterprise-alias"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder={copy.aliasPlaceholder}
              autoComplete="username"
              disabled={loading}
            />
          </div>
          <Button type="submit" data-testid="enterprise-request" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {loading ? copy.requesting : copy.request}
          </Button>
        </form>
      )}
      {pairingId && pairingToken && (
        <div className="flex flex-col gap-4">
          <Alert>
            <AlertTitle>{copy.instructions}</AlertTitle>
            <AlertDescription className="mt-2 space-y-2">
              <code data-testid="enterprise-command" className="block rounded bg-muted px-3 py-2 font-mono text-sm">
                {copy.commandPrefix} {pairingToken}
              </code>
              <p data-testid="enterprise-status" className="text-sm">
                {status === "pending" && copy.pending}
                {status === "confirmed" && copy.confirmed}
                {status === "expired" && copy.expired}
              </p>
            </AlertDescription>
          </Alert>
          {status === "confirmed" && challengeId && (
            <form onSubmit={(event) => void verify(event)} className="flex flex-col gap-4">
              <div className="grid gap-2">
                <Label htmlFor="enterprise-code">{copy.code}</Label>
                <Input
                  id="enterprise-code"
                  data-testid="enterprise-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 8))}
                  placeholder={copy.codePlaceholder}
                  inputMode="text"
                  autoComplete="one-time-code"
                  maxLength={8}
                  disabled={loading}
                />
              </div>
              <Button type="submit" data-testid="enterprise-verify" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {loading ? copy.verifying : copy.verify}
              </Button>
            </form>
          )}
          <Button
            type="button"
            variant="outline"
            data-testid="enterprise-resend"
            onClick={() => { void requestPairing(); }}
            disabled={loading || cooldown > 0}
          >
            {cooldown > 0 ? copy.resendWait.replace("{seconds}", String(cooldown)) : copy.resend}
          </Button>
        </div>
      )}
      <p className="text-center text-sm">
        <Link href={`/${locale}/signin`} className="underline underline-offset-4">{t.auth.signin.title}</Link>
      </p>
    </div>
  );
}
