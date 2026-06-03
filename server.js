const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const PORT = 3000;
const USER_AGENT = 'Mozilla/5.0 (m3u-iptv 2.3.7) Samsung';
const PROXY_TIMEOUT_MS = 30000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host}`);

  if (urlObj.pathname === '/proxy') {
    const targetUrl = urlObj.searchParams.get('url');

    // Reject anything that isn't an absolute http/https URL
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      console.error(`[proxy] Rejected bad target: ${targetUrl}`);
      res.writeHead(400);
      res.end('url parameter must be an absolute http/https URL');
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

    try {
      const headers = { 'User-Agent': USER_AGENT };
      if (req.headers['range']) headers['Range'] = req.headers['range'];

      const response = await fetch(targetUrl, {
        headers,
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timeout);

      if (!response.ok && response.status !== 206) {
        res.writeHead(response.status);
        res.end(`Upstream error: ${response.status} ${response.statusText}`);
        return;
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      
      // We must explicitly tell the browser NOT to cache proxy responses, 
      // otherwise HLS.js will keep loading the same cached .m3u8 playlist 
      // and the video will loop infinitely!
      const outHeaders = { 
        'Content-Type': contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      };
      
      const contentLength = response.headers.get('content-length');
      const contentRange = response.headers.get('content-range');
      if (contentLength) outHeaders['Content-Length'] = contentLength;
      if (contentRange) {
        outHeaders['Content-Range'] = contentRange;
        outHeaders['Accept-Ranges'] = 'bytes';
      }

      res.writeHead(response.status, outHeaders);

      if (response.body) {
        const bodyStream = Readable.fromWeb(response.body);

        // Idle timeout: if no bytes arrive for 10 s, the upstream is hanging — abort.
        // Reset the timer on each data chunk so slow-but-active streams are not killed.
        let idleTimer = null;
        const IDLE_MS = 10000;

        const resetIdle = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            console.warn(`[proxy] Body idle timeout: ${targetUrl.slice(0, 100)}`);
            bodyStream.destroy();
            if (!res.destroyed) res.destroy();
          }, IDLE_MS);
        };

        resetIdle();                                       // start the first tick
        bodyStream.on('data', resetIdle);                  // reset on each chunk
        bodyStream.on('close', () => clearTimeout(idleTimer));
        bodyStream.on('error', () => {
          clearTimeout(idleTimer);
          if (!res.destroyed) res.destroy();
        });

        bodyStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        console.error(`[proxy] Timeout: ${targetUrl}`);
        if (!res.headersSent) { res.writeHead(504); res.end('Gateway Timeout'); }
      } else {
        console.error(`[proxy] Error: ${err.message}`);
        if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
      }
    }
    return;
  }

  // Static files
  const filePath = path.join(
    __dirname, 'public',
    urlObj.pathname === '/' ? 'index.html' : urlObj.pathname
  );
  const contentType = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? '404 Not Found' : `Server Error: ${err.code}`);
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`StreamVibe running on port ${PORT} (accessible via VM IP)`);
});
