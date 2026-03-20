import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 4173);

// ─── MIME TYPES ───────────────────────────────────────────────────────────────
// Invariato rispetto all'originale + aggiunte per HLS/streaming
const mimeTypes = {
  ".css":   "text/css; charset=utf-8",
  ".gif":   "image/gif",
  ".html":  "text/html; charset=utf-8",
  ".js":    "application/javascript; charset=utf-8",
  ".json":  "application/json; charset=utf-8",
  ".m3u8":  "application/vnd.apple.mpegurl",
  ".mp4":   "video/mp4",
  ".png":   "image/png",
  ".jpg":   "image/jpeg",
  ".jpeg":  "image/jpeg",
  ".svg":   "image/svg+xml",
  ".txt":   "text/plain; charset=utf-8",
  ".webp":  "image/webp",
  ".woff":  "font/woff",
  ".woff2": "font/woff2",
  ".xml":   "application/xml; charset=utf-8",
  // Aggiunte per streaming
  ".ts":    "video/mp2t",
  ".mp2t":  "video/mp2t",
  ".m3u":   "application/vnd.apple.mpegurl",
  ".key":   "application/octet-stream",
  ".vtt":   "text/vtt; charset=utf-8",
  ".srt":   "text/plain; charset=utf-8",
  ".aac":   "audio/aac",
  ".ac3":   "audio/ac3",
};

// ─── CORS HEADERS ─────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":   "*",
  "Access-Control-Allow-Methods":  "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":  "Origin, X-Requested-With, Content-Type, Accept, Range, Authorization",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges",
};

// ─── FUNZIONI ORIGINALI (invariate) ───────────────────────────────────────────
function getContentType(filePath) {
  return mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function getLanUrls() {
  const interfaces = os.networkInterfaces();
  const urls = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      urls.push(`http://${entry.address}:${port}/`);
    }
  }
  return Array.from(new Set(urls)).sort();
}

function resolveRequestPath(urlPathname) {
  let pathname = decodeURIComponent(String(urlPathname || "/"));
  if (pathname === "/") {
    pathname = "/index.html";
  }
  const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  return path.join(rootDir, normalized);
}

// ─── FUNZIONI PROXY (nuove) ───────────────────────────────────────────────────

/**
 * Determina se una risposta upstream è un manifest HLS/m3u8,
 * basandosi sia sul Content-Type che sull'estensione dell'URL.
 */
function isM3u8Response(contentType, targetUrl) {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("mpegurl") || ct.includes("x-mpegurl")) return true;
  }
  const pathname = targetUrl.pathname.toLowerCase();
  return pathname.endsWith(".m3u8") || pathname.endsWith(".m3u");
}

/**
 * Costruisce l'URL del proxy locale per una risorsa esterna.
 * Es: http://localhost:4173/proxy?url=https%3A%2F%2F...
 */
function buildProxyUrl(absoluteTargetUrl, baseServerUrl) {
  return `${baseServerUrl}/proxy?url=${encodeURIComponent(absoluteTargetUrl)}`;
}

/**
 * Risolve un URL relativo in assoluto rispetto al base del manifest.
 */
function resolveSegmentUrl(relative, manifestBaseUrl) {
  try {
    return new URL(relative, manifestBaseUrl).href;
  } catch {
    return relative;
  }
}

/**
 * Riscrive un manifest m3u8 sostituendo tutti gli URL (assoluti e relativi)
 * con URL puntanti al proxy locale. Gestisce:
 *  - segmenti .ts / .aac / .mp4 / fmp4
 *  - #EXT-X-KEY URI="..."         (chiavi di cifratura AES-128)
 *  - #EXT-X-MAP URI="..."         (initialization segment fMP4)
 *  - #EXT-X-MEDIA URI="..."       (audio/subtitle alternate tracks)
 *  - playlist varianti (master m3u8 con righe URL di sotto-playlist)
 */
function rewriteM3u8(content, originalUrl, baseServerUrl) {
  // Base URL = tutto tranne il filename finale del manifest
  const manifestBaseUrl = originalUrl.substring(0, originalUrl.lastIndexOf("/") + 1);

  const lines = content.split("\n");

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();

    // Riga vuota → lascia invariata
    if (!trimmed) return line;

    // Tag con attributo URI="..." → riscriviamo solo i valori URI
    if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
      return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
        const absolute = resolveSegmentUrl(uri, manifestBaseUrl);
        return `URI="${buildProxyUrl(absolute, baseServerUrl)}"`;
      });
    }

    // Commento generico senza URI → lascia invariato
    if (trimmed.startsWith("#")) return line;

    // Riga dati: può essere un URL assoluto o relativo (segmento o sotto-playlist)
    const absolute = resolveSegmentUrl(trimmed, manifestBaseUrl);
    return buildProxyUrl(absolute, baseServerUrl);
  });

  return rewritten.join("\n");
}

/**
 * Gestisce le richieste verso /proxy?url=<encoded_url>
 * Supporta:
 *  - manifest m3u8 (con riscrittura URL)
 *  - segmenti .ts, chiavi HLS, init segments fMP4
 *  - Range requests per seeking progressivo
 *  - HEAD requests
 *  - Redirect automatici (follow)
 */
