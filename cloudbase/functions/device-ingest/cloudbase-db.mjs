import cloudbase from "@cloudbase/node-sdk";
import { createTelemetryRepository } from "./telemetry-repository.mjs";

export function createCloudBaseRepositoryFromEnv(env = process.env) {
  // CloudBase functions receive credentials for their own environment, so no
  // long-lived API key is required. Explicit credentials remain supported for
  // local/server deployments outside CloudBase.
  const options = {};
  if (env.CLOUDBASE_ENV_ID) options.env = env.CLOUDBASE_ENV_ID;
  if (env.CLOUDBASE_APIKEY) options.accessKey = env.CLOUDBASE_APIKEY;

  const app = cloudbase.init(options);
  return createTelemetryRepository(app.database());
}
