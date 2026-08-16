# =====================================================================================
# --- HERMES MISSION CONTROL - SCRIPT DE DÉPLOIEMENT DU DASHBOARD DE TEST ---
# =====================================================================================
# Fichier     : deploiement_dashboard_MC_teste.ps1
# Emplacement : D:\Piloubruce\Desktop\deploiement_dashboard_MC_teste.ps1
# Description : Automatise l'installation, la compilation et le déploiement
#               depuis le dossier temporaire vers le dossier du serveur frontend.
# =====================================================================================

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

# =====================================================================================
# --- SECTION DE CONFIGURATION ---
# =====================================================================================

# Dossier temporaire contenant les fichiers sources du projet
$LocalDeploymentRoot = "D:\Piloubruce\Desktop\hermes MC deployement"

# Dossier où se trouve votre serveur frontend de test (destination finale)
$TargetDir = "D:\Hermes MC teste"

# Répertoire de sortie de build généré par Vite
$BuildDir = "$LocalDeploymentRoot\dist"

# Adresse du backend Hermès sur votre VM (vers laquelle le proxy relaye les requêtes /api et /events)
$VmBackendUrl = "http://192.168.1.240:51763"

# Port d'écoute du frontend sur votre machine de test (192.168.1.10)
$ServerPort = 51763

# Option : Vider les anciens assets compilés dans le dossier de destination avant la copie
$CleanTargetBeforeDeploy = $true

# Option : Lancer automatiquement le serveur frontend à la fin du déploiement
$AutoStartServer = $true

# =====================================================================================
# --- FONCTIONS UTILITAIRES ---
# =====================================================================================

function Write-Log {
    param (
        [string]$Message,
        [string]$Level = "INFO"
    )
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    switch ($Level) {
        "INFO"    { Write-Host "[$Timestamp] [INFO]    $Message" -ForegroundColor White }
        "SUCCESS" { Write-Host "[$Timestamp] [SUCCESS] $Message" -ForegroundColor Green }
        "WARNING" { Write-Host "[$Timestamp] [WARNING] $Message" -ForegroundColor Yellow }
        "ERROR"   { Write-Host "[$Timestamp] [ERROR]   $Message" -ForegroundColor Red }
        "TITLE"   { Write-Host "`n=== $Message ===" -ForegroundColor Cyan }
        default   { Write-Host "[$Timestamp] [LOG]     $Message" -ForegroundColor Gray }
    }
}

# =====================================================================================
# --- SCRIPT PRINCIPAL ---
# =====================================================================================

$Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

Write-Log "DÉPLOIEMENT DU DASHBOARD HERMÈS MC (SERVEUR TEST)" "TITLE"
Write-Log "Répertoire source  : $LocalDeploymentRoot"
Write-Log "Répertoire serveur : $TargetDir"

# --- ÉTAPE 1 : VÉRIFICATION DES PRÉREQUIS ---
Write-Log "Vérification des prérequis système (Node.js et npm)..." "INFO"
try {
    $nodeVer = node -v
    $npmVer = npm -v
    Write-Log "Node.js détecté : $nodeVer" "INFO"
    Write-Log "npm détecté     : $npmVer" "INFO"
    Write-Log "Prérequis validés avec succès." "SUCCESS"
} catch {
    Write-Log "Node.js ou npm est introuvable. Assurez-vous qu'ils sont installés et configurés dans le PATH Windows." "ERROR"
    Exit 1
}

# --- ÉTAPE 2 : VÉRIFICATION DU RÉPERTOIRE SOURCE ---
Write-Log "Vérification du dossier source '$LocalDeploymentRoot'..." "INFO"
if (-not (Test-Path -LiteralPath $LocalDeploymentRoot)) {
    Write-Log "Le répertoire source '$LocalDeploymentRoot' n'existe pas !" "ERROR"
    Write-Log "Veuillez créer ce dossier et y déposer les sources du dashboard." "WARNING"
    Exit 1
}

