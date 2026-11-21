// megaui-only (FSL-129): the email step of the Feishu sign-in page and the owner of its
// two-step state.
//
// The email step posts `{ email }` to `POST /api/auth/feishu-login/request`. A 202 (the
// server also sets the flow cookie) switches to the code step; a 400 shows the format
// error and stays here. Email syntax is decided by the server only (one rule,
// `normalizeFeishuLoginEmail`), so the form disables native validation. The request
// answers alike for known and unknown emails, and so does this page: the code step is
// the same for both. The email is kept only in this component's state (never in
// browser storage), so a reload starts again at the email step.
"use client";

import { useState, useSyncExternalStore } from "react";

import { Loader2 } from "lucide-react";

import { Button, FormError, Input, Label } from "@megaui/ui";

import { useTranslation } from "@/hooks/use-translation";

import { CodeForm, postJson } from "./code-form";

const FEISHU_LOGIN_REQUEST_PATH = "/api/auth/feishu-login/request";
const noSubscription = () => () => {};

/**
 * False in the server render and during hydration, true once React handles events. Until
 * then the input and the submit button stay disabled, so typing cannot be lost to
 * hydration and a click can never fall through to a native form submission (a full
 * navigation that would lose the step).
 */
function useHydrated(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false);
}

export function EmailForm() {
  const { t } = useTranslation();
  const copy = t.auth.signin.feishu;
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const hydrated = useHydrated();

  const request = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = email.trim();
    setLoading(true);
    setError(null);
    const status = await postJson(FEISHU_LOGIN_REQUEST_PATH, { email: value });
    setLoading(false);
    if (status === 202) {
      setSentTo(value);
      return;
    }
    setError(status === 400 ? copy.invalidEmail : copy.requestFailed);
  };

  if (sentTo !== null) return <CodeForm email={sentTo} />;

  return (
    <form
      noValidate
      onSubmit={(event) => void request(event)}
      className="flex flex-col gap-4"
      data-testid="feishu-login-email-step"
    >
      <FormError message={error ?? undefined} />
      <div className="grid gap-2">
        <Label htmlFor="feishu-login-email">{copy.email}</Label>
        <Input
          id="feishu-login-email"
          data-testid="feishu-login-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={copy.emailPlaceholder}
          autoComplete="email"
          disabled={loading || !hydrated}
        />
      </div>
      <Button type="submit" data-testid="feishu-login-request" disabled={loading || !hydrated}>
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {loading ? copy.requesting : copy.request}
      </Button>
    </form>
  );
}
