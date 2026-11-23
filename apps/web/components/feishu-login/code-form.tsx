// megaui-only (FSL-129): the code step of the Feishu sign-in page.
//
// Eight single-character boxes. Typing and pasting drop whitespace, upper-case, and keep
// at most 8 characters (no `maxLength`, so a pasted code with a space is not cut before
// the space is removed). A complete code is posted as `{ code }` to
// `POST /api/auth/feishu-login/verify` immediately; there is no submit button. The flow
// is the HttpOnly flow cookie the request step received, so the browser sends it and this
// component never reads it. A 200 (the server also sets the session cookie) goes to the
// workspace. Every other answer stays on this step with a message chosen by the status
// alone (FSL-130): 400 and 401 say the code is invalid or expired (one text for a wrong,
// expired, voided or used code, as the server answers them alike), 409 the account
// conflict, 503 to request a new code, anything else (500, 403, 429 or no answer) a
// generic retry. The server still trims and upper-cases on its own and remains the only
// judge of the format.
//
// FSL-155: "resend" is the only button. It becomes usable 60 seconds after the step is
// entered (the server's per-email cooldown is as long, so an earlier request would only
// void the code without sending a new one) and posts the same `{ email }` to request
// again; the browser sends the same flow cookie, so the server voids the previous code
// before it answers 202 (FSL-154). A 202 clears the boxes, says a new code was sent and
// restarts the 60 seconds. Any other answer shows the request failure, keeps the boxes
// and also restarts the 60 seconds: a 503 or a lost answer does not prove that nothing
// was reserved, and a retry inside the cooldown would void the code just sent without
// sending another. Reloading this page starts again at an empty email step with the same
// flow cookie (the step state is owned by `EmailForm`, which imports this module).
"use client";

import { useEffect, useRef, useState } from "react";

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

function normalizeCode(value: string): string {
  return value.replace(/\s/g, "").toUpperCase().slice(0, CODE_LENGTH);
}

function emptySlots(): string[] {
  return Array.from({ length: CODE_LENGTH }, () => "");
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
  const [slots, setSlots] = useState<string[]>(emptySlots);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  // This step is rendered only after a 202, so the clock is read in the browser.
  const [resendAt, setResendAt] = useState(() => Date.now() + RESEND_DELAY_MS);
  const [now, setNow] = useState(() => Date.now());
  const busy = loading || resending;
  const slotsRef = useRef(slots);
  const boxesRef = useRef<Array<HTMLInputElement | null>>([]);
  const pendingRef = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= resendAt) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [resendAt]);

  useEffect(() => {
    boxesRef.current[0]?.focus();
  }, []);

  const focusBox = (index: number) => {
    boxesRef.current[Math.max(0, Math.min(index, CODE_LENGTH - 1))]?.focus();
  };

  const writeSlots = (next: string[]) => {
    slotsRef.current = next;
    setSlots(next);
  };

  const submitCode = async (value: string) => {
    if (pendingRef.current || value.length !== CODE_LENGTH) return;
    pendingRef.current = true;
    setLoading(true);
    setError(null);
    setNotice(null);
    const status = await postJson(FEISHU_LOGIN_VERIFY_PATH, { code: value });
    if (status === 200) {
      router.push(`/${locale}/workspace`);
      return;
    }
    pendingRef.current = false;
    setLoading(false);
    setError(verifyErrorText(status, copy));
    focusBox(CODE_LENGTH - 1);
  };

  const applyNormalized = (normalized: string) => {
    const next = Array.from({ length: CODE_LENGTH }, (_, index) => normalized[index] ?? "");
    writeSlots(next);
    focusBox(Math.min(normalized.length, CODE_LENGTH - 1));
    if (normalized.length === CODE_LENGTH) void submitCode(normalized);
  };

  const onBoxChange = (index: number, raw: string) => {
    const cleaned = raw.replace(/\s/g, "").toUpperCase();
    const current = slotsRef.current[index] ?? "";
    // A second character typed onto an unselected box is that key, not a new code.
    const typed = cleaned.length === 2 && current !== "" && cleaned.startsWith(current)
      ? cleaned.slice(-1)
      : cleaned;
    if (typed.length > 1) {
      applyNormalized(normalizeCode(raw));
      return;
    }
    const next = slotsRef.current.slice();
    next[index] = typed;
    writeSlots(next);
    if (typed && index < CODE_LENGTH - 1) focusBox(index + 1);
    if (next.every(character => character !== "")) void submitCode(next.join(""));
  };

  const onBoxKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const value = slotsRef.current.join("");
      if (!slotsRef.current.includes("") && value.length === CODE_LENGTH) void submitCode(value);
      return;
    }
    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      focusBox(index - 1);
      return;
    }
    if (event.key === "ArrowRight" && index < CODE_LENGTH - 1) {
      event.preventDefault();
      focusBox(index + 1);
      return;
    }
    if (event.key !== "Backspace") return;
    event.preventDefault();
    const next = slotsRef.current.slice();
    if (next[index]) {
      next[index] = "";
      writeSlots(next);
      return;
    }
    if (index === 0) return;
    next[index - 1] = "";
    writeSlots(next);
    focusBox(index - 1);
  };

  const onBoxPaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    applyNormalized(normalizeCode(event.clipboardData.getData("text")));
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
    writeSlots(emptySlots());
    setNotice(copy.codeResent);
    focusBox(0);
  };

  const wait = Math.max(0, Math.ceil((resendAt - now) / 1_000));

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const value = slotsRef.current.join("");
        if (value.length === CODE_LENGTH) void submitCode(value);
      }}
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
        <Label id="feishu-login-code-label" htmlFor="feishu-login-code-0">{copy.code}</Label>
        <div
          role="group"
          aria-labelledby="feishu-login-code-label"
          data-testid="feishu-login-code"
          className="flex w-full min-w-0 gap-1"
        >
          {slots.map((character, index) => (
            <Input
              key={index}
              ref={(node) => { boxesRef.current[index] = node; }}
              id={index === 0 ? "feishu-login-code-0" : undefined}
              value={character}
              onChange={(event) => onBoxChange(index, event.target.value)}
              onKeyDown={(event) => onBoxKeyDown(index, event)}
              onPaste={onBoxPaste}
              onFocus={(event) => event.currentTarget.select()}
              inputMode="text"
              autoComplete={index === 0 ? "one-time-code" : "off"}
              autoCapitalize="characters"
              spellCheck={false}
              aria-label={`${copy.code} ${index + 1}`}
              aria-invalid={error !== null || undefined}
              disabled={busy}
              size={1}
              style={{ paddingInline: 0 }}
              className="h-11 w-0 min-w-0 flex-1 basis-0 px-0 text-center text-sm font-medium sm:text-base"
            />
          ))}
        </div>
      </div>
      {loading && (
        <p role="status" className="flex items-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {copy.verifying}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        data-testid="feishu-login-resend"
        onClick={() => void resend()}
        disabled={busy || wait > 0}
      >
        {resending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {resending ? copy.requesting : wait > 0 ? copy.resendWait.replace("{seconds}", String(wait)) : copy.resend}
      </Button>
    </form>
  );
}
