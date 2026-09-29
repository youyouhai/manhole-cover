import { createDeviceIngestServer } from "./app.mjs";
import { createCloudBaseRepositoryFromEnv } from "./cloudbase-db.mjs";

const port = Number(process.env.PORT || 9000);
const repository = createCloudBaseRepositoryFromEnv();
const server = createDeviceIngestServer({ repository });

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({
    event: "server.started",
    port,
    tokenConfigurationPresent: Boolean(
      process.env.DEVICE_TOKEN_MH001 || process.env.DEVICE_TOKENS_JSON,
    ),
    databasePersistenceEnabled: Boolean(repository),
  }));
});