try {
    Set-Location -LiteralPath $LocalDeploymentRoot
    Write-Log "Emplacement de travail actif : $(Get-Location)" "SUCCESS"
} catch {
    Write-Log "Impossible d'accéder au dossier source : $($_.Exception.Message)" "ERROR"
    Exit 1
}

# --- ÉTAPE 3 : INSTALLATION DES DÉPENDANCES NPM ---
Write-Log "Installation / Mise à jour des dépendances npm..." "INFO"
try {
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) {
        Write-Log "L'exécution de 'npm install' a échoué (Code: $LASTEXITCODE)." "ERROR"
        Exit 1
    }
    Write-Log "Dépendances npm vérifiées et installées." "SUCCESS"
} catch {
    Write-Log "Erreur lors de npm install : $($_.Exception.Message)" "ERROR"
    Exit 1
}

# --- ÉTAPE 4 : COMPILATION DU FRONTEND (VITE BUILD) ---
Write-Log "Compilation du dashboard React / Vite (npm run build)..." "INFO"
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        Write-Log "La compilation a échoué (Code: $LASTEXITCODE)." "ERROR"
        Exit 1
    }
    Write-Log "Compilation Vite réussie." "SUCCESS"
} catch {
    Write-Log "Erreur lors du build : $($_.Exception.Message)" "ERROR"
    Exit 1
}

# Vérification du fichier principal compilé
if (-not (Test-Path "$BuildDir\index.html")) {
    Write-Log "Le fichier '$BuildDir\index.html' n'a pas été généré lors du build !" "ERROR"
    Exit 1
}

# --- ÉTAPE 5 : PRÉPARATION DU RÉPERTOIRE DU SERVEUR DE TEST ---
Write-Log "Vérification du dossier cible du serveur : $TargetDir" "INFO"
if (-not (Test-Path -LiteralPath $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Write-Log "Dossier cible créé : $TargetDir" "SUCCESS"
}

# Sauvegarde de la version précédente
if ($CreateBackup -and (Test-Path "$TargetDir\index.html")) {
    $BackupDir = "$TargetDir\_backups"
    if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
    $DateStr = Get-Date -Format "yyyyMMdd_HHmmss"
    $CurrentBackup = "$BackupDir\backup_$DateStr"
    New-Item -ItemType Directory -Path $CurrentBackup -Force | Out-Null

    Get-ChildItem -Path $TargetDir -Exclude "_backups" | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $CurrentBackup -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Log "Sauvegarde de l'ancienne version créée dans : $CurrentBackup" "SUCCESS"
}

# Nettoyage des anciens fichiers web pour éviter le cumul d'anciens bundles JS/CSS hashés
# (On préserve express/python/scripts de serveur, .env, les dossiers de logs et data)
if ($CleanTargetBeforeDeploy) {
    Write-Log "Nettoyage des anciens assets dans '$TargetDir'..." "INFO"
    Get-ChildItem -Path $TargetDir -Exclude "_backups", "*.log", "data", "server.js", "server.cjs", "server.py", "start_server.bat", ".env", "node_modules" | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Log "Nettoyage terminé." "SUCCESS"
}

# --- ÉTAPE 6 : COPIE DES FICHIERS COMPILÉS VERS LE RÉPERTOIRE SERVEUR ---
Write-Log "Copie des nouveaux fichiers compilés vers '$TargetDir'..." "INFO"
try {
    Get-ChildItem -Path $BuildDir | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $TargetDir -Recurse -Force
    }
    Write-Log "Fichiers du dashboard copiés avec succès dans le dossier serveur !" "SUCCESS"
} catch {
    Write-Log "Erreur lors de la copie des fichiers : $($_.Exception.Message)" "ERROR"
    Exit 1
}

# Copie du fichier VERSION s'il existe
if (Test-Path "$LocalDeploymentRoot\VERSION") {
    Copy-Item -Path "$LocalDeploymentRoot\VERSION" -Destination $TargetDir -Force -ErrorAction SilentlyContinue
}

