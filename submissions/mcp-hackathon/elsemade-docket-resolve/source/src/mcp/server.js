import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { evaluateAgreement, EvaluationError } from "../evaluate.js";
import { createReviewProvider } from "../ai/providers.js";
import { reviewAgreement } from "../ai/review.js";
import { retrieveAgreementEvidence } from "../evidence/retrieve.js";
import { CaseStore } from "../persistence/store.js";

const agreementInput = z.object({
  agreement: z.record(z.string(), z.unknown()),
});

const reviewInput = z.object({
  agreement: z.record(z.string(), z.unknown()).optional(),
  caseId: z.string().min(1).optional(),
  evidenceContent: z
    .array(z.object({ id: z.string().min(1), content: z.string().max(24_000) }))
    .max(200)
    .default([]),
  retrieveEvidence: z.boolean().default(false),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const caseReferenceInput = z.object({
  caseId: z.string().min(1).optional(),
  agreement: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

function errorResult(error) {
  const code = error?.code ?? "INTERNAL_ERROR";
  const message =
    error instanceof EvaluationError || error?.name === "ReviewValidationError"
      ? error.message
      : code === "INTERNAL_ERROR"
        ? "The Docket operation failed safely."
        : error?.message ?? "The Docket operation failed.";
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
    structuredContent: { error: { code, message } },
  };
}

function result(output) {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function evaluationOutput(evaluation) {
  return {
    ...evaluation,
    recommendationOnly: true,
    fundsMoved: false,
    source: "docket-settlement-kernel",
  };
}

export function createDocketMcpServer({
  reviewProvider = createReviewProvider(),
  store,
  tenantId = "public",
  subject = "anonymous",
  evidenceFetcher = globalThis.fetch,
  evidenceAllowHosts = [],
  evidenceRequireAllowlist = false,
  evidenceResolver,
} = {}) {
  const caseStore = store ?? new CaseStore();
  const server = new McpServer(
    {
      name: "docket",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Docket reviews agent work and recommends explainable proportional settlements. It never moves funds. Agreement criteria are frozen before review; uncertain or conflicting evidence requires clarification or manual review.",
    },
  );

  server.registerTool(
    "docket_create_case",
    {
      title: "Create settlement case",
      description:
        "Persist a tenant-scoped agreement before evidence review. Retry with the same idempotency key to receive the same case.",
      inputSchema: z.object({
        agreement: z.record(z.string(), z.unknown()),
        idempotencyKey: z.string().min(1).max(200).optional(),
      }),
    },
    async ({ agreement, idempotencyKey }) => {
      try {
        const normalized = { ...agreement, findings: Array.isArray(agreement.findings) ? agreement.findings : [] };
        evaluateAgreement(normalized);
        return result(await caseStore.createCase({
          tenantId,
          subject,
          agreement: normalized,
          idempotencyKey,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "docket_get_case",
    {
      title: "Get settlement case",
      description: "Read a tenant-scoped case, its review state, recommendation, and immutable event history.",
      inputSchema: z.object({ caseId: z.string().min(1) }),
    },
    async ({ caseId }) => {
      const record = await caseStore.getCase({ tenantId, caseId });
      return record ? result(record) : errorResult({ code: "CASE_NOT_FOUND", message: "The case was not found." });
    },
  );

  server.registerTool(
    "docket_retrieve_evidence",
    {
      title: "Retrieve and verify evidence",
      description:
        "Fetch the case's HTTPS evidence references with bounded time and size limits, verify each SHA-256 digest, and persist retrieval results.",
      inputSchema: z.object({
        caseId: z.string().min(1),
        idempotencyKey: z.string().min(1).max(200).optional(),
      }),
    },
    async ({ caseId, idempotencyKey }) => {
      try {
        const record = await caseStore.getCase({ tenantId, caseId });
        if (!record) return errorResult({ code: "CASE_NOT_FOUND", message: "The case was not found." });
        const retrieval = await retrieveAgreementEvidence(record.agreement, {
          fetchImpl: evidenceFetcher,
          allowHosts: evidenceAllowHosts,
          requireAllowlist: evidenceRequireAllowlist,
          resolveHost: evidenceResolver,
        });
        const persisted = await caseStore.saveEvidenceRetrieval({
          tenantId,
          caseId,
          subject,
          items: retrieval.items,
          errors: retrieval.errors,
          idempotencyKey,
        });
        return result({ caseId, retrieval, persisted });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "docket_validate_agreement",
    {
      title: "Validate agreement",
      description:
        "Validate a settlement agreement and report whether its criteria, evidence references, findings, and policy are internally consistent. This does not move funds.",
      inputSchema: agreementInput,
    },
    async ({ agreement }) => {
      try {
        const evaluation = evaluateAgreement(agreement);
        return result({
          valid: true,
          agreementId: agreement.agreementId,
          evaluationId: evaluation.evaluationId,
          recommendationOnly: true,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "docket_review_case",
    {
      title: "Review case evidence",
      description:
        "Review supplied evidence against the agreement criteria and produce structured, cited findings. AI output is validated locally and never chooses a payment amount.",
      inputSchema: reviewInput,
    },
    async ({ agreement, evidenceContent }) => {
      try {
        if (!agreement) return errorResult({ code: "CASE_REFERENCE_REQUIRED", message: "Provide an agreement for stateless review or use caseId." });
        const review = await reviewAgreement({
          agreement,
          evidenceContent,
          provider: reviewProvider,
        });
        return result(review);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "docket_review_persisted_case",
    {
      title: "Review persisted case",
      description:
        "Run the configured evidence reviewer against a persisted, tenant-scoped case and save cited findings for later resolution.",
      inputSchema: reviewInput,
    },
    async ({ caseId, evidenceContent, retrieveEvidence, idempotencyKey }) => {
      try {
        if (!caseId) return errorResult({ code: "CASE_REFERENCE_REQUIRED", message: "caseId is required for persisted review." });
        let record = await caseStore.getCase({ tenantId, caseId });
        if (!record) return errorResult({ code: "CASE_NOT_FOUND", message: "The case was not found." });
        if (retrieveEvidence) {
          const retrieval = await retrieveAgreementEvidence(record.agreement, {
            fetchImpl: evidenceFetcher,
            allowHosts: evidenceAllowHosts,
            requireAllowlist: evidenceRequireAllowlist,
            resolveHost: evidenceResolver,
          });
          await caseStore.saveEvidenceRetrieval({
            tenantId,
            caseId,
            subject,
            items: retrieval.items,
            errors: retrieval.errors,
            idempotencyKey: `${idempotencyKey ?? "review"}:retrieve`,
          });
          record = await caseStore.getCase({ tenantId, caseId });
        }
        const reviewEvidenceContent = evidenceContent.length > 0 ? evidenceContent : record.evidenceContent;
        const review = await reviewAgreement({
          agreement: record.agreement,
          evidenceContent: reviewEvidenceContent,
          provider: reviewProvider,
        });
        const persisted = await caseStore.saveReview({ tenantId, caseId, subject, review, evidenceContent: reviewEvidenceContent, idempotencyKey });
        return result({ ...review, caseId, persisted });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "docket_resolve_case",
    {
      title: "Resolve proportional settlement",
      description:
        "Calculate the proportional release, hold, criterion ledger, and reason codes from a validated agreement and structured findings. This is a recommendation only; no funds move.",
      inputSchema: caseReferenceInput,
    },
    async ({ agreement, caseId, idempotencyKey }) => {
      try {
        if (!caseId) {
          if (!agreement) return errorResult({ code: "CASE_REFERENCE_REQUIRED", message: "Provide an agreement or caseId." });
          return result(evaluationOutput(evaluateAgreement(agreement)));
        }
        const record = await caseStore.getCase({ tenantId, caseId });
        if (!record) return errorResult({ code: "CASE_NOT_FOUND", message: "The case was not found." });
        if (!record.review) return errorResult({ code: "CASE_NOT_REVIEWED", message: "Review the case before resolving it." });
        const evaluation = evaluationOutput(evaluateAgreement({ ...record.agreement, findings: record.review.findings }));
        const persisted = await caseStore.saveResolution({ tenantId, caseId, subject, evaluation, idempotencyKey });
        return result({ ...evaluation, caseId, persisted });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export function createDocketMcpHandler(options = {}) {
  return createMcpHandler(() => createDocketMcpServer(options));
}
