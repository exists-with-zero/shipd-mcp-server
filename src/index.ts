import { loadConfig } from "./config.js";
import { createApp } from "./http.js";

const config = loadConfig();
const app = createApp(config);

app.listen(config.port, config.host, (err?: Error) => {
  if (err) {
    console.error("Shipd MCP server failed to start:", err.message);
    process.exit(1);
  }
  console.log(`Shipd MCP server on http://${config.host}:${config.port}/mcp (Shipd API ${config.apiUrl})`);
});
