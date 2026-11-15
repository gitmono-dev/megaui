// megaui-only: legacy email/password sign-up form.
//
// Behaviour notes:
// - Native React state + zod `safeParse` (no form library, no captcha).
// - Only name / email / password are collected; profile extras are handled
//   elsewhere once the BFF supports them.
// - A successful sign-up that returns a session continues to the post-auth
//   path; one without a session means the server wants the address
//   confirmed first, so a confirmation notice is shown instead.
"use client";

import { useCallback, useMemo, useState } from "react";

import { Inbox, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";

import { Alert, AlertDescription, AlertTitle, Button, FormError, Input, Label } from "@megaui/ui";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { firstIssuePerField, toAuthErrorState, type AuthErrorState } from "@/lib/auth-form-helpers";
import { resolvePostAuthPath } from "@/lib/post-auth-redirect";

type FieldName = "name" | "email" | "password";
type FieldErrors = Partial<Record<FieldName, string>>;

type Phase =
  | { kind: "editing" }
  | { kind: "submitting" }
  | { kind: "awaiting-confirmation"; address: string };

const MIN_PASSWORD_LENGTH = 8;

export function SignupForm() {
  const router = useRouter();
  const { t, locale } = useTranslation();
  const copy = t.auth.signup;

  const schema = useMemo(
    () =>
      z.object({
        name: z.string().min(1, copy.errors.requiredName),
        email: z.string().min(1, copy.errors.requiredEmail).email(copy.errors.invalidEmail),
        password: z
          .string()
          .min(1, copy.errors.requiredPassword)
          .min(MIN_PASSWORD_LENGTH, copy.errors.invalidPassword),
      }),
    [copy],
  );

  const fields = useMemo(
    () =>
      [
        {
          name: "name",
          type: "text",
          label: copy.name,
          placeholder: copy.namePlaceholder,
          autoComplete: "name",
        },
        {
          name: "email",
          type: "email",
          label: copy.email,
          placeholder: copy.emailPlaceholder,
          autoComplete: "email",
        },
        {
          name: "password",
          type: "password",
          label: copy.password,
          placeholder: copy.passwordPlaceholder,
          autoComplete: "new-password",
        },
      ] as const,
    [copy],
  );

  const [form, setForm] = useState<Record<FieldName, string>>({ name: "", email: "", password: "" });
  const [problems, setProblems] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<AuthErrorState | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });

  const busy = phase.kind === "submitting";

  /** Validate everything, or only `only` when given; returns whether the form is clean. */
  const check = useCallback(
    (only?: FieldName): boolean => {
      const parsed = schema.safeParse(form);
      const found = parsed.success ? {} : firstIssuePerField<FieldName>(parsed.error.issues);
      if (only) {
        setProblems((prev) => ({ ...prev, [only]: found[only] }));
        return found[only] === undefined;
      }
      setProblems(found);
      return parsed.success;
    },
    [form, schema],
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!check()) return;

    setPhase({ kind: "submitting" });
    setServerError(null);

    const { error, data } = await authClient.signUp.email({
      name: form.name,
      email: form.email,
      password: form.password,
    });

    if (error) {
      setServerError(toAuthErrorState(t.auth.authErrors, error.code));
      setPhase({ kind: "editing" });
      return;
    }

    if (!data?.token) {
      setPhase({ kind: "awaiting-confirmation", address: form.email });
      return;
    }

    router.push(resolvePostAuthPath(new URLSearchParams(window.location.search), locale));
    setPhase({ kind: "editing" });
  };

  if (phase.kind === "awaiting-confirmation") {
    return (
      <Alert>
        <Inbox className="h-4 w-4" />
        <AlertTitle>{copy.verification.title}</AlertTitle>
        <AlertDescription className="mt-2">
          <p className="mb-2">
            {copy.verification.sent} <strong>{phase.address}</strong>.
          </p>
          <p className="text-sm text-muted-foreground">{copy.verification.checkSpam}</p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <FormError message={serverError?.message} code={serverError?.code} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-6">
          {fields.map((field) => (
            <div key={field.name} className="grid gap-2">
              <Label htmlFor={field.name}>{field.label}</Label>
              <Input
                id={field.name}
                type={field.type}
                value={form[field.name]}
                onChange={(e) => {
                  const next = e.target.value;
                  setForm((prev) => ({ ...prev, [field.name]: next }));
                }}
                onBlur={() => check(field.name)}
                placeholder={field.placeholder}
                autoComplete={field.autoComplete}
                disabled={busy}
                aria-invalid={Boolean(problems[field.name])}
              />
              {problems[field.name] && (
                <span className="text-destructive text-xs">{problems[field.name]}</span>
              )}
            </div>
          ))}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {busy ? copy.submitting : copy.submit}
          </Button>
        </div>

        <p className="text-center text-sm">
          {copy.haveAccount}{" "}
          <Link href={`/${locale}/signin`} className="underline underline-offset-4">
            {copy.signinLink}
          </Link>
        </p>
      </form>
    </div>
  );
}
