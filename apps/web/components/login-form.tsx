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

import { useMemo, useState } from "react";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { z } from "zod";

import { Button, FormError, Input, Label } from "@megaui/ui";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { resolvePostAuthPath } from "@/lib/post-auth-redirect";

// FSL-132: the email and password form only; the old enterprise pairing form is gone.
export function LoginForm() {
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
