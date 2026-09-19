# Docket Resolve

## Capability

- **One-line description:** Turns structured evidence about agent-to-agent work into a deterministic, explainable settlement recommendation.
- **Who it helps:** Agent marketplaces, orchestrators, review agents, and human operators handling acceptance disputes.
- **Capability boundary:** Docket Resolve calculates a proportional release-or-hold recommendation from a declared agreement, weighted criteria, evidence references, and evaluator findings. It does not move funds, inspect private artifacts, or claim that cited evidence is true.

## Live API

- **API base URL:** https://docket-resolve.vercel.app/v1
- **Health-check URL:** https://docket-resolve.vercel.app/health
- **Authentication:** None.
- **Rate limits / known limits:** Request bodies are capped at 256 KiB. Amounts must be positive safe integers no greater than 90,071,992,547,409 atomic units. There is no application-level rate limiter; Vercel platform limits apply. Evaluations are synchronous and normally complete within one request.
- **API contract:** `source/src/openapi.js` serves the OpenAPI document at `GET /openapi.json`. The capability endpoint is `POST /v1/evaluations` with `application/json`.

## Source and reproducibility

- **Source repository:** https://github.com/ShalyX/docket-resolve
- **Review commit:** `f74c35643669646c7a8634c6570bb85a095dc3af`
- **Source submitted in this PR:** `source/`
- **Run tests:** `npm ci && npm test && npm run check`
- **Run locally:** `npm ci && npm start`, then open `http://localhost:3000`
- **Deploy:** Link the repository in Vercel, retain the service configuration in `vercel.json`, set `XAGT_COMMIT=f74c35643669646c7a8634c6570bb85a095dc3af` and `XAGT_SLUG=elsemade-docket-resolve`, then deploy from the repository root.
- **Version binding:** The same deployment reports the reviewed commit from both `/health` and `/.well-known/xagent-verification.json`.

The API exposes:

```json
{"status":"ok","commit":"f74c35643669646c7a8634c6570bb85a095dc3af"}
```

```json
{"schemaVersion":1,"slug":"elsemade-docket-resolve","commit":"f74c35643669646c7a8634c6570bb85a095dc3af"}
```

## Verification

The reproducible call instructions and redacted example responses are in `verification/README.md`.

- **Health-check result:** HTTP 200 with `status: ok` and the exact 40-character review commit.
- **Capability call:** `POST /v1/evaluations` with `source/examples/agreement.json`. The deterministic example recommends releasing 230,000,000 of 250,000,000 atomic units and holding 20,000,000, a 92% release.
- **Expected error behavior:** Malformed JSON returns 400; oversized bodies return 413; a non-JSON content type returns 415; invalid agreements return a structured 422 response. Materially conflicting evaluator findings return HTTP 200 with `decision: manual_review` and no financial recommendation.

## Security and data handling

- **Data collected:** The request contains an agreement identifier, asset denomination, amount, policy values, criteria, public evidence references and digests, evaluator identifiers, scores, confidence values, and rationales.
- **Purpose and retention:** Data is used only to compute the response in memory. The application does not persist request bodies or evidence content.
- **Third parties / outbound network calls:** None. Evidence URLs are treated as references and are never fetched by the service. Vercel hosts the public deployment.
- **Secrets:** No secrets are committed. Review access is supplied only through an approved private channel when required.
- **Known risks / restrictions:** This is a recommendation engine, not an escrow, oracle, payment processor, or proof verifier. A caller must independently verify evidence and retain authority over any payment action. CORS defaults to all origins for public review and can be narrowed with `ALLOWED_ORIGIN`.

## Support

- **Team / builder:** ShalyX, publishing as ElseMade
- **Contact:** https://github.com/ShalyX
- **License / rights:** First-party source is submitted as UNLICENSED. The submitter confirms the review and archive authorization in `RIGHTS.md`; no third-party runtime code is bundled.
