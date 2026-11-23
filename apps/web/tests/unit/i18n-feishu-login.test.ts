// megaui-only (FSL-129 AC2): every text of the Feishu sign-in page has a key in both the
// `zh-CN` and the `en` dictionaries (`auth.signin.feishu`, GC-14). FSL-130 adds the code
// step's per-status verify messages, FSL-155 its resend texts.
//
// The keys the page and its two step components read are collected from their source
// (`copy.<key>`, where `copy` is `auth.signin.feishu`), so a new text cannot be added
// to a component without both dictionaries carrying it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getTranslation } from "@megaui/i18n";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCES = [
  "app/[lang]/(auth)/signin/feishu/page.tsx",
  "components/feishu-login/email-form.tsx",
  "components/feishu-login/code-form.tsx",
];
const LOCALES = ["zh-CN", "en"] as const;

function usedKeys(): string[] {
  const keys = new Set<string>();
  for (const file of SOURCES) {
    const source = readFileSync(path.join(WEB_ROOT, file), "utf8");
    // Each component binds `copy` to the Feishu sign-in namespace and nothing else.
    expect(source, file).toMatch(/const copy = (?:getTranslation\(lang\)|t)\.auth\.signin\.feishu;/);
    for (const match of source.matchAll(/\bcopy\.([A-Za-z]+)\b/g)) keys.add(match[1]!);
  }
  return [...keys].sort();
}

describe("FSL-129 Feishu sign-in page texts", () => {
  const used = usedKeys();

  it("the page reads its texts from the dictionary", () => {
    expect(used).toEqual(expect.arrayContaining([
      "title", "description", "email", "emailPlaceholder", "request", "requesting", "invalidEmail",
      "requestFailed", "codeSent", "code", "verifying", "verifyFailed",
      "codeInvalid", "accountConflict", "codeRetry",
    ]));
  });

  it("FSL-155: the code step reads its resend and change-email texts from the dictionary", () => {
    expect(used).toEqual(expect.arrayContaining(["resend", "resendWait", "codeResent"]));
    for (const locale of LOCALES) {
      const copy = getTranslation(locale).auth.signin.feishu;
      // The countdown keeps exactly one seconds placeholder, and the two resend labels differ.
      expect(copy.resendWait.split("{seconds}"), locale).toHaveLength(2);
      expect(copy.resend, locale).not.toBe(copy.resendWait);
      expect(copy.resend.includes("{seconds}"), locale).toBe(false);
    }
  });

  it("FSL-130: the code step's verify messages are four different texts in each locale", () => {
    for (const locale of LOCALES) {
      const copy = getTranslation(locale).auth.signin.feishu;
      const texts = [copy.codeInvalid, copy.accountConflict, copy.codeRetry, copy.verifyFailed];
      expect(new Set(texts).size, locale).toBe(texts.length);
    }
  });

  it("AC2: every key the page uses is a non-empty string in zh-CN and en", () => {
    for (const locale of LOCALES) {
      const copy = getTranslation(locale).auth.signin.feishu as Record<string, unknown>;
      for (const key of used) {
        expect(typeof copy[key], `${locale} auth.signin.feishu.${key}`).toBe("string");
        expect((copy[key] as string).trim(), `${locale} auth.signin.feishu.${key}`).not.toBe("");
      }
    }
  });

  it("AC2: zh-CN and en carry the same keys under auth.signin.feishu, all of them used", () => {
    const zh = Object.keys(getTranslation("zh-CN").auth.signin.feishu).sort();
    const en = Object.keys(getTranslation("en").auth.signin.feishu).sort();
    expect(zh).toEqual(en);
    expect(en).toEqual(used);
  });

  it("AC2: the texts are translated, and the code hint keeps the email placeholder in both", () => {
    const zh = getTranslation("zh-CN").auth.signin.feishu as Record<string, string>;
    const en = getTranslation("en").auth.signin.feishu as Record<string, string>;
    for (const key of used.filter(key => key !== "emailPlaceholder")) {
      expect(zh[key], key).not.toBe(en[key]);
      expect(zh[key], key).toMatch(/[一-鿿]/u);
    }
    for (const copy of [zh, en]) expect(String(copy.codeSent).split("{email}")).toHaveLength(2);
  });
});
