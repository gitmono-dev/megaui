// megaui-only: "forgot password" request page.
//
// Asks for an email address and requests a reset link. The reset target is
// locale-aware (`/{locale}/reset-password`) and an `X-Locale` header is sent so
// the server can render the email in the visitor's language.
"use client";

import { useMemo, useState } from "react";

import { Loader2 } from "lucide-react";
import { z } from "zod";

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormError, Input, Label } from "@megaui/ui";

import { LegalNotice } from "@/components/auth-card-parts";
import { useTranslation } from "@/hooks/use-translation";
import { toAuthErrorState, type AuthErrorState } from "@/lib/auth-form-helpers";
import { authClient } from "@/lib/auth-client";

type Stage = { name: "form" } | { name: "sending" } | { name: "sent"; address: string };

export default function ForgotPasswordPage() {
  const { t, locale } = useTranslation();
  const copy = t.auth.forgetPassword;

  const emailSchema = useMemo(
    () => z.string().min(1, copy.errors.requiredEmail).email(copy.errors.invalidEmail),
    [copy],
  );

  const [email, setEmail] = useState("");
  const [emailProblem, setEmailProblem] = useState<string | undefined>();
  const [failure, setFailure] = useState<AuthErrorState | null>(null);
  const [stage, setStage] = useState<Stage>({ name: "form" });

  const checkEmail = (): boolean => {
    const parsed = emailSchema.safeParse(email);
    setEmailProblem(parsed.success ? undefined : parsed.error.issues[0]?.message);
    return parsed.success;
  };

  const requestLink = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!checkEmail()) return;

    setStage({ name: "sending" });
    setFailure(null);

    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: `/${locale}/reset-password`,
      fetchOptions: { headers: { "X-Locale": locale } },
    });

    if (error) {
      setFailure(toAuthErrorState(t.auth.authErrors, error.code));
      setStage({ name: "form" });
      return;
    }
    setStage({ name: "sent", address: email });
  };

  if (stage.name === "sent") {
    return (
      <Card data-testid="forgot-password-card">
        <CardContent className="flex flex-col items-center gap-4 pt-6 text-center">
          <h3 className="font-medium">{copy.verification.title}</h3>
          <p className="text-sm text-muted-foreground">
            {copy.verification.sent} <span className="font-medium">{stage.address}</span>
          </p>
          <p className="text-sm text-muted-foreground">{copy.verification.checkSpam}</p>
        </CardContent>
      </Card>
    );
  }

  const sending = stage.name === "sending";

  return (
    <Card data-testid="forgot-password-card">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <form onSubmit={requestLink} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="email">{copy.email}</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={checkEmail}
              placeholder={copy.emailPlaceholder}
              autoComplete="email"
              disabled={sending}
              aria-invalid={Boolean(emailProblem)}
            />
            {emailProblem && <span className="text-xs text-destructive">{emailProblem}</span>}
          </div>

          <Button type="submit" disabled={sending}>
            {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {sending ? copy.submitting : copy.submit}
          </Button>
        </form>

        {failure && <FormError message={failure.message} code={failure.code} />}

        <LegalNotice
          lead={copy.termsNotice}
          and={t.common.and}
          termsLabel={copy.termsOfService}
          privacyLabel={copy.privacyPolicy}
        />
      </CardContent>
    </Card>
  );
}
