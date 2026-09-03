import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Dev-only: lets the in-app "Edit map" mode save straight back into the
// tracked JSON files under src/data/floors, instead of only living in
// browser state. Never runs against a production build.
function saveFloorDataPlugin(): Plugin {
  const floorsDir = path.resolve(import.meta.dirname, "src/data/floors");
  const allowed = new Set(["main", "lower", "upper", "stairs"]);

  return {
    name: "save-floor-data",
    configureServer(server) {
      server.middlewares.use("/__save-floor-data", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("POST only");
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const { name, data } = JSON.parse(body);
            if (typeof name !== "string" || !allowed.has(name)) {
              throw new Error(`refusing to write unknown file "${name}"`);
            }
            const filePath = path.join(floorsDir, `${name}.json`);
            fs.writeFileSync(filePath, JSON.stringify(data, null, 1) + "\n");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, file: `${name}.json` }));
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        });
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), saveFloorDataPlugin()],
});
