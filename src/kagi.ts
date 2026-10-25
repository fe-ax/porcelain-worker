import { HttpError, LIMITS, type Env, type ImageResult } from "./types";
import type { Fetcher } from "./claude";

// Kagi's image search for `kind: "images"` (WIRE.md section 3). The key is the Worker's secret (KAGI_API_KEY);
// only the search words go out. Mirrors Porcelain/Images/KagiImageSearch.swift: AI-generated pictures and
// thumbnails that are not on Kagi's own image proxy are dropped, one result per thumbnail.

export const KAGI_URL = "https://kagi.com/api/v1/search";
const IMAGE_HOST = "p.kagi.com";
const TIMEOUT_MS = 30_000;

interface Hit {
  url?: unknown;
  title?: unknown;
  props?: { thumbnail?: { url?: unknown }; ai_generated?: unknown };
}

export function kagiRequest(env: Env, query: string): Request {
  return new Request(KAGI_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.KAGI_API_KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ query, workflow: "images", limit: LIMITS.maxImageResults }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Searches Kagi. Any trouble on Kagi's side (no key, a rejected key, no credit, 5xx, nonsense) is 502 upstream. */
export async function searchImages(env: Env, query: string, fetcher: Fetcher): Promise<ImageResult[]> {
  if (!env.KAGI_API_KEY) throw new HttpError(502, { error: "upstream" });
  let response: Response;
  try {
    response = await fetcher(kagiRequest(env, query));
  } catch {
    throw new HttpError(502, { error: "upstream" });
  }
  let json: { data?: { image?: unknown }; errors?: unknown[] };
  try {
    json = (await response.json()) as typeof json;
  } catch {
    throw new HttpError(502, { error: "upstream", status: response.status });
  }
  if (!response.ok || (Array.isArray(json?.errors) && json.errors.length > 0)) {
    throw new HttpError(502, { error: "upstream", status: response.status });
  }
  return parseHits(json?.data?.image);
}

export function parseHits(hits: unknown): ImageResult[] {
  if (!Array.isArray(hits)) return [];
  const seen = new Set<string>();
  const results: ImageResult[] = [];
  for (const hit of hits as Hit[]) {
    const thumb = hit?.props?.thumbnail?.url;
    if (hit?.props?.ai_generated === true || typeof thumb !== "string" || !trusted(thumb) || seen.has(thumb)) continue;
    seen.add(thumb);
    let site: string | null = null;
    if (typeof hit.url === "string") {
      try {
        site = new URL(hit.url).hostname.replace(/^www\./, "");
      } catch {
        site = null;
      }
    }
    const title = typeof hit.title === "string" ? hit.title.trim().slice(0, 200) : "";
    results.push({ id: thumb, title: title || site || "–", site, thumbnail: thumb });
    if (results.length >= LIMITS.maxImageResults) break;
  }
  return results;
}

const trusted = (text: string): boolean => {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname === IMAGE_HOST;
  } catch {
    return false;
  }
};
