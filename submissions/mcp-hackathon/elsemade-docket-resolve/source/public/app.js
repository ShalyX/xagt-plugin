const exampleAgreement = {
  agreementId: "agent-build-2026-019",
  amountAtomic: 250000000,
  asset: { symbol: "USDC", decimals: 6 },
  policy: {
    conflictSpread: 35,
    criticalFailureCapPercent: 20,
  },
  criteria: [
    {
      id: "api-live",
      description: "Production API is reachable and returns the documented schema.",
      weight: 50,
      critical: true,
      minimumEvidence: 1,
    },
    {
      id: "docs",
      description: "A new agent can reproduce one real call from the documentation.",
      weight: 30,
      critical: false,
      minimumEvidence: 1,
    },
    {
      id: "edge-cases",
      description: "Invalid and conflicting inputs fail safely with useful errors.",
      weight: 20,
      critical: false,
      minimumEvidence: 1,
    },
  ],
  evidence: [
    {
      id: "ev-smoke",
      criterionId: "api-live",
      kind: "automated_test",
      uri: "https://example.com/proofs/smoke-test.json",
      digest: `sha256:${"a".repeat(64)}`,
      result: "pass",
    },
    {
      id: "ev-docs",
      criterionId: "docs",
      kind: "artifact",
      uri: "https://example.com/docs/quickstart",
      digest: `sha256:${"b".repeat(64)}`,
      result: "pass",
    },
    {
      id: "ev-errors",
      criterionId: "edge-cases",
      kind: "automated_test",
      uri: "https://example.com/proofs/error-cases.json",
      digest: `sha256:${"c".repeat(64)}`,
      result: "pass",
    },
  ],
  findings: [
    {
      id: "finding-api",
      criterionId: "api-live",
      evaluator: "review-agent-a",
      score: 100,
      confidence: 1,
      evidenceIds: ["ev-smoke"],
      rationale: "The production smoke test passed twice.",
    },
    {
      id: "finding-docs",
      criterionId: "docs",
      evaluator: "review-agent-a",
      score: 90,
      confidence: 0.95,
      evidenceIds: ["ev-docs"],
      rationale: "The documented call reproduced with one minor wording ambiguity.",
    },
    {
      id: "finding-errors",
      criterionId: "edge-cases",
      evaluator: "review-agent-b",
      score: 75,
      confidence: 0.9,
      evidenceIds: ["ev-errors"],
      rationale: "Malformed requests fail safely; one optional boundary case is absent.",
    },
  ],
};

const input = document.querySelector("#agreement-input");
const runButton = document.querySelector("#run-button");
const resetButton = document.querySelector("#reset-button");
const requestState = document.querySelector("#request-state");
const resultPanel = document.querySelector(".result-panel");

function resetExample() {
  input.value = JSON.stringify(exampleAgreement, null, 2);
  requestState.textContent = "Ready for review.";
  requestState.className = "";
}

function formatAmount(atomic, asset) {
  if (atomic === null) return "Pending review";
  const raw = BigInt(atomic);
  const base = 10n ** BigInt(asset.decimals);
  const whole = raw / base;
  let fraction = asset.decimals > 0
    ? (raw % base).toString().padStart(asset.decimals, "0").replace(/0+$/, "")
    : "";
  if (asset.decimals > 0) {
    fraction = fraction.padEnd(Math.min(2, asset.decimals), "0");
  }
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} ${asset.symbol}`;
}

function decisionLabel(decision) {
  return {
    release_full: "RELEASE",
    release_partial: "PARTIAL",
    hold: "HOLD",
    manual_review: "REVIEW",
  }[decision] ?? "FILED";
}

function renderEvaluation(result) {
  resultPanel.classList.add("has-result");
  document.querySelector("#decision-card").classList.toggle(
    "review",
    result.decision === "manual_review" || result.decision === "hold",
  );
  document.querySelector("#decision-stamp").textContent = decisionLabel(result.decision);
  document.querySelector("#release-amount").textContent = formatAmount(
    result.recommendedReleaseAtomic,
    result.asset,
  );
  document.querySelector("#release-ratio").textContent =
    result.settlementRatioBps === null
      ? "Conflicting findings require a human decision"
      : `${(result.settlementRatioBps / 100).toFixed(2)}% of the agreed amount`;
  document.querySelector("#evaluation-id").textContent = result.evaluationId;

  const ledger = document.querySelector("#criteria-ledger");
  ledger.replaceChildren(
    ...result.criteria.map((criterion) => {
      const row = document.createElement("div");
      row.className = "ledger-item";
      const name = document.createElement("div");
      name.className = "criterion-name";
      const title = document.createElement("strong");
      title.textContent = criterion.description;
      const meta = document.createElement("small");
      meta.textContent = `${criterion.weight}% weight · ${criterion.status}${criterion.critical ? " · critical" : ""}`;
      name.append(title, meta);
      const score = document.createElement("span");
      score.className = "score";
      score.textContent = `${criterion.score}`;
      const earned = document.createElement("span");
      earned.className = "earned";
      earned.textContent = formatAmount(criterion.earnedAtomic, result.asset);
      row.append(name, score, earned);
      return row;
    }),
  );

  const reasons = result.reasonCodes.length ? result.reasonCodes : ["NONE"];
  document.querySelector("#reason-codes").replaceChildren(
    ...reasons.map((reason) => {
      const chip = document.createElement("span");
      chip.className = `reason-chip${reason === "NONE" ? "" : " alert"}`;
      chip.textContent = reason;
      return chip;
    }),
  );
}

async function runEvaluation() {
  requestState.className = "";
  runButton.disabled = true;
  requestState.textContent = "Reviewing the agreement…";
  try {
    const agreement = JSON.parse(input.value);
    const response = await fetch("/v1/evaluations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(agreement),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`${body.error.code}: ${body.error.message}`);
    }
    renderEvaluation(body);
    requestState.textContent = "Filed. The result is deterministic for this input.";
  } catch (error) {
    requestState.className = "error";
    requestState.textContent = error instanceof Error ? error.message : "Evaluation failed.";
  } finally {
    runButton.disabled = false;
  }
}

resetButton.addEventListener("click", resetExample);
runButton.addEventListener("click", runEvaluation);
resetExample();
