import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MegaBadRequestError,
  MegaConflictError,
  MegaForbiddenError,
  MegaInternalError,
  MegaNotFoundError,
  MegaUnauthorizedError,
} from "../../errors";
import {
  MAX_MEGA2_CL_PER_PAGE,
  addMega2ClComment,
  checkMega2ClCiAuthz,
  closeMega2Cl,
  fetchMega2ClDetail,
  fetchMega2ClFilesChanged,
  fetchMega2ClFilesList,
  fetchMega2ClList,
  fetchMega2ClMergeBox,
  mergeMega2Cl,
  reopenMega2Cl,
  updateMega2ClBranch,
} from "@megaui/engine/services/mega2";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe("@megaui/engine/services/mega2 cl-backend contract (CLB-21)", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastRequest: CapturedRequest | undefined;
  let nextHandler:
    | ((req: CapturedRequest, res: http.ServerResponse) => void)
    | undefined;

  function env(): NodeJS.ProcessEnv {
    return { MEGA2_PUBLIC_BASE_URL: baseUrl };
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const captured: CapturedRequest = {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        lastRequest = captured;
        if (nextHandler) {
          const handler = nextHandler;
          nextHandler = undefined;
          handler(captured, res);
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function respondCommon(
    res: http.ServerResponse,
    data: unknown,
    reqResult = true,
    errMessage = "",
  ) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        req_result: reqResult,
        data,
        err_message: errMessage,
      }),
    );
  }

  it("forwards only cookie header and caps list per_page to 50", async () => {
    nextHandler = (_req, res) => {
      respondCommon(res, {
        total: 1,
        items: [
          {
            id: 10,
            link: "cl-alpha",
            title: "Alpha CL",
            status: "Open",
            author: "alice",
            open_timestamp: 1_700_000_000,
            closed_at: null,
            merge_timestamp: null,
            updated_at: 1_700_000_100,
            comment_num: 2,
            path: "/project/app",
            from_hash: SHA_A,
            to_hash: SHA_B,
            head_revision: 3,
            base_branch: "main",
          },
        ],
      });
    };

    const page = await fetchMega2ClList(
      { status: "open", page: 1, perPage: 999 },
      {
        headers: {
          Cookie: "session=abc",
          Authorization: "Bearer must-not-forward",
          "X-Secret": "must-not-forward",
        },
      },
      env(),
    );

    expect(page.total).toBe(1);
    expect(page.items[0]?.head_revision).toBe(3);
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.url).toBe("/api/v1/cl/list");
    expect(lastRequest?.headers.cookie).toBe("session=abc");
    expect(lastRequest?.headers.authorization).toBeUndefined();
    expect(lastRequest?.headers["x-secret"]).toBeUndefined();
    const sent = JSON.parse(lastRequest?.body ?? "{}") as {
      pagination: { per_page: number };
    };
    expect(sent.pagination.per_page).toBe(MAX_MEGA2_CL_PER_PAGE);
  });

  it("fetches CL detail, files-list, files-changed, and merge-box with PENDING + CI fields", async () => {
    nextHandler = (_req, res) => {
      respondCommon(res, {
        id: 10,
        link: "cl-alpha",
        title: "Alpha CL",
        status: "Open",
        open_timestamp: 1_700_000_000,
        merge_timestamp: null,
        conversations: [
          {
            id: 1,
            username: "alice",
            conv_type: "Comment",
            comment: "LGTM",
            resolved: null,
            created_at: 1_700_000_050,
            updated_at: 1_700_000_050,
          },
        ],
        path: "/project/app",
        from_hash: SHA_A,
        to_hash: SHA_B,
        head_revision: 4,
        base_branch: "main",
        author: "alice",
      });
    };
    const detail = await fetchMega2ClDetail("cl-alpha", {}, env());
    expect(detail.head_revision).toBe(4);
    expect(detail.conversations).toHaveLength(1);
    expect(lastRequest?.method).toBe("GET");
    expect(lastRequest?.url).toBe("/api/v1/cl/cl-alpha/detail");

    nextHandler = (_req, res) => {
      respondCommon(res, [
        { path: "src/main.rs", sha: SHA_B, action: "modified" },
      ]);
    };
    const files = await fetchMega2ClFilesList("cl-alpha", {}, env());
    expect(files[0]?.path).toBe("src/main.rs");
    expect(lastRequest?.method).toBe("GET");
    expect(lastRequest?.url).toBe("/api/v1/cl/cl-alpha/files-list");

    nextHandler = (_req, res) => {
      respondCommon(res, {
        page: {
          total: 1,
          items: [{ path: "src/main.rs", data: "@@ -1 +1 @@\n-old\n+new" }],
        },
      });
    };
    const diffPage = await fetchMega2ClFilesChanged(
      "cl-alpha",
      { page: 1, perPage: 250, selector: "src/" },
      {},
      env(),
    );
    expect(diffPage.page.items[0]?.data).toContain("+new");
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.url).toBe("/api/v1/cl/cl-alpha/files-changed");
    expect(JSON.parse(lastRequest?.body ?? "{}")).toEqual({
      pagination: { page: 1, per_page: MAX_MEGA2_CL_PER_PAGE },
      additional: "src/",
    });

    nextHandler = (_req, res) => {
      respondCommon(res, {
        merge_requirements: {
          state: "UNMERGEABLE",
          conditions: [
            {
              type: "CiStatus",
              display_name: "CI Build",
              description: "Orion2 Buck2 build",
              message: "Build running",
              result: "PENDING",
              commit_id: SHA_B,
              head_revision: 4,
              ci_task_id: "task-01",
              ci_attempt_id: "att-01",
              ci_generation: 2,
              details_url: "https://mega.example/cls/1/checks",
              raw_status: "RUNNING",
            },
          ],
        },
      });
    };
    const mergeBox = await fetchMega2ClMergeBox("cl-alpha", {}, env());
    expect(mergeBox.merge_requirements?.state).toBe("UNMERGEABLE");
    expect(mergeBox.merge_requirements?.conditions[0]?.type).toBe("CiStatus");
    expect(mergeBox.merge_requirements?.conditions[0]?.result).toBe("PENDING");
    expect(mergeBox.merge_requirements?.conditions[0]?.ci_task_id).toBe("task-01");
    expect(lastRequest?.method).toBe("GET");
    expect(lastRequest?.url).toBe("/api/v1/cl/cl-alpha/merge-box");
  });

  it("executes merge, close, reopen, update-branch, and comment mutations", async () => {
    for (const [fn, expectedPath] of [
      [mergeMega2Cl, "/api/v1/cl/cl-alpha/merge"],
      [closeMega2Cl, "/api/v1/cl/cl-alpha/close"],
      [reopenMega2Cl, "/api/v1/cl/cl-alpha/reopen"],
      [updateMega2ClBranch, "/api/v1/cl/cl-alpha/update-branch"],
    ] as const) {
      nextHandler = (_req, res) => respondCommon(res, "ok");
      const out = await fn("cl-alpha", {}, env());
      expect(out).toBe("ok");
      expect(lastRequest?.method).toBe("POST");
      expect(lastRequest?.url).toBe(expectedPath);
    }

    nextHandler = (_req, res) => respondCommon(res, null);
    await addMega2ClComment("cl-alpha", "Ship it", {}, env());
    expect(lastRequest?.url).toBe("/api/v1/cl/cl-alpha/comment");
    expect(JSON.parse(lastRequest?.body ?? "{}")).toEqual({ content: "Ship it" });
  });

  it("maps HTTP 401/403/404/409/500 and schema mismatches to Mega*Error fail-closed", async () => {
    const cases = [
      [401, MegaUnauthorizedError],
      [403, MegaForbiddenError],
      [404, MegaNotFoundError],
      [409, MegaConflictError],
      [500, MegaInternalError],
    ] as const;

    for (const [status, ErrCtor] of cases) {
      nextHandler = (_req, res) => {
        res.statusCode = status;
        res.end("upstream error");
      };
      await expect(fetchMega2ClDetail("cl-alpha", {}, env())).rejects.toBeInstanceOf(
        ErrCtor,
      );
    }

    nextHandler = (_req, res) => respondCommon(res, { broken: true });
    await expect(fetchMega2ClDetail("cl-alpha", {}, env())).rejects.toBeInstanceOf(
      MegaInternalError,
    );

    // Unknown extra field on CLDetailRes must fail strict schema drift detection
    nextHandler = (_req, res) =>
      respondCommon(res, {
        id: 10,
        link: "cl-alpha",
        title: "Alpha CL",
        status: "Open",
        open_timestamp: 1_700_000_000,
        merge_timestamp: null,
        conversations: [],
        path: "/project/app",
        from_hash: SHA_A,
        to_hash: SHA_B,
        head_revision: 1,
        base_branch: "main",
        author: "alice",
        unexpected_extra_field: true,
      });
    await expect(fetchMega2ClDetail("cl-alpha", {}, env())).rejects.toBeInstanceOf(
      MegaInternalError,
    );

    // Unknown CheckType enum on MergeBoxRes must fail strict schema drift detection
    nextHandler = (_req, res) =>
      respondCommon(res, {
        merge_requirements: {
          state: "UNMERGEABLE",
          conditions: [
            {
              type: "UnknownCheckType",
              display_name: "Unknown",
              description: "Unknown",
              message: "Unknown",
              result: "FAILED",
            },
          ],
        },
      });
    await expect(fetchMega2ClMergeBox("cl-alpha", {}, env())).rejects.toBeInstanceOf(
      MegaInternalError,
    );

    await expect(fetchMega2ClDetail("../escape", {}, env())).rejects.toBeInstanceOf(
      MegaBadRequestError,
    );
  });

  it("classifies checkMega2ClCiAuthz across 200, 401, 403 policy/denied, 404, 503, and malformed 200", async () => {
    // 200 allowed
    nextHandler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          allowed: true,
          action: "write",
          cl_link: "cl-alpha",
          principal: "alice",
        }),
      );
    };
    const ok = await checkMega2ClCiAuthz(
      "cl-alpha",
      "write",
      { headers: { Cookie: "sid=1", Authorization: "Bearer drop" } },
      env(),
    );
    expect(ok).toEqual({
      kind: "allowed",
      status: 200,
      action: "write",
      clLink: "cl-alpha",
      principal: "alice",
    });
    expect(lastRequest?.url).toBe("/api/v1/cl/cl-alpha/ci-authz?action=write");
    expect(lastRequest?.headers.cookie).toBe("sid=1");
    expect(lastRequest?.headers.authorization).toBeUndefined();

    // 401
    nextHandler = (_req, res) => {
      res.statusCode = 401;
      res.end("unauthorized");
    };
    expect(await checkMega2ClCiAuthz("cl-alpha", "read", {}, env())).toMatchObject({
      kind: "unauthenticated",
      status: 401,
    });

    // 403 ci_authz_policy_not_enforced
    nextHandler = (_req, res) => {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          code: "ci_authz_policy_not_enforced",
          message: "cedar must be enforce",
        }),
      );
    };
    expect(await checkMega2ClCiAuthz("cl-alpha", "read", {}, env())).toEqual({
      kind: "denied",
      status: 403,
      code: "ci_authz_policy_not_enforced",
      message: "cedar must be enforce",
    });

    // 403 ci_authz_denied
    nextHandler = (_req, res) => {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          code: "ci_authz_denied",
          message: "forbidden",
        }),
      );
    };
    expect(await checkMega2ClCiAuthz("cl-alpha", "write", {}, env())).toEqual({
      kind: "denied",
      status: 403,
      code: "ci_authz_denied",
      message: "forbidden",
    });

    // 404 cl_not_found
    nextHandler = (_req, res) => {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: "cl_not_found", message: "not found" }));
    };
    expect(await checkMega2ClCiAuthz("cl-alpha", "read", {}, env())).toMatchObject({
      kind: "not_found",
      status: 404,
      code: "cl_not_found",
    });

    // 503 ci_authz_unavailable
    nextHandler = (_req, res) => {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          code: "ci_authz_unavailable",
          message: "snapshot missing",
        }),
      );
    };
    expect(await checkMega2ClCiAuthz("cl-alpha", "read", {}, env())).toEqual({
      kind: "unavailable",
      status: 503,
      code: "ci_authz_unavailable",
      message: "snapshot missing",
    });

    // 200 with mismatched cl_link fails closed as unavailable
    nextHandler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          allowed: true,
          action: "read",
          cl_link: "other-cl",
          principal: "alice",
        }),
      );
    };
    expect(await checkMega2ClCiAuthz("cl-alpha", "read", {}, env())).toMatchObject({
      kind: "unavailable",
      status: 503,
      code: "ci_authz_unavailable",
    });

    // 200 with unexpected extra field fails closed as unavailable
    nextHandler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          allowed: true,
          action: "read",
          cl_link: "cl-alpha",
          principal: "alice",
          extra: "forbidden",
        }),
      );
    };
    expect(await checkMega2ClCiAuthz("cl-alpha", "read", {}, env())).toMatchObject({
      kind: "unavailable",
      status: 503,
      code: "ci_authz_unavailable",
    });

    // 403 with unexpected error code fails closed as unavailable (not normal denial)
    nextHandler = (_req, res) => {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          code: "unexpected_proxy_code",
          message: "edge rejected",
        }),
      );
    };
    expect(await checkMega2ClCiAuthz("cl-alpha", "read", {}, env())).toMatchObject({
      kind: "unavailable",
      status: 503,
      code: "ci_authz_unavailable",
    });

    // 500 with unrelated code fails closed with canonical ci_authz_unavailable code
    nextHandler = (_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          code: "internal_error",
          message: "db failure",
        }),
      );
    };
    expect(await checkMega2ClCiAuthz("cl-alpha", "read", {}, env())).toMatchObject({
      kind: "unavailable",
      status: 503,
      code: "ci_authz_unavailable",
    });
  });
});
