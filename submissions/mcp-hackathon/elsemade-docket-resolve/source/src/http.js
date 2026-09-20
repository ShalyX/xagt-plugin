import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { toNodeHandler } from "@modelcontextprotocol/node";

import { EvaluationError, evaluateAgreement } from "./evaluate.js";
import { createReviewProvider } from "./ai/providers.js";
import { ReviewValidationError, reviewAgreement } from "./ai/review.js";
import { authenticate, AuthError, requireScope } from "./auth.js";
import { retrieveAgreementEvidence } from "./evidence/retrieve.js";
import { fixtureEvidenceContent } from "./evidence/fixture.js";
import { createDocketMcpHandler } from "./mcp/server.js";
import { createOpenApiDocument } from "./openapi.js";
import { CaseStore, CaseStoreError } from "./persistence/store.js";

const MAX_BODY_BYTES = 256 * 1024;
const PUBLIC_FILES = new Map([
  ["/", { contentType: "text/html; charset=utf-8", body: readFileSync(new URL("../public/index.html", import.meta.url)) }],
  ["/app.js", { contentType: "text/javascript; charset=utf-8", body: readFileSync(new URL("../public/app.js", import.meta.url)) }],
  ["/retrieval-status.js", { contentType: "text/javascript; charset=utf-8", body: readFileSync(new URL("../public/retrieval-status.js", import.meta.url)) }],
  ["/styles.css", { contentType: "text/css; charset=utf-8", body: readFileSync(new URL("../public/styles.css", import.meta.url)) }],
  ["/favicon.svg", { contentType: "image/svg+xml", body: readFileSync(new URL("../public/favicon.svg", import.meta.url)) }],
]);
const PUBLIC_EVIDENCE_FILES = new Map([
  ["/fixtures/evidence/ev-smoke.txt", "https://evidence.example.test/ev-smoke.txt"],
  ["/fixtures/evidence/ev-docs.txt", "https://evidence.example.test/ev-docs.txt"],
  ["/fixtures/evidence/ev-errors.txt", "https://evidence.example.test/ev-errors.txt"],
].map(([path, uri]) => [path, {
  contentType: "text/plain; charset=utf-8",
  body: Buffer.from(fixtureEvidenceContent(uri), "utf8"),
}]));

function readJsonBody(request, { optional = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        const error = new Error("Request body exceeds 256 KiB.");
        error.code = "PAYLOAD_TOO_LARGE";
        reject(error);
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(optional && raw.trim() === "" ? {} : JSON.parse(raw));
      } catch {
        const error = new Error("Request body is not valid JSON.");
        error.code = "INVALID_JSON";
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body, requestId, allowedOrigin) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "access-control-allow-headers": "content-type, authorization, idempotency-key",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": allowedOrigin,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
  response.end(payload);
}

function sendPublicFile(response, file, requestId) {
  response.writeHead(200, {
    "cache-control": file.contentType.startsWith("text/html")
      ? "no-cache"
      : "public, max-age=3600",
    "content-length": file.body.length,
    "content-security-policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "content-type": file.contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-request-id": requestId,
  });
  response.end(file.body);
}

function errorBody(code, message, requestId, details = undefined) {
  const error = { code, message, requestId };
  if (details !== undefined) {
    error.details = details;
  }
  return { error };
}

