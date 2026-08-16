// =====================================================================================
// Hermes Mission Control - Serveur Proxy Local & Serveur Statique (Test PC)
// Fichier : server.cjs
// Port : 51763 (0.0.0.0) -> Proxy transparent vers VM (192.168.1.240:51763)
// Zero dependance externe requise (utilise les modules natifs Node.js)
// =====================================================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 51763;
const HOST = '0.0.0.0';
const VM_TARGET_URL = process.env.HERMES_BACKEND_URL || 'http://192.168.1.240:51763';
const STATIC_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json'
};

const parsedTarget = url.parse(VM_TARGET_URL);
const isHttpsTarget = parsedTarget.protocol === 'https:';
const targetLib = isHttpsTarget ? https : http;

function proxyRequest(req, res) {
  const options = {
    hostname: parsedTarget.hostname,
    port: parsedTarget.port || (isHttpsTarget ? 443 : 80),
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: parsedTarget.host,
      'x-forwarded-for': req.socket.remoteAddress,
      'x-forwarded-proto': 'http',
      'x-forwarded-host': req.headers.host || `localhost:${PORT}`
    },
    rejectUnauthorized: false
  };

  const proxyReq = targetLib.request(options, (proxyRes) => {
    // Injecter les en-tetes CORS au cas ou
    const headers = { ...proxyRes.headers };
    headers['access-control-allow-origin'] = '*';
    headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS';
    headers['access-control-allow-headers'] = '*';

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[PROXY ERREUR] Impossible de joindre la VM (${VM_TARGET_URL}) :`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: 'Échec de la connexion à la VM Hermès',
        target: VM_TARGET_URL,
        details: err.message
      }));
    }
  });

  req.pipe(proxyReq);
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(STATIC_DIR, pathname === '/' ? 'index.html' : pathname);
  filePath = path.normalize(filePath);

  // Securite : empecher la sortie du dossier racine
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    return res.end('Interdit');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA Fallback : si le fichier direct n'existe pas, servir index.html
      const indexPath = path.join(STATIC_DIR, 'index.html');
      fs.readFile(indexPath, (indexErr, indexData) => {
        if (indexErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('404 - Fichier index.html introuvable dans ' + STATIC_DIR);
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.end(indexData);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isAsset = filePath.includes(path.sep + 'assets' + path.sep);
    const cacheControl = isAsset ? 'public, max-age=31536000, immutable' : 'no-cache';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': cacheControl
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  // Reponse preflight OPTIONS pour CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  const parsedUrl = url.parse(req.url);
  const pathname = parsedUrl.pathname || '/';

  // Relayer les appels API et Evenements directement vers la VM
  if (pathname.startsWith('/api') || pathname.startsWith('/events') || pathname.startsWith('/v1')) {
    return proxyRequest(req, res);
  }

  // Distribuer les fichiers statiques du dashboard
  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log('===============================================================');
  console.log(`  HERMES MISSION CONTROL - SERVEUR LOCAL TEST AVEC PROXY VM    `);
  console.log('===============================================================');
  console.log(`  URL Locale        : http://localhost:${PORT}`);
  console.log(`  URL Reseau        : http://192.168.1.10:${PORT}`);
  console.log(`  Proxy API VM      : ${VM_TARGET_URL}`);
  console.log(`  Dossier statique  : ${STATIC_DIR}`);
  console.log('===============================================================');
  console.log('  Pret a recevoir les requetes. Laissez cette fenetre ouverte.\n');
});
