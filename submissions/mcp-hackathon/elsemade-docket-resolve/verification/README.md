# Verification evidence

## Prerequisites

- Review commit: `f74c35643669646c7a8634c6570bb85a095dc3af`
- API base URL: https://docket-resolve.vercel.app/v1
- Authentication: None.
- Run commands from `submissions/mcp-hackathon/elsemade-docket-resolve/`.

## 1. Health check

```bash
curl --fail --silent --show-error https://docket-resolve.vercel.app/health
```

Expected response:

```json
{"status":"ok","commit":"f74c35643669646c7a8634c6570bb85a095dc3af"}
```

## 2. Deployment proof

```bash
curl --fail --silent --show-error https://docket-resolve.vercel.app/.well-known/xagent-verification.json
```

Expected response:

```json
{"schemaVersion":1,"slug":"elsemade-docket-resolve","commit":"f74c35643669646c7a8634c6570bb85a095dc3af"}
```

## 3. Capability call

```bash
curl --fail --silent --show-error \
  --request POST https://docket-resolve.vercel.app/v1/evaluations \
  --header "content-type: application/json" \
  --data-binary @source/examples/agreement.json
```

Expected success response:

```json
{
  "schemaVersion": 1,
  "evaluationId": "eval_bca9c486f48e907df911222562ddaf03",
  "agreementId": "agent-build-2026-019",
  "decision": "release_partial",
  "asset": { "symbol": "USDC", "decimals": 6 },
  "amountAtomic": 250000000,
  "recommendedReleaseAtomic": 230000000,
  "recommendedHoldAtomic": 20000000,
  "settlementRatioBps": 9200
}
```

The live response also contains the complete per-criterion ledger. The fields above are the stable assertions for this fixture.

## 4. Safe failure response

```bash
curl --silent --show-error \
  --request POST https://docket-resolve.vercel.app/v1/evaluations \
  --header "content-type: application/json" \
  --data '{}'
```

Expected: HTTP 422 with this response shape. `requestId` is generated per request.

```json
{
  "error": {
    "code": "INVALID_FIELD",
    "message": "agreementId must be a non-empty string.",
    "requestId": "request-specific UUID",
    "details": { "field": "agreementId" }
  }
}
```

No tokens, private data, production identifiers, or payment credentials are used by these checks.
