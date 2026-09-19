export function deploymentConfig(environment = process.env) {
  return {
    commit:
      environment.XAGT_COMMIT ??
      environment.VERCEL_GIT_COMMIT_SHA ??
      environment.RENDER_GIT_COMMIT ??
      "development",
    slug: environment.XAGT_SLUG ?? "elsemade-docket-resolve",
    allowedOrigin: environment.ALLOWED_ORIGIN ?? "*",
  };
}