async function handleProxy(request, response, requestUrl, baseServerUrl) {
  const targetParam = requestUrl.searchParams.get("url");

  if (!targetParam) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS });
    response.end("Missing required 'url' query parameter");
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetParam);
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
      throw new Error("Only http/https protocols are allowed");
    }
  } catch (err) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS });
    response.end(`Invalid URL: ${err.message}`);
    return;
  }

  // Header da NON inoltrare all'upstream (potrebbero causare problemi)
  const SKIP_UPSTREAM_HEADERS = new Set([
    "host", "origin", "referer", "connection",
    "te", "trailers", "upgrade", "keep-alive",
    "proxy-authorization", "proxy-connection",
  ]);

  // Costruisce gli header da inviare all'upstream
  const upstreamHeaders = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!SKIP_UPSTREAM_HEADERS.has(key.toLowerCase())) {
      upstreamHeaders[key] = value;
    }
  }

  // User-Agent di fallback per evitare blocchi da parte di alcuni CDN
  if (!upstreamHeaders["user-agent"]) {
    upstreamHeaders["User-Agent"] = "Mozilla/5.0 (compatible; StreamProxy/1.0)";
  }

  // Header da propagare all'upstream se presenti nella request originale
  if (request.headers["range"]) {
    upstreamHeaders["Range"] = request.headers["range"];
  }
  if (request.headers["accept"]) {
    upstreamHeaders["Accept"] = request.headers["accept"];
  }

  try {
    const upstreamResponse = await fetch(targetUrl.href, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: upstreamHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(30_000), // timeout 30 secondi
    });

    const upstreamContentType = upstreamResponse.headers.get("content-type") || "";

    // Costruisce gli header della risposta verso il client
    const responseHeaders = {
      ...CORS_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": upstreamContentType || "application/octet-stream",
    };

    // Propaga header importanti per lo streaming e il seeking
    const PROPAGATE_HEADERS = [
      "content-length",
      "content-range",
      "accept-ranges",
      "last-modified",
      "etag",
    ];
    for (const headerName of PROPAGATE_HEADERS) {
      const val = upstreamResponse.headers.get(headerName);
      if (val) {
        // Converti in Title-Case (es: content-length → Content-Length)
        const titleCase = headerName
          .split("-")
          .map((w) => w[0].toUpperCase() + w.slice(1))
          .join("-");
        responseHeaders[titleCase] = val;
      }
    }

    // ── Manifest m3u8: riscrittura URL e risposta testuale ──
    if (isM3u8Response(upstreamContentType, targetUrl)) {
      const manifestText = await upstreamResponse.text();
      const rewritten = rewriteM3u8(manifestText, targetUrl.href, baseServerUrl);
      const rewrittenBuffer = Buffer.from(rewritten, "utf-8");

      responseHeaders["Content-Type"]   = "application/vnd.apple.mpegurl; charset=utf-8";
      responseHeaders["Content-Length"] = String(rewrittenBuffer.byteLength);

      response.writeHead(upstreamResponse.status, responseHeaders);
      response.end(rewritten);
      return;
    }

    // ── Tutto il resto: stream binario diretto ──
    response.writeHead(upstreamResponse.status, responseHeaders);

    if (request.method === "HEAD" || !upstreamResponse.body) {
      response.end();
      return;
    }

    // Legge lo stream upstream e lo riversa sul client chunk per chunk
    const reader = upstreamResponse.body.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            response.end();
            break;
          }
          // response.write ritorna false se il buffer è pieno → aspettiamo drain
          const canContinue = response.write(value);
          if (!canContinue) {
            await new Promise((resolve) => response.once("drain", resolve));
          }
        }
      } catch (streamErr) {
        // Il client ha chiuso la connessione prima della fine → normale durante lo zapping
        if (!response.writableEnded) {
          response.end();
        }
      }
    };
    pump();

  } catch (fetchError) {
    if (!response.headersSent) {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS });
      response.end(`Proxy fetch error: ${fetchError?.message || fetchError}`);
    }
  }
}

// ─── SERVER HTTP ──────────────────────────────────────────────────────────────
const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`
    );

    // ── Preflight CORS (OPTIONS) ──
    // Alcuni player/browser inviano OPTIONS prima della richiesta reale
    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS_HEADERS);
      response.end();
      return;
    }

    // ── Endpoint proxy ──
    if (requestUrl.pathname === "/proxy") {
      // Costruisce il base URL del server (es: http://localhost:4173)
      // usato per riscrivere gli URL nel manifest m3u8
      const serverBase = `https://${request.headers.host || `localhost:${port}`}`;
      await handleProxy(request, response, requestUrl, serverBase);
      return;
    }

    // ── Servizio file statici (logica originale invariata) ──
    let filePath = resolveRequestPath(requestUrl.pathname);
    let fileStat = await stat(filePath).catch(() => null);

    if (fileStat?.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      fileStat = await stat(filePath).catch(() => null);
    }

    if (!fileStat?.isFile()) {
      response.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        ...CORS_HEADERS,
      });
      response.end("Not found");
      return;
    }

    const fileContents = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": getContentType(filePath),
      ...CORS_HEADERS,
    });
    response.end(fileContents);

  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
        ...CORS_HEADERS,
      });
      response.end(`Server error: ${error?.message || error}`);
    }
  }
});

server.listen(port, host, () => {
  const localHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`Serving Nuvio TV from ${rootDir}`);
  console.log(`Local URL:  http://${localHost}:${port}/`);
  for (const lanUrl of getLanUrls()) {
    console.log(`LAN URL:    ${lanUrl}`);
  }
  console.log("Proxy endpoint: /proxy?url=<encoded_url>");
  console.log("Use one of the URLs above if you want to test the app over http(s) during development.");
});