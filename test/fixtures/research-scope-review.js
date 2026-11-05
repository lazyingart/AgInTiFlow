// Protocol-only offline approval fixture. This is deliberately not a semantic
// evaluator and is never imported by production code or exported as authority.
export function researchScopeApproval(envelope) {
  if (envelope.task !== "Assess research statements against retained source context.") return null;
  const input = envelope.input;
  return {
    schemaVersion: "aginti-research-scope-review-v1",
    requestDigest: input.requestDigest,
    decisions: input.statements.map(statement => {
      const evidence = input.evidence.find(item => statement.evidenceIds.includes(item.evidenceId));
      return {
        statementId: statement.statementId,
        verdict: evidence ? "supported" : "not_factual",
        reason: evidence ? "supported_in_source" : "not_factual",
        supportingQuotes: evidence ? [{ sourceId: evidence.sourceId, quote: evidence.quote }] : [],
      };
    }),
  };
}
