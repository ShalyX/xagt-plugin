# Architecture

```text
Agent or reviewer
      |
      | POST /v1/evaluations
      v
HTTP boundary
  - body limit
  - JSON parsing
  - request ID
  - structured errors
      |
      v
Agreement validator
  - unique IDs
  - weight total
  - evidence references
  - score and policy bounds
      |
      v
Deterministic evaluator
  - confidence-weighted scores
  - contradiction caps
  - conflict detection
  - proportional allocation
      |
      v
Explainable recommendation
  - decision
  - release / hold
  - criterion ledger
  - reason codes
  - stable evaluation ID
```

## Trust boundary

Docket validates the structure and internal consistency of a case. It does not download evidence or declare that third-party claims are true. Evidence authenticity and evaluator authority belong to the calling system. This boundary keeps the core deterministic and prevents a settlement recommendation from being mistaken for an oracle.

## State

The service is stateless. It stores no agreements, findings, evidence, or recommendations. A caller that needs history should persist the request and response together with the returned evaluation ID.

## Failure behavior

- Invalid cases return `422` with a stable error code.
- Invalid JSON returns `400`.
- Unsupported media types return `415`.
- Bodies above 256 KiB return `413`.
- Material evaluator conflict returns `200` with `decision: manual_review` and null financial fields. This is a valid evaluation, not a transport failure.
