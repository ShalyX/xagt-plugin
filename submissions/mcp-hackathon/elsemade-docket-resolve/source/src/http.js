import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { EvaluationError, evaluateAgreement } from "./evaluate.js";
import { createOpenApiDocument } from "./openapi.js";

const MAX_BODY_BYTES = 256 * 1024;
const PUBLIC_FILES = new Map([
  ["/", { contentType: "text/html; charset=utf-8", body: readFileSync(new URL("../public/index.html", import.meta.url)) }],
  ["/app.js", { contentType: "text/javascript; charset=utf-8", body: readFileSync(new URL("../public/app.js", import.meta.url)) }],
  ["/styles.css", { contentType: "text/css; charset=utf-8", body: readFileSync(new URL("../public/styles.css", import.meta.url)) }],
  ["/favicon.svg", { contentType: "image/svg+xml", body: readFileSync(new URL("../public/favicon.svg", import.meta.url)) }],
]);

function readJsonBody(request) {
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
        resolve(JSON.parse(raw));
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
    "access-control-allow-headers": "content-type",
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

export function createRequestHandler({ commit, slug, allowedOrigin = "*" }) {
  return async function requestHandler(request, response) {
    const requestId = randomUUID();
    const origin = `http://${request.headers.host ?? "localhost"}`;
    const url = new URL(request.url ?? "/", origin);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-origin": allowedOrigin,
        "x-request-id": requestId,
      });
      response.end();
      return;
    }

    const publicFile = request.method === "GET" ? PUBLIC_FILES.get(url.pathname) : null;
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

    sendJson(
      response,
      404,
      errorBody("NOT_FOUND", "No route matches this request.", requestId),
      requestId,
      allowedOrigin,
    );
  };
}
