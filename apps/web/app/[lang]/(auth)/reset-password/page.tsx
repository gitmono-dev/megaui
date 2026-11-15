// megaui-only: "choose a new password" page, opened from the emailed link.
//
// The one-time token is read from the `?token=` query parameter after mount;
// without it the form stays disabled and an invalid-link error is shown. The
// two password fields are checked together so a mismatch is reported on the
// confirmation field.
"use client";

import { useEffect, useMemo, useState } from "react";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { z } from "zod";

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormError, Input, Label } from "@megaui/ui";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { firstIssuePerField, toAuthErrorState, type AuthErrorState } from "@/lib/auth-form-helpers";

type FieldName = "password" | "confirmPassword";

const MIN_PASSWORD_LENGTH = 8;

export default function ResetPasswordPage() {
  const { t, locale } = useTranslation();
  const copy = t.auth.resetPassword;

  const schema = useMemo(
    () =>
      z
        .object({
          password: z
            .string()
            .min(1, copy.errors.requiredPassword)
            .min(MIN_PASSWORD_LENGTH, copy.errors.invalidPassword),
          confirmPassword: z.string().min(1, copy.errors.requiredPassword),
        })
        .refine((v) => v.password === v.confirmPassword, {
          message: copy.errors.passwordsDontMatch,
          path: ["confirmPassword"],
        }),
    [copy],
  );

  const inputs = useMemo(
    () =>
      [
        { name: "password", label: copy.password, placeholder: copy.passwordPlaceholder },
        { name: "confirmPassword", label: copy.confirmPassword, placeholder: copy.confirmPasswordPlaceholder },
      ] as const,
    [copy],
  );

  const [form, setForm] = useState<Record<FieldName, string>>({ password: "", confirmPassword: "" });
  const [problems, setProblems] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<AuthErrorState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const invalidLinkMessage = copy.errors.invalidToken;
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("token");
    if (fromUrl) {
      setToken(fromUrl);
    } else {
      setFailure({ code: "INVALID_TOKEN", message: invalidLinkMessage });
    }
  }, [invalidLinkMessage]);

  const validate = (only?: FieldName): boolean => {
    const parsed = schema.safeParse(form);
    const found = parsed.success ? {} : firstIssuePerField<FieldName>(parsed.error.issues);
    if (only) {
      setProblems((prev) => ({ ...prev, [only]: found[only] }));
      return found[only] === undefined;
    }
    setProblems(found);
    return parsed.success;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!token || !validate()) return;

    setSubmitting(true);
    setFailure(null);

    const { error } = await authClient.resetPassword({ newPassword: form.password, token });

    if (error) {
      setFailure(toAuthErrorState(t.auth.authErrors, error.code));
    } else {
      setDone(true);
    }
    setSubmitting(false);
  };

  if (done) {
    return (
      <Card data-testid="reset-password-card">
        <CardContent className="flex flex-col items-center gap-4 pt-6 text-center">
          <h3 className="font-medium">{copy.success.title}</h3>
          <p className="text-sm text-muted-foreground">{copy.success.description}</p>
          <Button asChild>
            <Link href={`/${locale}/signin`}>{copy.success.backToSignin}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const locked = submitting || !token;

  return (
    <Card data-testid="reset-password-card">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <form onSubmit={submit} className="grid gap-4">
          {inputs.map((input) => (
            <div key={input.name} className="grid gap-2">
              <Label htmlFor={input.name}>{input.label}</Label>
              <Input
                id={input.name}
                type="password"
                value={form[input.name]}
                onChange={(e) => {
                  const next = e.target.value;
                  setForm((prev) => ({ ...prev, [input.name]: next }));
                }}
                onBlur={() => validate(input.name)}
                placeholder={input.placeholder}
                autoComplete="new-password"
                disabled={locked}
                aria-invalid={Boolean(problems[input.name])}
              />
              {problems[input.name] && <span className="text-xs text-destructive">{problems[input.name]}</span>}
            </div>
          ))}

          <Button type="submit" disabled={locked}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting ? copy.submitting : copy.submit}
          </Button>
        </form>

        {failure && <FormError message={failure.message} code={failure.code} />}
      </CardContent>
    </Card>
  );
}
