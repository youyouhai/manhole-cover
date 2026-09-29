import { createWebApiServer } from "./app.mjs";

const port = Number(process.env.PORT || 9000);
createWebApiServer().listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "web-api.started", port }));
});
