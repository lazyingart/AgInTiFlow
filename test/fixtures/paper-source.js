import { sanitizeIntegrationArtifact } from "../../src/integration-artifacts.js";
import {
  deriveIntegrationGroundedSearchDomainConstraint, planIntegrationGroundedSearchQuery,
  createIntegrationGroundedSearchArtifactAuthority, integrationGroundedSearchBoundArtifactId,
} from "../../src/integration-grounded-search.js";

export function paperSourceArtifact(input, sources = [{
  index: 1, title: "Synthetic source paper", url: "https://papers.example.org/paper.pdf",
  snippet: "Transport fixture, not a scientific publication.", providers: ["fixture"], kind: "paper",
  publishedDate: null, doi: null,
}]) {
  const constraint = deriveIntegrationGroundedSearchDomainConstraint(input.prompt);
  const plan = planIntegrationGroundedSearchQuery(input.prompt, input.search.mode, constraint);
  const authority = createIntegrationGroundedSearchArtifactAuthority({ query: plan.query, mode: input.search.mode,
    queryPlanDigest: plan.digest, domainConstraintDigest: constraint?.digest ?? null });
  const spec = { schemaVersion: "1", sources };
  return sanitizeIntegrationArtifact({ id: integrationGroundedSearchBoundArtifactId(spec, authority),
    title: "Grounded sources", kind: "sources", spec });
}
