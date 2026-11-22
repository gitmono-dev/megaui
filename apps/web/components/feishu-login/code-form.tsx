// megaui-only (FSL-129): the code step of the Feishu sign-in page.
//
// Posts `{ code }` to `POST /api/auth/feishu-login/verify`; the flow is the HttpOnly flow
// cookie the request step received, so the browser sends it and this component never
// reads it. A 200 (the server also sets the session cookie) goes to the home page. Every
// other answer stays on this step with a message chosen by the status alone (FSL-130):
// 400 and 401 say the code is invalid or expired (one text for a wrong, expired, voided or
// used code, as the server answers them alike), 409 the account conflict, 503 to request a
// new code, anything else (500, 403, 429 or no answer) a generic retry. For typing and
// pasting, the field drops all whitespace, upper-cases and keeps at most 8 characters (no
// `maxLength`, so a pasted code with a space is not cut before the space is removed); the
// server still trims and upper-cases on its own and remains the only judge of the format.
//
// FSL-155: "resend" becomes usable 60 seconds after the step is entered (the server's
// per-email cooldown is as long, so an earlier request would only void the code without
// sending a new one) and posts the same `{ email }` to request again; the browser sends the
// same flow cookie, so the server voids the previous code before it answers 202 (FSL-154).
// A 202 clears the field, says a new code was sent and restarts the 60 seconds. Any other
// answer shows the request failure, keeps the field and also restarts the 60 seconds: a 503
// or a lost answer does not prove that nothing was reserved, and a retry inside the cooldown
// would void the code just sent without sending another. "Change email" loads this
// page again, which, like a reload, starts at an empty email step with the same flow cookie
// (the step state is owned by `EmailForm`, which imports this module). The email the
// next request names voids this step's code in the same flow, member or not.
"use client";

import { useEffect, useState } from "react";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button, FormError, Input, Label } from "@megaui/ui";

import { useTranslation } from "@/hooks/use-translation";

const FEISHU_LOGIN_REQUEST_PATH = "/api/auth/feishu-login/request";
const FEISHU_LOGIN_VERIFY_PATH = "/api/auth/feishu-login/verify";
const CODE_LENGTH = 8;
/** As long as the server's per-email cooldown (`FEISHU_LOGIN_COOLDOWN_SECONDS`). */
const RESEND_DELAY_MS = 60_000;

type FeishuLoginCopy = ReturnType<typeof useTranslation>["t"]["auth"]["signin"]["feishu"];

/** The code step's message for a verify answer other than 200, by status only. */
function verifyErrorText(status: number, copy: FeishuLoginCopy): string {
  switch (status) {
    case 400:
    case 401:
      return copy.codeInvalid;
    case 409:
      return copy.accountConflict;
    case 503:
      return copy.codeRetry;
    default:
      return copy.verifyFailed;
  }
}

/**
 * POSTs a JSON body same-origin and answers the status, or 0 when nothing came back. Both
 * steps use it; the status alone decides the step.
 */
export async function postJson(path: string, body: unknown): Promise<number> {
  try {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // Drain the small JSON body (its content is not used) so the request completes normally.
    await response.arrayBuffer().catch(() => undefined);
    return response.status;
  } catch {
    return 0;
  }
}

export function CodeForm({ email }: { email: string }) {
  const router = useRouter();
  const { t, locale } = useTranslation();
  const copy = t.auth.signin.feishu;
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  // This step is rendered only after a 202, so the clock is read in the browser.
  const [resendAt, setResendAt] = useState(() => Date.now() + RESEND_DELAY_MS);
  const [now, setNow] = useState(() => Date.now());
  const busy = loading || resending;

  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= resendAt) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [resendAt]);

  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);
    const status = await postJson(FEISHU_LOGIN_VERIFY_PATH, { code });
    if (status === 200) {
      router.push(`/${locale}`);
      return;
    }
    setLoading(false);
    setError(verifyErrorText(status, copy));
  };

  const resend = async () => {
    setResending(true);
    setError(null);
    setNotice(null);
    const status = await postJson(FEISHU_LOGIN_REQUEST_PATH, { email });
    const answeredAt = Date.now();
    setResending(false);
    // Whatever the answer, the email may now be in the server's cooldown.
    setResendAt(answeredAt + RESEND_DELAY_MS);
    setNow(answeredAt);
    if (status !== 202) {
      setError(copy.requestFailed);
      return;
    }
    setCode("");
    setNotice(copy.codeResent);
  };

  const changeEmail = () => {
    window.location.assign(window.location.pathname + window.location.search);
  };

  const wait = Math.max(0, Math.ceil((resendAt - now) / 1_000));

  return (
    <form
      noValidate
      onSubmit={(event) => void verify(event)}
      className="flex flex-col gap-4"
      data-testid="feishu-login-code-step"
    >
      <p className="text-sm text-muted-foreground" data-testid="feishu-login-code-sent">
        {copy.codeSent.replace("{email}", email)}
      </p>
      {notice !== null && (
        <p role="status" className="text-sm" data-testid="feishu-login-code-resent">
          {notice}
        </p>
      )}
      <FormError message={error ?? undefined} />
      <div className="grid gap-2">
        <Label htmlFor="feishu-login-code">{copy.code}</Label>
        <Input
          id="feishu-login-code"
          data-testid="feishu-login-code"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\s/g, "").toUpperCase().slice(0, CODE_LENGTH))}
          placeholder={copy.codePlaceholder}
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={busy}
        />
      </div>
      <Button type="submit" data-testid="feishu-login-verify" disabled={busy}>
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {loading ? copy.verifying : copy.verify}
      </Button>
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          data-testid="feishu-login-change-email"
          onClick={changeEmail}
          disabled={busy}
        >
          {copy.changeEmail}
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="feishu-login-resend"
          onClick={() => void resend()}
          disabled={busy || wait > 0}
        >
          {resending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {resending ? copy.requesting : wait > 0 ? copy.resendWait.replace("{seconds}", String(wait)) : copy.resend}
        </Button>
      </div>
    </form>
  );
}
