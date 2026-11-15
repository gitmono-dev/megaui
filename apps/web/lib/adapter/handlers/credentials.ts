// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (user credentials segments)

import { z } from "zod";

import {
  addSshKey,
  deletePersonalAccessToken,
  deleteSshKey,
  generatePersonalAccessToken,
  listPersonalAccessTokens,
  listSshKeys,
} from "../mega2/user-credentials";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { invalidRoute, only, segmentNumber } from "./shared";

const addSshKeySchema = z.object({
  title: z.string().trim().min(1),
  publicKey: z.string().trim().min(1),
});

async function dispatchCredentialsGet(context: MegaDispatchContext): Promise<unknown> {
  const { segments, headers } = context;

  if (only(segments, ["user", "ssh"])) {
    return listSshKeys(headers);
  }
  if (only(segments, ["user", "tokens"])) {
    return listPersonalAccessTokens(headers);
  }

  return invalidRoute(segments);
}

async function dispatchCredentialsPost(context: MegaDispatchContext): Promise<unknown> {
  const { segments, body, headers } = context;

  if (only(segments, ["user", "ssh"])) {
    return addSshKey(addSshKeySchema.parse(body), headers);
  }
  if (only(segments, ["user", "tokens", "generate"])) {
    return generatePersonalAccessToken(headers);
  }

  return invalidRoute(segments);
}

async function dispatchCredentialsDelete(context: MegaDispatchContext): Promise<unknown> {
  const { segments, headers } = context;

  if (segments[0] === "user" && segments[1] === "ssh" && segments.length === 3) {
    return deleteSshKey(segmentNumber(segments[2]), headers);
  }
  if (segments[0] === "user" && segments[1] === "tokens" && segments.length === 3) {
    return deletePersonalAccessToken(segmentNumber(segments[2]), headers);
  }

  return invalidRoute(segments);
}

function matchesCredentialsRoutes(segments: readonly string[]): boolean {
  return segments[0] === "user" && (segments[1] === "ssh" || segments[1] === "tokens");
}

registerMegaRoute({
  match: (_method, segments) => matchesCredentialsRoutes(segments),
  handle: async (context) => {
    switch (context.method) {
      case "GET":
        return dispatchCredentialsGet(context);
      case "POST":
        return dispatchCredentialsPost(context);
      case "DELETE":
        return dispatchCredentialsDelete(context);
      default:
        return invalidRoute(context.segments);
    }
  },
});
