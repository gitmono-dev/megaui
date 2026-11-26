// Registry requests deliberately use Mega2's OCI read policy, not Web session
// cookies or privileged credentials. Only publicly readable data is returned.
import { z } from "zod";
import { MegaBadRequestError, MegaInternalError, MegaUnauthorizedError, resolveMega2BaseUrl } from "@megaui/engine";
import { registerMegaRoute } from "../dispatch";

const catalogSchema = z.object({ repositories: z.array(z.string()) });
const tagsSchema = z.object({ name: z.string(), tags: z.array(z.string()) });
const repositoryPattern = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;

registerMegaRoute({
  match: (method, segments) => method === "GET" && segments[0] === "images" && (segments.length === 1 || (segments.length === 2 && segments[1] === "tags")),
  handle: async ({ segments, searchParams }) => {
    const base = process.env.MEGA2_OCI_BASE_URL?.trim() || resolveMega2BaseUrl();
    let origin: URL;
    try { origin = new URL(base); } catch { throw new MegaInternalError("Invalid image registry configuration"); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new MegaInternalError("Invalid image registry configuration");
    }
    const repository = searchParams.get("repository") ?? "";
    if (segments.length === 2 && (!repositoryPattern.test(repository) || repository.length > 255)) throw new MegaBadRequestError("Invalid image repository");
    const url = new URL(segments.length === 1 ? "/v2/_catalog" : `/v2/${repository}/tags/list`, origin);
    url.searchParams.set("n", "100");
    const query = searchParams.get("q");
    if (query && segments.length === 1) url.searchParams.set("q", query.slice(0, 255));
    const after = searchParams.get("after");
    if (after) url.searchParams.set("last", after);
    let response: Response;
    try { response = await fetch(url, { signal: AbortSignal.timeout(10_000) }); }
    catch { throw new MegaInternalError("Image registry is unavailable"); }
    if (response.status === 401 || response.status === 403) throw new MegaUnauthorizedError("Image registry access is not available");
    if (!response.ok) throw new MegaInternalError("Image registry is unavailable");
    const parsed = (segments.length === 1 ? catalogSchema : tagsSchema).safeParse(await response.json());
    if (!parsed.success) throw new MegaInternalError("Image registry returned an invalid response");
    const data = parsed.data;
    const items = "repositories" in data ? data.repositories : data.tags;
    return { items, next: response.headers.has("link") ? items.at(-1) ?? null : null };
  },
});
