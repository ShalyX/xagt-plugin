# Verification

These checks exercise the exact behavior a reviewer needs to verify.

## 1. Automated suite

```bash
npm test
npm run check
```

The suite covers full release, proportional release, critical-failure caps, evaluator conflict, invalid weights, duplicate IDs, deterministic identifiers, health binding, deployment proof, valid API calls, structured validation errors, malformed JSON, OpenAPI, 404 behavior, and the reviewer workspace.

## 2. Health and commit binding

```bash
curl -sS "$API_ORIGIN/health"
```

Expected shape:

```json
{"status":"ok","commit":"<40-character-reviewed-commit>"}
```

## 3. Deployment proof

```bash
curl -sS "$API_ORIGIN/.well-known/xagent-verification.json"
```

Expected shape:

```json
{"schemaVersion":1,"slug":"elsemade-docket-resolve","commit":"<40-character-reviewed-commit>"}
```

## 4. Real evaluation

```bash
curl -sS -X POST "$API_ORIGIN/v1/evaluations" \
  -H "content-type: application/json" \
  --data-binary @examples/agreement.json
```

The example deterministically recommends a 92% release: `230000000` atomic units released and `20000000` held. With the declared six-decimal USDC denomination, that is 230 USDC released and 20 USDC held.

## 5. Conflict path

Add a second finding for `api-live` with a score at least 35 points away from the existing finding. The response must use `decision: manual_review`, include `EVALUATOR_CONFLICT`, and set all financial recommendation fields to `null`.
