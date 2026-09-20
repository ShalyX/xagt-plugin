import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FixtureReviewProvider } from "../src/ai/providers.js";
import { createAuthConfig } from "../src/auth.js";
import { createRequestHandler } from "../src/http.js";
import { CaseStore } from "../src/persistence/store.js";

test("authenticated HTTP case journey survives the full production lifecycle", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "docket-e2e-"));
  const content = "FIXTURE_SCORE: 80\nThe artifact is complete enough for a partial release.";
  const agreement = {
    agreementId: "http_e2e_001",
    amountAtomic: 100_000_000,
    asset: { symbol: "USDC", decimals: 6 },
    criteria: [{ id: "delivery", description: "The artifact was delivered.", weight: 100, critical: true, minimumEvidence: 1 }],
    evidence: [{ id: "e_delivery", criterionId: "delivery", kind: "artifact", uri: "https://evidence.example.test/e2e.txt", digest: `sha256:${createHash("sha256").update(content).digest("hex")}`, result: "pass" }],
    findings: [],
  };
  const server = createServer(createRequestHandler({
    commit: "a".repeat(40),
    slug: "elsemade-docket-resolve",
    auth: createAuthConfig({
      DOCKET_AUTH_MODE: "required",
      DOCKET_AUTH_TOKENS: JSON.stringify({
        "e2e-agent-token": { tenantId: "tenant-e2e", subject: "e2e-agent", scopes: ["*"] },
        "other-agent-token": { tenantId: "tenant-other", subject: "other-agent", scopes: ["*"] },
      }),
    }),
    store: new CaseStore({ filePath: join(directory, "cases.json") }),
    reviewProvider: new FixtureReviewProvider(),
    evidenceFetcher: async () => new Response(content, { status: 200 }),
    evidenceAllowHosts: ["evidence.example.test"],
    evidenceResolver: async () => [{ address: "93.184.216.34", family: 4 }],
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: "Bearer e2e-agent-token", "content-type": "application/json" };
  try {
    const unauthorized = await fetch(`${origin}/v1/cases`);
    assert.equal(unauthorized.status, 401);

    const preflight = await fetch(`${origin}/v1/cases`, { method: "OPTIONS", headers: { origin: "http://localhost:4173", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, idempotency-key" } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/);

    const createdResponse = await fetch(`${origin}/v1/cases`, { method: "POST", headers: { ...headers, "idempotency-key": "e2e-create" }, body: JSON.stringify({ agreement }) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const caseId = created.case.caseId;

    const replayResponse = await fetch(`${origin}/v1/cases`, { method: "POST", headers: { ...headers, "idempotency-key": "e2e-create" }, body: JSON.stringify({ agreement }) });
    assert.equal((await replayResponse.json()).replayed, true);

    const retrievalResponse = await fetch(`${origin}/v1/cases/${caseId}/retrieve`, { method: "POST", headers: { ...headers, "idempotency-key": "e2e-retrieve" } });
    assert.equal((await retrievalResponse.json()).retrieval.items[0].verified, true);

    const reviewResponse = await fetch(`${origin}/v1/cases/${caseId}/review`, { method: "POST", headers: { ...headers, "idempotency-key": "e2e-review" } });
    const review = await reviewResponse.json();
    assert.equal(review.readyToResolve, true);

    const resolutionResponse = await fetch(`${origin}/v1/cases/${caseId}/resolve`, { method: "POST", headers: { ...headers, "idempotency-key": "e2e-resolve" } });
    const resolution = await resolutionResponse.json();
    assert.equal(resolution.recommendedReleaseAtomic, 80_000_000);
    assert.equal(resolution.recommendedHoldAtomic, 20_000_000);
    assert.equal(resolution.fundsMoved, false);

    const persisted = await fetch(`${origin}/v1/cases/${caseId}`, { headers: { authorization: "Bearer e2e-agent-token" } });
    const record = await persisted.json();
    assert.deepEqual(record.events.map((event) => event.type), ["case.created", "evidence.retrieved", "case.reviewed", "case.resolved"]);

    const crossTenant = await fetch(`${origin}/v1/cases/${caseId}`, { headers: { authorization: "Bearer other-agent-token" } });
    assert.equal(crossTenant.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
});
