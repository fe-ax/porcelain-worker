import { handleAdmin } from "./admin";
import { handleChallenge, handleEnroll, handleStatus } from "./enroll";
import { handleRequest } from "./pipeline";
import { handleReview, handleReviewCancel, handleReviewStatus } from "./review";
import { HttpError, type Env } from "./types";

// Router. Endpoints and flow: ../docs/WIRE.md. Order for /v1/request: headers -> device status ->
// assertion -> rate limit -> body schema -> Claude (never reached by a rejected request).

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const handlers = {
  challenge: (request: Request, env: Env): Promise<Response> => handleChallenge(request, env),
  enroll: (request: Request, env: Env): Promise<Response> => handleEnroll(request, env),
  // The full pipeline lives in pipeline.ts (headers, device, assertion, status, limits, schema, Claude, output check).
  request: (request: Request, env: Env): Promise<Response> => handleRequest(request, env),
  status: (request: Request, env: Env): Promise<Response> => handleStatus(request, env),
  review: (request: Request, env: Env): Promise<Response> => handleReview(request, env),
  reviewStatus: (request: Request, env: Env): Promise<Response> => handleReviewStatus(request, env),
  reviewCancel: (request: Request, env: Env): Promise<Response> => handleReviewCancel(request, env),
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        return await handleAdmin(request, env, url);
      }
      const route = {
        "/v1/challenge": handlers.challenge,
        "/v1/enroll": handlers.enroll,
        "/v1/request": handlers.request,
        "/v1/status": handlers.status,
        "/v1/review": handlers.review,
        "/v1/review/status": handlers.reviewStatus,
        "/v1/review/cancel": handlers.reviewCancel,
      }[url.pathname];
      if (!route) return json(404, { error: "not_found" });
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json(error.http, error.body);
      return json(500, { error: "internal" });
    }
  },
} satisfies ExportedHandler<Env>;
