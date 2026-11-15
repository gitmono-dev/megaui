import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAuthMailRuntime } from "@/lib/email-runtime";

afterEach(() => {
  vi.unstubAllEnvs();
});

function expectCategory(
  source: NodeJS.Dict<string>,
  category: "smtp_host" | "smtp_port" | "smtp_auth" | "resend_api_key" | "provider_selector" | "default_from",
  secrets: string[] = [],
) {
  expect(() => resolveAuthMailRuntime(source)).toThrowError(
    `[@megaui/web] auth-mail config invalid: ${category}`,
  );
  try {
    resolveAuthMailRuntime(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    expect(message).toBe(`[@megaui/web] auth-mail config invalid: ${category}`);
    for (const secret of secrets) {
      expect(message).not.toContain(secret);
    }
  }
}

describe("resolveAuthMailRuntime selected smtp", () => {
  it("throws smtp_host when host is missing or empty (new)", () => {
    expectCategory(
      {
        EMAIL_PROVIDER: "smtp",
        EMAIL_DEFAULT_FROM: "alerts@example.com",
        SMTP_PORT: "587",
        SMTP_PASS: "hunter2-secret",
      },
      "smtp_host",
      ["hunter2-secret"],
    );
    expectCategory(
      {
        EMAIL_PROVIDER: "smtp",
        EMAIL_DEFAULT_FROM: "alerts@example.com",
        SMTP_HOST: "   ",
        SMTP_PORT: "587",
      },
      "smtp_host",
    );
  });

  it("throws smtp_port when port is not a decimal integer in 1..65535 (new)", () => {
    const base = {
      EMAIL_PROVIDER: "smtp",
      EMAIL_DEFAULT_FROM: "alerts@example.com",
      SMTP_HOST: "smtp.leaky.example",
    };
    expectCategory({ ...base, SMTP_PORT: undefined }, "smtp_port", ["smtp.leaky.example"]);
    expectCategory({ ...base, SMTP_PORT: "" }, "smtp_port", ["smtp.leaky.example"]);
    expectCategory({ ...base, SMTP_PORT: "25.0" }, "smtp_port", ["smtp.leaky.example"]);
    expectCategory({ ...base, SMTP_PORT: "0" }, "smtp_port", ["smtp.leaky.example"]);
    expectCategory({ ...base, SMTP_PORT: "65536" }, "smtp_port", ["smtp.leaky.example"]);
    expectCategory({ ...base, SMTP_PORT: "+587" }, "smtp_port", ["smtp.leaky.example"]);
  });

  it("throws smtp_auth when only one of user/pass is non-empty, and omits auth when both are empty (new)", () => {
    expectCategory(
      {
        EMAIL_PROVIDER: "smtp",
        EMAIL_DEFAULT_FROM: "alerts@example.com",
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "587",
        SMTP_USER: "mailer",
        SMTP_PASS: "",
      },
      "smtp_auth",
      ["mailer"],
    );
    expectCategory(
      {
        EMAIL_PROVIDER: "smtp",
        EMAIL_DEFAULT_FROM: "alerts@example.com",
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "587",
        SMTP_USER: "",
        SMTP_PASS: "hunter2-secret",
      },
      "smtp_auth",
      ["hunter2-secret"],
    );

    const anonymous = resolveAuthMailRuntime({
      EMAIL_PROVIDER: "smtp",
      EMAIL_DEFAULT_FROM: "alerts@example.com",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
    });
    expect(anonymous).toEqual({
      defaultFrom: "alerts@example.com",
      provider: { kind: "smtp", config: { host: "smtp.example.com", port: 587 } },
    });

    const authenticated = resolveAuthMailRuntime({
      EMAIL_PROVIDER: "smtp",
      EMAIL_DEFAULT_FROM: "alerts@example.com",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_USER: "mailer",
      SMTP_PASS: "hunter2-secret",
    });
    expect(authenticated).toEqual({
      defaultFrom: "alerts@example.com",
      provider: {
        kind: "smtp",
        config: {
          host: "smtp.example.com",
          port: 587,
          auth: { user: "mailer", pass: "hunter2-secret" },
        },
      },
    });
  });
});

describe("resolveAuthMailRuntime selected resend", () => {
  it("throws resend_api_key when the key is missing or empty (new)", () => {
    expectCategory(
      {
        EMAIL_PROVIDER: "resend",
        EMAIL_DEFAULT_FROM: "alerts@example.com",
        SMTP_PASS: "hunter2-secret",
      },
      "resend_api_key",
      ["hunter2-secret"],
    );
    expectCategory(
      {
        EMAIL_PROVIDER: "resend",
        EMAIL_DEFAULT_FROM: "alerts@example.com",
        RESEND_API_KEY: "   ",
      },
      "resend_api_key",
    );
  });
});

describe("resolveAuthMailRuntime unselected provider vars", () => {
  it("does not require unselected provider variables (new)", () => {
    expect(
      resolveAuthMailRuntime({
        EMAIL_PROVIDER: "test",
        EMAIL_DEFAULT_FROM: "alerts@example.com",
      }),
    ).toEqual({
      defaultFrom: "alerts@example.com",
      provider: { kind: "test" },
    });

    expect(
      resolveAuthMailRuntime({
        EMAIL_PROVIDER: "smtp",
        EMAIL_DEFAULT_FROM: "alerts@example.com",
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "1025",
      }),
    ).toEqual({
      defaultFrom: "alerts@example.com",
      provider: { kind: "smtp", config: { host: "smtp.example.com", port: 1025 } },
    });

    expect(
      resolveAuthMailRuntime({
        EMAIL_PROVIDER: "resend",
        EMAIL_DEFAULT_FROM: "alerts@example.com",
        RESEND_API_KEY: "re_test_key",
      }),
    ).toEqual({
      defaultFrom: "alerts@example.com",
      provider: { kind: "resend", config: { apiKey: "re_test_key" } },
    });
  });
});

describe("resolveAuthMailRuntime error contract", () => {
  it("uses the exact category message and does not interpolate host, key, password, or raw env (new)", () => {
    const secrets = ["smtp.leaky.example", "re_live_secret", "hunter2-secret", "raw-env-dump"];
    expectCategory(
      {
        EMAIL_PROVIDER: "smtp",
        EMAIL_DEFAULT_FROM: "alerts@example.com",
        SMTP_HOST: "smtp.leaky.example",
        SMTP_PORT: "not-a-port",
        SMTP_PASS: "hunter2-secret",
        RESEND_API_KEY: "re_live_secret",
        EXTRA: "raw-env-dump",
      },
      "smtp_port",
      secrets,
    );
  });

  it("reads process.env when source is omitted (new)", () => {
    vi.stubEnv("EMAIL_PROVIDER", "test");
    vi.stubEnv("EMAIL_DEFAULT_FROM", "alerts@example.com");
    expect(resolveAuthMailRuntime()).toEqual({
      defaultFrom: "alerts@example.com",
      provider: { kind: "test" },
    });
  });
});
