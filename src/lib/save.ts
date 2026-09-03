// Two ways to get edited floor data out of the browser and into the repo:
// 1) POST to the Vite dev-server middleware (vite.config.ts), which writes
//    straight into src/data/floors/*.json — only works while `npm run dev`
//    is running.
// 2) Fall back to a plain file download the user can drag over the old file
//    — always works, including against a production build.

export async function saveFloorToDisk(name: string, data: unknown): Promise<boolean> {
  try {
    const res = await fetch("/__save-floor-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, data }),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return !!json.ok;
  } catch {
    return false;
  }
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
