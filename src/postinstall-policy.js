function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

export function shouldStartPostinstallWebApp(env = process.env) {
  if (truthy(env.AGINTIFLOW_SKIP_POSTINSTALL_WEBAPP) || truthy(env.CI)) return false;
  if (truthy(env.AGINTIFLOW_POSTINSTALL_WEBAPP)) return true;
  return truthy(env.npm_config_global) || String(env.npm_config_location || "").trim().toLowerCase() === "global";
}
