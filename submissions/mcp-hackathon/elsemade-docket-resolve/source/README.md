# Docket Resolve

Docket Resolve turns structured evidence about agent-to-agent work into a deterministic, explainable settlement recommendation.

It does one job: given an agreed amount in explicitly denominated atomic units, weighted acceptance criteria, evidence references, and evaluator findings, return how much should be released, how much should remain on hold, and why.

The service does not move funds, fetch private data, or pretend to verify evidence it cannot see. It produces a recommendation that another agent, marketplace, or human can inspect before acting.

## Why agents need it

Agent marketplaces can automate task assignment and payment, but disputes still collapse into an all-or-nothing choice. Docket makes the acceptance contract machine-readable and preserves the reasoning behind a proportional outcome.

Typical callers include:

- an orchestrator checking a subcontractor's deliverables;
- a marketplace preparing an escrow release proposal;
- a review agent comparing independent findings;
- a human operator who needs an auditable case record.

## Run locally

Requirements: Node.js 20 or newer. There are no runtime dependencies.

```bash
npm test
npm start
```

Open `http://localhost:3000` for the interactive workspace.

## API

### Evaluate an agreement

```bash
curl -X POST http://localhost:3000/v1/evaluations \
  -H "content-type: application/json" \
  --data-binary @examples/agreement.json
```

The complete machine-readable contract is available at `GET /openapi.json`.

### Verification endpoints

```text
GET /health
GET /.well-known/xagent-verification.json
```

Production deployments must set `XAGT_COMMIT` to the exact 40-character reviewed Git commit and `XAGT_SLUG` to the submission directory slug. The endpoints deliberately expose those values so reviewers can bind the running service to its source.

## Decision model

1. Criterion weights must total 100.
2. Every finding must cite evidence for the same criterion.
3. Each evaluator may submit at most one finding per criterion.
4. Findings are aggregated by confidence-weighted score.
5. A criterion with no passing evidence earns nothing; failed evidence also marks it contradicted.
6. A failed critical criterion applies the agreement's declared release cap.
7. A score spread at or above the declared conflict threshold routes the case to manual review and suppresses the financial recommendation.
8. Otherwise, each criterion earns its weighted share of the agreement amount and the shares are summed.

The `evaluationId` is derived from a canonical SHA-256 digest of the input. Identical input produces the same result and identifier.

## Safety boundaries

- Recommendations only. No wallet, escrow, or payment authority is present.
- HTTPS evidence references and SHA-256 digests are required, but the API does not claim that a referenced artifact is truthful.
- Conflicting evaluators fail closed into manual review.
- Invalid references, duplicate IDs, malformed JSON, and oversized bodies return structured errors.
- No submitted agreement or evidence is persisted.
- Request logs never include agreement bodies or evidence content.

See [docs/verification.md](docs/verification.md) for repeatable reviewer checks and [docs/architecture.md](docs/architecture.md) for the system boundary.

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `3000` |
| `HOST` | Bind address | `0.0.0.0` |
| `XAGT_COMMIT` | Exact reviewed Git commit | `development` |
| `XAGT_SLUG` | X-Agent submission slug | `elsemade-docket-resolve` |
| `ALLOWED_ORIGIN` | CORS origin | `*` |

## Repository map

```text
api/            Vercel function entrypoint
docs/           architecture and verification evidence
examples/       reproducible request and expected response
public/         interactive reviewer workspace
src/            evaluator, HTTP adapter, OpenAPI and server
test/           behavior and live HTTP contract tests
```