# Génération / Mise à jour automatique de server.cjs (Serveur Statique + Proxy VM)
$ServerScriptContent = @"
// Hermes Mission Control - Serveur Proxy Local & Serveur Statique
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = $ServerPort;
const HOST = '0.0.0.0';
const VM_TARGET_URL = process.env.HERMES_BACKEND_URL || '$VmBackendUrl';
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
  '.ttf': 'font/ttf'
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
      'x-forwarded-host': req.headers.host || 'localhost:' + PORT
    },
    rejectUnauthorized: false
  };

  const proxyReq = targetLib.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    headers['access-control-allow-origin'] = '*';
    headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS';
    headers['access-control-allow-headers'] = '*';

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[PROXY ERREUR] Impossible de joindre la VM (' + VM_TARGET_URL + ') :', err.message);
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

  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    return res.end('Interdit');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexPath = path.join(STATIC_DIR, 'index.html');
      fs.readFile(indexPath, (indexErr, indexData) => {
        if (indexErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('404 - Fichier index.html introuvable');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(indexData);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isAsset = filePath.includes(path.sep + 'assets' + path.sep);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache'
    });

    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }

  const parsedUrl = url.parse(req.url);
  const pathname = parsedUrl.pathname || '/';

  if (pathname.startsWith('/api') || pathname.startsWith('/events') || pathname.startsWith('/v1')) {
    return proxyRequest(req, res);
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log('===============================================================');
  console.log('  HERMES MISSION CONTROL - SERVEUR LOCAL TEST AVEC PROXY VM    ');
  console.log('===============================================================');
  console.log('  URL Locale   : http://localhost:' + PORT);
  console.log('  URL Reseau   : http://192.168.1.10:' + PORT);
  console.log('  Proxy API VM : ' + VM_TARGET_URL);
  console.log('===============================================================\n');
});
"@

[System.IO.File]::WriteAllText("$TargetDir\server.cjs", $ServerScriptContent, [System.Text.Encoding]::UTF8)
Write-Log "Serveur proxy local 'server.cjs' configuré vers $VmBackendUrl" "SUCCESS"

# --- ÉTAPE 7 : DÉMARRAGE AUTOMATIQUE DU SERVEUR FRONTEND ---
if ($AutoStartServer) {
    Write-Log "Démarrage du serveur Node.js avec Proxy VM (Port $ServerPort)..." "TITLE"
    
    # Lancement du serveur Node.js dans une invite de commande dédiée
    Start-Process -FilePath "cmd.exe" -ArgumentList "/k `"title Hermes MC Serveur Test (Port $ServerPort) & cd /d `"$TargetDir`" & node server.cjs`"" -WorkingDirectory $TargetDir

    Write-Log "Serveur démarré avec succès !" "SUCCESS"
    Write-Log "Ouverture du dashboard dans votre navigateur..." "INFO"
    Start-Sleep -Seconds 1
    Start-Process "http://localhost:$ServerPort"
}

# --- ÉTAPE 8 : RÉSUMÉ FINAL ---
$Stopwatch.Stop()
$Duration = [math]::Round($Stopwatch.Elapsed.TotalSeconds, 2)

Write-Host ""
Write-Host "=================================================================" -ForegroundColor Green
Write-Host "  DÉPLOIEMENT & DÉMARRAGE HERMÈS MC TERMINÉS AVEC SUCCÈS !       " -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Green
Write-Host "  Durée totale     : $Duration secondes" -ForegroundColor Gray
Write-Host "  Dossier serveur  : $TargetDir" -ForegroundColor Cyan
Write-Host "  Fichier index    : $TargetDir\index.html" -ForegroundColor Cyan
Write-Host "  URL locale       : http://localhost:$ServerPort" -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Green
Write-Host ""

Write-Log "Déploiement terminé. Cette fenêtre de mise à jour va se fermer..." "INFO"
Start-Sleep -Seconds 3
exit 0
