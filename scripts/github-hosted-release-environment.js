const RELEASE_REPOSITORY = "lazyingart/AgInTiFlow";
const RELEASE_WORKFLOW = "Publish npm package";
const RELEASE_WORKFLOW_PATH = ".github/workflows/npm-publish.yml";
const RELEASE_TAG_PATTERN = /^v[^/\s]+$/u;

export function isPinnedGithubHostedReleaseEnvironment(environment = process.env) {
  const tag = String(environment.GITHUB_REF_NAME || "");
  const ref = `refs/tags/${tag}`;
  return (
    environment.AGINTIFLOW_GITHUB_HOSTED_BWRAP_NAMESPACE_RESTRICTION === "allow-sigkill" &&
    environment.AGINTIFLOW_GITHUB_RUNNER_ENVIRONMENT === "github-hosted" &&
    environment.GITHUB_ACTIONS === "true" &&
    environment.GITHUB_EVENT_NAME === "push" &&
    environment.GITHUB_REPOSITORY === RELEASE_REPOSITORY &&
    environment.GITHUB_REF_TYPE === "tag" &&
    environment.GITHUB_REF === ref &&
    environment.GITHUB_WORKFLOW === RELEASE_WORKFLOW &&
    environment.GITHUB_WORKFLOW_REF === `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW_PATH}@${ref}` &&
    environment.RUNNER_OS === "Linux" &&
    RELEASE_TAG_PATTERN.test(tag)
  );
}