function idempotencyKey(request) {
  const value = request.headers["idempotency-key"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function routeCaseId(pathname) {
  const match = /^\/v1\/cases\/([^/]+)(?:\/(retrieve|review|resolve))?$/.exec(pathname);
  return match ? { caseId: decodeURIComponent(match[1]), action: match[2] ?? null } : null;
}

function evaluationOutput(evaluation) {
  return {
    ...evaluation,
    recommendationOnly: true,
    fundsMoved: false,
    source: "docket-settlement-kernel",
  };
}

export function createRequestHandler({
  commit,
  slug,
  allowedOrigin = "*",
  reviewProvider = createReviewProvider(),
  auth = { required: false, tokens: new Map() },
  store,
  storagePath = "data/docket-store.json",
  evidenceFetcher = globalThis.fetch,
  evidenceAllowHosts = [],
  evidenceRequireAllowlist = false,
  evidenceResolver,
}) {
  const caseStore = store ?? new CaseStore({ filePath: storagePath });
  const requireEvidenceAllowlist = evidenceRequireAllowlist || auth.required;
  return async function requestHandler(request, response) {
    const requestId = randomUUID();
    const origin = `http://${request.headers.host ?? "localhost"}`;
    const url = new URL(request.url ?? "/", origin);
    const protectedRequest = url.pathname === "/mcp" || url.pathname.startsWith("/v1/");
    let identity = null;

    if (protectedRequest && request.method !== "OPTIONS") {
      try {
        identity = authenticate(request, auth);
      } catch (error) {
        if (error instanceof AuthError) {
          sendJson(response, error.status, errorBody(error.code, error.message, requestId), requestId, allowedOrigin);
          return;
        }
        throw error;
      }
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-headers": "content-type, authorization, idempotency-key",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-origin": allowedOrigin,
        "x-request-id": requestId,
      });
      response.end();
      return;
    }

    if (url.pathname === "/mcp") {
      try {
        requireScope(identity, "cases:read");
        const handler = toNodeHandler(createDocketMcpHandler({
          reviewProvider,
          store: caseStore,
          tenantId: identity.tenantId,
          subject: identity.subject,
          evidenceFetcher,
          evidenceAllowHosts,
          evidenceRequireAllowlist: requireEvidenceAllowlist,
          evidenceResolver,
        }));
        await handler(request, response);
      } catch (error) {
        if (!response.headersSent) {
          sendJson(response, 500, errorBody("MCP_FAILED", "The MCP request failed safely.", requestId), requestId, allowedOrigin);
        }
      }
      return;
    }

    const publicFile = request.method === "GET"
      ? PUBLIC_FILES.get(url.pathname) ?? PUBLIC_EVIDENCE_FILES.get(url.pathname)
      : null;
    if (publicFile) {
      sendPublicFile(response, publicFile, requestId);
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", commit }, requestId, allowedOrigin);
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/xagent-verification.json"
    ) {
      sendJson(
        response,
        200,
        { schemaVersion: 1, slug, commit },
        requestId,
        allowedOrigin,
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/openapi.json") {
      sendJson(
        response,
        200,
        createOpenApiDocument({ origin }),
        requestId,
        allowedOrigin,
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/cases") {
      try {
        requireScope(identity, "cases:read");
        sendJson(response, 200, { cases: await caseStore.listCases({ tenantId: identity.tenantId }) }, requestId, allowedOrigin);
      } catch (error) {
        if (error instanceof AuthError || error instanceof CaseStoreError) {
          sendJson(response, error.status, errorBody(error.code, error.message, requestId), requestId, allowedOrigin);
          return;
        }
        console.error(JSON.stringify({ level: "error", requestId, code: "CASE_LIST_FAILED", message: error.message }));
        sendJson(response, 500, errorBody("CASE_LIST_FAILED", "Cases could not be loaded.", requestId), requestId, allowedOrigin);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/cases") {
      try {
        requireScope(identity, "cases:write");
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || !body.agreement || typeof body.agreement !== "object") {
          sendJson(response, 422, errorBody("INVALID_CASE_REQUEST", "Case requests must include an agreement object.", requestId), requestId, allowedOrigin);
          return;
        }
        const agreement = {
          ...body.agreement,
          findings: Array.isArray(body.agreement.findings) ? body.agreement.findings : [],
        };
        evaluateAgreement(agreement);
        const created = await caseStore.createCase({
          tenantId: identity.tenantId,
          subject: identity.subject,
          agreement,
          idempotencyKey: idempotencyKey(request),
        });
        sendJson(response, created.replayed ? 200 : 201, created, requestId, allowedOrigin);
      } catch (error) {
        if (error instanceof AuthError || error instanceof CaseStoreError || error instanceof EvaluationError) {
          sendJson(response, error.status ?? 422, errorBody(error.code, error.message, requestId, error.details), requestId, allowedOrigin);
          return;
        }
        if (error?.code === "INVALID_JSON") {
          sendJson(response, 400, errorBody(error.code, error.message, requestId), requestId, allowedOrigin);
          return;
        }
        if (error?.code === "PAYLOAD_TOO_LARGE") {
          sendJson(response, 413, errorBody(error.code, error.message, requestId), requestId, allowedOrigin);
          return;
        }
        console.error(JSON.stringify({ level: "error", requestId, code: "CASE_CREATE_FAILED", message: error.message }));
        sendJson(response, 500, errorBody("CASE_CREATE_FAILED", "The case could not be created.", requestId), requestId, allowedOrigin);
      }
      return;
    }

    const caseRoute = routeCaseId(url.pathname);
    if (caseRoute && request.method === "GET" && !caseRoute.action) {
      try {
        requireScope(identity, "cases:read");
        const record = await caseStore.getCase({ tenantId: identity.tenantId, caseId: caseRoute.caseId });
        if (!record) {
          sendJson(response, 404, errorBody("CASE_NOT_FOUND", "The case was not found.", requestId), requestId, allowedOrigin);
          return;
        }
        sendJson(response, 200, record, requestId, allowedOrigin);
      } catch (error) {
        if (error instanceof AuthError) sendJson(response, error.status, errorBody(error.code, error.message, requestId), requestId, allowedOrigin);
        else sendJson(response, 500, errorBody("CASE_READ_FAILED", "The case could not be loaded.", requestId), requestId, allowedOrigin);
      }
      return;
    }

    if (caseRoute && request.method === "POST") {
      try {
        requireScope(identity, "cases:write");
        let record = await caseStore.getCase({ tenantId: identity.tenantId, caseId: caseRoute.caseId });
        if (!record) {
          sendJson(response, 404, errorBody("CASE_NOT_FOUND", "The case was not found.", requestId), requestId, allowedOrigin);
          return;
        }

        if (caseRoute.action === "retrieve") {
          const retrieval = await retrieveAgreementEvidence(record.agreement, {
            fetchImpl: evidenceFetcher,
            allowHosts: evidenceAllowHosts,
            requireAllowlist: requireEvidenceAllowlist,
            resolveHost: evidenceResolver,
          });
          const saved = await caseStore.saveEvidenceRetrieval({
            tenantId: identity.tenantId,
            caseId: caseRoute.caseId,
            subject: identity.subject,
            items: retrieval.items,
            errors: retrieval.errors,
            idempotencyKey: idempotencyKey(request),
          });
          sendJson(response, 200, { ...saved, retrieval }, requestId, allowedOrigin);
          return;
        }

        if (caseRoute.action === "review") {
          const body = await readJsonBody(request, { optional: true });
          if (body?.retrieveEvidence) {
            const retrieval = await retrieveAgreementEvidence(record.agreement, {
              fetchImpl: evidenceFetcher,
              allowHosts: evidenceAllowHosts,
              requireAllowlist: requireEvidenceAllowlist,
              resolveHost: evidenceResolver,
            });
            await caseStore.saveEvidenceRetrieval({
              tenantId: identity.tenantId,
              caseId: caseRoute.caseId,
              subject: identity.subject,
              items: retrieval.items,
              errors: retrieval.errors,
              idempotencyKey: `${idempotencyKey(request) ?? "review"}:retrieve`,
            });
            record = await caseStore.getCase({ tenantId: identity.tenantId, caseId: caseRoute.caseId });
          }
          const reviewEvidenceContent = Array.isArray(body?.evidenceContent) ? body.evidenceContent : record.evidenceContent;
          const review = await reviewAgreement({
            agreement: record.agreement,
            evidenceContent: reviewEvidenceContent,
            provider: reviewProvider,
          });
          const saved = await caseStore.saveReview({
            tenantId: identity.tenantId,
            caseId: caseRoute.caseId,
            subject: identity.subject,
            review,
            evidenceContent: reviewEvidenceContent,
            idempotencyKey: idempotencyKey(request),
          });
          sendJson(response, 200, { ...review, caseId: caseRoute.caseId, persisted: saved }, requestId, allowedOrigin);
          return;
        }

        if (caseRoute.action === "resolve") {
          if (!record.review) {
            sendJson(response, 409, errorBody("CASE_NOT_REVIEWED", "Review the case before resolving it.", requestId), requestId, allowedOrigin);
            return;
          }
          const evaluation = evaluationOutput(evaluateAgreement({ ...record.agreement, findings: record.review.findings }));
          const saved = await caseStore.saveResolution({
            tenantId: identity.tenantId,
            caseId: caseRoute.caseId,
            subject: identity.subject,
            evaluation,
            idempotencyKey: idempotencyKey(request),
          });
          sendJson(response, 200, { ...evaluation, persisted: saved }, requestId, allowedOrigin);
          return;
        }
      } catch (error) {
        if (error instanceof AuthError || error instanceof CaseStoreError || error instanceof EvaluationError || error instanceof ReviewValidationError) {
          sendJson(response, error.status ?? 422, errorBody(error.code, error.message, requestId, error.details), requestId, allowedOrigin);
          return;
        }
        if (error?.code === "INVALID_JSON") {
          sendJson(response, 400, errorBody(error.code, error.message, requestId), requestId, allowedOrigin);
          return;
        }
        if (error?.code === "PAYLOAD_TOO_LARGE") {
          sendJson(response, 413, errorBody(error.code, error.message, requestId), requestId, allowedOrigin);
          return;
        }
        console.error(JSON.stringify({ level: "error", requestId, code: error?.code ?? "CASE_ACTION_FAILED", message: error.message }));
        sendJson(response, 500, errorBody(error?.code ?? "CASE_ACTION_FAILED", "The case action failed safely.", requestId), requestId, allowedOrigin);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/evaluations") {
      const contentType = request.headers["content-type"] ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        sendJson(
          response,
          415,
          errorBody(
            "UNSUPPORTED_MEDIA_TYPE",
            "Content-Type must be application/json.",
            requestId,
          ),
          requestId,
          allowedOrigin,
        );
        return;
      }

      try {
        const agreement = await readJsonBody(request);
        const evaluation = evaluateAgreement(agreement);
        sendJson(response, 200, evaluation, requestId, allowedOrigin);
      } catch (error) {
        if (error instanceof EvaluationError) {
          sendJson(
            response,
            422,
            errorBody(error.code, error.message, requestId, error.details),
            requestId,
            allowedOrigin,
          );
          return;
        }
        if (error?.code === "INVALID_JSON") {
          sendJson(
            response,
            400,
            errorBody("INVALID_JSON", error.message, requestId),
            requestId,
            allowedOrigin,
          );
          return;
        }
        if (error?.code === "PAYLOAD_TOO_LARGE") {
          if (!response.headersSent) {
            sendJson(
              response,
              413,
              errorBody("PAYLOAD_TOO_LARGE", error.message, requestId),
              requestId,
              allowedOrigin,
            );
          }
          return;
        }

        console.error(JSON.stringify({
          level: "error",
          requestId,
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
        }));
        sendJson(
          response,
          500,
          errorBody("INTERNAL_ERROR", "The evaluation failed.", requestId),
          requestId,
          allowedOrigin,
        );
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/reviews") {
      const contentType = request.headers["content-type"] ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        sendJson(
          response,
          415,
          errorBody(
            "UNSUPPORTED_MEDIA_TYPE",
            "Content-Type must be application/json.",
            requestId,
          ),
          requestId,
          allowedOrigin,
        );
        return;
      }

      try {
        const body = await readJsonBody(request);
        if (
          body === null ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          body.agreement === null ||
          typeof body.agreement !== "object" ||
          Array.isArray(body.agreement)
        ) {
          sendJson(
            response,
            422,
            errorBody(
              "INVALID_REVIEW_REQUEST",
              "Review requests must include an agreement object.",
              requestId,
            ),
            requestId,
            allowedOrigin,
          );
          return;
        }
        const review = await reviewAgreement({
          agreement: body.agreement,
          evidenceContent: Array.isArray(body.evidenceContent)
            ? body.evidenceContent
            : [],
          provider: reviewProvider,
        });
        sendJson(response, 200, review, requestId, allowedOrigin);
      } catch (error) {
        if (error instanceof EvaluationError || error instanceof ReviewValidationError) {
          sendJson(
            response,
            422,
            errorBody(error.code, error.message, requestId, error.details),
            requestId,
            allowedOrigin,
          );
          return;
        }
        if (error?.code === "INVALID_JSON") {
          sendJson(
            response,
            400,
            errorBody("INVALID_JSON", error.message, requestId),
            requestId,
            allowedOrigin,
          );
          return;
        }
        if (error?.code === "PAYLOAD_TOO_LARGE") {
          sendJson(
            response,
            413,
            errorBody("PAYLOAD_TOO_LARGE", error.message, requestId),
            requestId,
            allowedOrigin,
          );
          return;
        }
        console.error(JSON.stringify({
          level: "error",
          requestId,
          code: error?.code ?? "AI_REVIEW_FAILED",
          message: error instanceof Error ? error.message : "Unknown review error",
        }));
        sendJson(
          response,
          503,
          errorBody("AI_REVIEW_FAILED", "The evidence review is unavailable.", requestId),
          requestId,
          allowedOrigin,
        );
      }
      return;
    }

    sendJson(
      response,
      404,
      errorBody("NOT_FOUND", "No route matches this request.", requestId),
      requestId,
      allowedOrigin,
    );
  };
}
