const http = require("http");
const fs = require("fs");
const path = require("path");

const contentDir = process.argv[2] || ".";
const PORT = parseInt(process.argv[3] || "54321", 10);

const mimeTypes = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  let files;
  try {
    files = fs.readdirSync(contentDir).filter((f) => f.endsWith(".html"));
  } catch {
    res.writeHead(500);
    res.end("Cannot read content dir");
    return;
  }

  if (files.length === 0) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>No mockup files found</h2><p>Waiting for content...</p>");
    return;
  }

  files.sort((a, b) => {
    const sa = fs.statSync(path.join(contentDir, a)).mtimeMs;
    const sb = fs.statSync(path.join(contentDir, b)).mtimeMs;
    return sb - sa;
  });

  const latest = files[0];
  const filePath = path.join(contentDir, latest);

  if (req.url === "/" || req.url === "") {
    res.writeHead(302, { Location: "/" + latest });
    res.end();
    return;
  }

  const resolved = path.resolve(contentDir, "." + req.url);
  if (!resolved.startsWith(path.resolve(contentDir))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(resolved)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(resolved);
  const contentType = mimeTypes[ext] || "application/octet-stream";
  const content = fs.readFileSync(resolved);
  res.writeHead(200, { "Content-Type": contentType + "; charset=utf-8" });
  res.end(content);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Static server running at http://localhost:${PORT}`);
  console.log(`Serving files from: ${path.resolve(contentDir)}`);
});
