# 企业配对 request

- Spec: `enterprise-pairing-request.spec.ts`
- Card: FS-73
- Tier: owned Next development server + isolated PostgreSQL + real Chromium
- Covers: POST request creation, browser cookie persistence, `__Host-` cookie attributes, and the same-flow 429 response.
- Does not cover OTP delivery, status, login, or real Feishu traffic.
