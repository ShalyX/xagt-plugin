export function createOpenApiDocument({ origin = "http://localhost:3000" } = {}) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Docket Resolve API",
      version: "0.1.0",
      description:
        "Deterministic, explainable settlement recommendations for agent-to-agent work.",
    },
    servers: [{ url: origin }],
    paths: {
      "/health": {
        get: {
          operationId: "getHealth",
          summary: "Return service health and the exact deployed Git commit.",
          responses: { 200: { description: "Healthy deployment" } },
        },
      },
      "/.well-known/xagent-verification.json": {
        get: {
          operationId: "getXAgentVerification",
          summary: "Bind this origin to the X-Agent submission slug and commit.",
          responses: { 200: { description: "Deployment proof" } },
        },
      },
      "/v1/evaluations": {
        post: {
          operationId: "evaluateAgreement",
          summary: "Evaluate evidence and recommend a proportional settlement.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Agreement" },
              },
            },
          },
          responses: {
            200: {
              description: "Deterministic evaluation",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Evaluation" },
                },
              },
            },
            400: { description: "Malformed JSON" },
            413: { description: "Request body too large" },
            415: { description: "Unsupported media type" },
            422: { description: "Agreement failed validation" },
          },
        },
      },
    },
    components: {
      schemas: {
        Criterion: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "description",
            "weight",
            "critical",
            "minimumEvidence",
          ],
          properties: {
            id: { type: "string", minLength: 1 },
            description: { type: "string", minLength: 1 },
            weight: { type: "integer", minimum: 1, maximum: 100 },
            critical: { type: "boolean" },
            minimumEvidence: { type: "integer", minimum: 0 },
          },
        },
        Evidence: {
          type: "object",
          additionalProperties: false,
          required: ["id", "criterionId", "kind", "uri", "digest", "result"],
          properties: {
            id: { type: "string", minLength: 1 },
            criterionId: { type: "string", minLength: 1 },
            kind: {
              type: "string",
              enum: ["artifact", "attestation", "automated_test", "receipt"],
            },
            uri: { type: "string", format: "uri", pattern: "^https://" },
            digest: { type: "string", pattern: "^sha256:[a-fA-F0-9]{64}$" },
            result: { type: "string", enum: ["pass", "fail", "inconclusive"] },
          },
        },
        Finding: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "criterionId",
            "evaluator",
            "score",
            "confidence",
            "evidenceIds",
            "rationale",
          ],
          properties: {
            id: { type: "string", minLength: 1 },
            criterionId: { type: "string", minLength: 1 },
            evaluator: { type: "string", minLength: 1 },
            score: { type: "number", minimum: 0, maximum: 100 },
            confidence: { type: "number", exclusiveMinimum: 0, maximum: 1 },
            evidenceIds: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
            rationale: { type: "string", minLength: 1 },
          },
        },
        Agreement: {
          type: "object",
          additionalProperties: false,
          required: [
            "agreementId",
            "amountAtomic",
            "asset",
            "criteria",
            "evidence",
            "findings",
          ],
          properties: {
            agreementId: { type: "string", minLength: 1 },
            amountAtomic: { type: "integer", minimum: 1, maximum: 90071992547409 },
            asset: {
              type: "object",
              additionalProperties: false,
              required: ["symbol", "decimals"],
              properties: {
                symbol: { type: "string", pattern: "^[A-Za-z0-9._-]{1,16}$" },
                decimals: { type: "integer", minimum: 0, maximum: 18 },
              },
            },
            policy: {
              type: "object",
              additionalProperties: false,
              properties: {
                conflictSpread: { type: "number", minimum: 0, maximum: 100 },
                criticalFailureCapPercent: {
                  type: "number",
                  minimum: 0,
                  maximum: 100,
                },
              },
            },
            criteria: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/components/schemas/Criterion" },
            },
            evidence: {
              type: "array",
              items: { $ref: "#/components/schemas/Evidence" },
            },
            findings: {
              type: "array",
              items: { $ref: "#/components/schemas/Finding" },
            },
          },
        },
        Evaluation: {
          type: "object",
          required: [
            "schemaVersion",
            "evaluationId",
            "agreementId",
            "decision",
            "asset",
            "amountAtomic",
            "recommendedReleaseAtomic",
            "recommendedHoldAtomic",
            "settlementRatioBps",
            "criteria",
            "reasonCodes",
          ],
          properties: {
            schemaVersion: { const: 1 },
            evaluationId: { type: "string", pattern: "^eval_[a-f0-9]{32}$" },
            agreementId: { type: "string" },
            decision: {
              type: "string",
              enum: ["release_full", "release_partial", "hold", "manual_review"],
            },
            asset: {
              type: "object",
              required: ["symbol", "decimals"],
              properties: {
                symbol: { type: "string" },
                decimals: { type: "integer" },
              },
            },
            amountAtomic: { type: "integer" },
            recommendedReleaseAtomic: { type: ["integer", "null"] },
            recommendedHoldAtomic: { type: ["integer", "null"] },
            settlementRatioBps: { type: ["integer", "null"] },
            criteria: { type: "array", items: { type: "object" } },
            reasonCodes: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };
}
