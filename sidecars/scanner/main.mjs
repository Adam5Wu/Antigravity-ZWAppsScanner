/**
 * Antigravity Sidecar Backend for ZW Appliances (`esp-zw-app-scanner/scanner`).
 *
 * Hosts the Auxiliary Side Pane UI and exposes local loopback endpoints for:
 *   - GET  /api/state           (ETag-gated snapshot of scan config, sort rules, progress, identities/nicknames, and devices)
 *   - POST /api/config          (Update persisted scan range { prefix, start, end })
 *   - POST /api/sort            (Update persisted cascading sort rules { sortRules })
 *   - POST /api/scan            (Trigger on-demand async subnet/range scan)
 *   - POST /api/refresh         (Re-probe all currently known/listed device entries)
 *   - POST /api/nickname        (Save/clear local nickname; MAC-indexed on v1.1.11+ devices)
 *   - POST /api/location        (Update on-device location via /!sys/config?section=identity on v1.1.11+ devices)
 *   - POST /api/reboot/prepare  (Fetch fresh /!sys/boot_serial to arm confirmation)
 *   - POST /api/reboot/execute  (Trigger /!sys/reboot?bs=... and track reboot completion)
 *   - POST /api/open            (Open http://<ip>/ or /config/ in the default system browser)
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  buildTargetIps,
  compareIps,
  detectDefaultScanConfig,
  isValidIpv4,
  isValidMac,
  normalizeScanConfig,
  normalizeSortRules,
  parseRangeExpression,
  prepareReboot,
  probeAppliance,
  scanIps,
  sortDevices,
  triggerReboot,
  updateApplianceLocation,
  validateLocation,
  waitForRebootCompletion,
} from './scanner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOT_ASSET_VERSION = Date.now().toString(36);

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const ARM_TTL_MS = 1500;
const ARM_SERVER_GRACE_MS = 1000;

const STANDARD_AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 minutes
const OFFLINE_INITIAL_INTERVAL_MS = 7 * 1000;   // 7 seconds
const OFFLINE_STEP_WINDOW_MS = 60 * 1000;       // double every 1 minute
const OFFLINE_MAX_INTERVAL_MS = STANDARD_AUTO_REFRESH_MS / 2; // 150 seconds

function resolveDataDir() {
  if (process.env.ZWAPPS_SCANNER_DATA_DIR) {
    return process.env.ZWAPPS_SCANNER_DATA_DIR;
  }
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  return join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'esp-zw-app-scanner', 'scanner', 'data');
}

const DATA_DIR = resolveDataDir();
const STATE_FILE = join(DATA_DIR, 'state.json');

function loadPersistedState() {
  const initialScanConfig = detectDefaultScanConfig();
  const fallback = {
    version: 2,
    scanConfig: { ...initialScanConfig },
    sortRules: normalizeSortRules(),
    lastScanAt: null,
    lastScanDurationMs: null,
    nicknames: {},
    macNicknames: {},
    knownDevices: {},
    lastScanIps: [],
  };
  try {
    if (!existsSync(STATE_FILE)) return fallback;
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    const scanConfig = normalizeScanConfig(raw?.scanConfig || initialScanConfig);
    const sortRules = normalizeSortRules(raw?.sortRules);
    const nicknames = {};
    if (raw?.nicknames && typeof raw.nicknames === 'object') {
      for (const [ip, name] of Object.entries(raw.nicknames)) {
        if (isValidIpv4(ip) && typeof name === 'string' && name.trim()) {
          nicknames[ip] = name.trim().slice(0, 64);
        }
      }
    }
    const macNicknames = {};
    if (raw?.macNicknames && typeof raw.macNicknames === 'object') {
      for (const [mac, name] of Object.entries(raw.macNicknames)) {
        const normMac = String(mac || '').trim().toUpperCase();
        if (isValidMac(normMac) && typeof name === 'string' && name.trim()) {
          macNicknames[normMac] = name.trim().slice(0, 64);
        }
      }
    }
    const knownDevices = {};
    if (raw?.knownDevices && typeof raw.knownDevices === 'object') {
      for (const [ip, dev] of Object.entries(raw.knownDevices)) {
        if (isValidIpv4(ip) && dev && typeof dev === 'object') {
          const { nextBootPending, nextProject, nextVersion, ...restDev } = dev;
          knownDevices[ip] = {
            ...restDev,
            ip,
            mac: isValidMac(dev.mac) ? String(dev.mac).trim().toUpperCase() : '',
            supportsDiscover: Boolean(dev.supportsDiscover),
            hostname: typeof dev.hostname === 'string' ? dev.hostname : '',
            location: typeof dev.location === 'string' ? dev.location : '',
          };
        }
      }
    }
    const lastScanIps = Array.isArray(raw?.lastScanIps)
      ? raw.lastScanIps.filter((ip) => isValidIpv4(ip))
      : Object.keys(knownDevices).filter((ip) => knownDevices[ip]?.online);

    return {
      version: 2,
      scanConfig,
      sortRules,
      lastScanAt: typeof raw?.lastScanAt === 'string' ? raw.lastScanAt : null,
      lastScanDurationMs: typeof raw?.lastScanDurationMs === 'number' ? raw.lastScanDurationMs : null,
      nicknames,
      macNicknames,
      knownDevices,
      lastScanIps,
    };
  } catch (err) {
    console.error('[zw_scanner] Failed to load state.json, starting fresh:', err.message);
    return fallback;
  }
}

const persisted = loadPersistedState();
let stateRevision = 1;

function bumpRevision() {
  stateRevision++;
}

function savePersistedState() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(persisted, null, 2), 'utf-8');
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('[zw_scanner] Failed to persist state.json:', err.message);
  }
}

function shouldRetainOfflineDevice(ip, dev) {
  if (persisted.nicknames[ip]) return true;
  if (dev?.mac && persisted.macNicknames[dev.mac]) return true;
  if (dev?.location) return true;
  return false;
}

/**
 * Upserts a probed appliance into `persisted.knownDevices`, reconciling by
 * hardware MAC address across DHCP IP changes on upgraded devices.
 */
function upsertKnownDevice(dev) {
  let prevEntry = persisted.knownDevices[dev.ip] || null;

  if (dev.mac) {
    for (const [existingIp, existingDev] of Object.entries(persisted.knownDevices)) {
      if (existingDev?.mac === dev.mac) {
        if (!prevEntry) prevEntry = existingDev;
        if (existingIp !== dev.ip) {
          stopOfflineWatcher(existingIp);
          delete persisted.knownDevices[existingIp];
          persisted.lastScanIps = persisted.lastScanIps.filter((x) => x !== existingIp);
          if (persisted.nicknames[existingIp] && !persisted.nicknames[dev.ip]) {
            persisted.nicknames[dev.ip] = persisted.nicknames[existingIp];
          }
          delete persisted.nicknames[existingIp];
        }
      }
    }
    if (persisted.macNicknames[dev.mac] && !persisted.nicknames[dev.ip]) {
      persisted.nicknames[dev.ip] = persisted.macNicknames[dev.mac];
    } else if (persisted.nicknames[dev.ip] && !persisted.macNicknames[dev.mac]) {
      persisted.macNicknames[dev.mac] = persisted.nicknames[dev.ip];
    }
  }

  if (dev.online) {
    stopOfflineWatcher(dev.ip);
  }
  rebootErrors.delete(dev.ip);
  persisted.knownDevices[dev.ip] = {
    ...(prevEntry || {}),
    ...dev,
  };
}

// Runtime transient states
let activeScan = {
  running: false,
  mode: 'scan',
  id: 0,
  scanned: 0,
  total: 0,
  foundCount: 0,
  startedAt: null,
  error: null,
};

// ip -> { bootSerial, expiresAt }
const armedReboots = new Map();

// ip -> { status: 'rebooting', previousBootSerial, startedAt }
const activeReboots = new Map();

// ip -> { id, message } for async reboot completion failures
const rebootErrors = new Map();
let rebootErrorSeq = 0;

// ip -> Promise for coalescing single-device background refreshes
const perIpRefreshInFlight = new Map();

// ip -> { offlineSince: number, timerId: ReturnType<typeof setTimeout> | null }
const offlineWatchers = new Map();

// Periodic 5-minute background refresh timer for all existing entries
let standardRefreshTimer = null;
let lastRefreshCompletedAt = 0;

// Track IPs found so far in an in-progress scan
let liveScanFoundIps = new Set();

function stopOfflineWatcher(ip) {
  const watcher = offlineWatchers.get(ip);
  if (!watcher) return;
  if (watcher.timerId) clearTimeout(watcher.timerId);
  offlineWatchers.delete(ip);
}

function scheduleNextOfflineTick(ip) {
  const watcher = offlineWatchers.get(ip);
  if (!watcher) return;

  const known = persisted.knownDevices[ip];
  const isStillListed = Boolean(
    persisted.lastScanIps.includes(ip) ||
      persisted.nicknames[ip] ||
      (known && shouldRetainOfflineDevice(ip, known))
  );
  if (!known || known.online || !isStillListed) {
    stopOfflineWatcher(ip);
    return;
  }

  const elapsedMs = Math.max(0, Date.now() - watcher.offlineSince);
  const minuteSteps = Math.floor(elapsedMs / OFFLINE_STEP_WINDOW_MS);
  const intervalMs = OFFLINE_INITIAL_INTERVAL_MS * (2 ** minuteSteps);

  if (intervalMs > OFFLINE_MAX_INTERVAL_MS) {
    // Exceeded half of the 5-minute standard auto-refresh interval -> hand off to standard refresh
    stopOfflineWatcher(ip);
    return;
  }

  watcher.timerId = setTimeout(async () => {
    watcher.timerId = null;
    if (!offlineWatchers.has(ip)) return;
    await refreshSingleDevice(ip);
    if (offlineWatchers.has(ip)) {
      scheduleNextOfflineTick(ip);
    }
  }, intervalMs);
  if (typeof watcher.timerId?.unref === 'function') {
    watcher.timerId.unref();
  }
}

function startOfflineWatcher(ip) {
  stopOfflineWatcher(ip);
  offlineWatchers.set(ip, {
    offlineSince: Date.now(),
    timerId: null,
  });
  scheduleNextOfflineTick(ip);
}

function markDeviceOffline(ip) {
  const existing = persisted.knownDevices[ip];
  if (!existing) return;
  const wasOnline = Boolean(existing.online);
  persisted.knownDevices[ip] = {
    ...existing,
    online: false,
  };
  if (wasOnline) {
    startOfflineWatcher(ip);
  }
}

function scheduleStandardAutoRefresh() {
  if (standardRefreshTimer) {
    clearTimeout(standardRefreshTimer);
  }
  standardRefreshTimer = setTimeout(() => {
    standardRefreshTimer = null;
    if (!activeScan.running && buildDeviceList().length > 0) {
      startBackgroundRefresh();
    } else {
      scheduleStandardAutoRefresh();
    }
  }, STANDARD_AUTO_REFRESH_MS);
  if (typeof standardRefreshTimer?.unref === 'function') {
    standardRefreshTimer.unref();
  }
}

function buildDeviceList() {
  const ips = new Set();

  // 1. All devices discovered in the most recent completed scan (or current live scan)
  for (const ip of persisted.lastScanIps) {
    ips.add(ip);
  }
  for (const ip of liveScanFoundIps) {
    ips.add(ip);
  }
  // 2. All IPs with saved nicknames or configured on-device identity (retained even when offline)
  for (const ip of Object.keys(persisted.nicknames)) {
    ips.add(ip);
  }
  for (const [ip, dev] of Object.entries(persisted.knownDevices)) {
    if (dev?.online || shouldRetainOfflineDevice(ip, dev)) {
      ips.add(ip);
    }
  }
  // 3. Any IP currently rebooting
  for (const ip of activeReboots.keys()) {
    ips.add(ip);
  }

  const entries = [...ips].map((ip) => {
    const known = persisted.knownDevices[ip] || {};
    const nickname = persisted.nicknames[ip] || (known.mac ? persisted.macNicknames[known.mac] || '' : '');
    const reb = activeReboots.get(ip);

    let status = known.online ? 'online' : 'offline';
    if (reb?.status === 'rebooting') {
      status = 'rebooting';
    }

    return {
      ip,
      nickname,
      supportsDiscover: Boolean(known.supportsDiscover),
      mac: known.mac || '',
      hostname: known.hostname || '',
      location: known.location || '',
      status,
      online: Boolean(known.online) && status !== 'rebooting',
      project: known.project || '',
      version: known.version || '',
      buildTime: known.buildTime || '',
      runningSlot: typeof known.runningSlot === 'number' ? known.runningSlot : null,
      bootSerial: known.bootSerial || '',
      latencyMs: typeof known.latencyMs === 'number' ? known.latencyMs : null,
      lastSeenAt: known.lastSeenAt || null,
      rebootError: rebootErrors.get(ip) || null,
      url: `http://${ip}/`,
    };
  });

  return sortDevices(entries, persisted.sortRules);
}

function getEtag() {
  return `v${stateRevision}:${activeScan.running ? `${activeScan.scanned}/${activeScan.total}` : 'idle'}`;
}

function startBackgroundScan(configInput) {
  if (activeScan.running) {
    return { started: false, alreadyRunning: true, scanConfig: persisted.scanConfig };
  }

  let cfg;
  if (typeof configInput?.range === 'string' && configInput.range.trim()) {
    cfg = parseRangeExpression(configInput.range);
  } else {
    cfg = normalizeScanConfig({
      prefix: configInput?.prefix ?? persisted.scanConfig.prefix,
      start: configInput?.start ?? persisted.scanConfig.start,
      end: configInput?.end ?? persisted.scanConfig.end,
    });
  }

  persisted.scanConfig = cfg;
  savePersistedState();

  const extraIps = new Set([
    ...Object.keys(persisted.nicknames),
    ...Object.keys(persisted.knownDevices),
  ]);
  const targetIps = buildTargetIps(cfg, [...extraIps]);
  const scanId = activeScan.id + 1;

  if (standardRefreshTimer) {
    clearTimeout(standardRefreshTimer);
    standardRefreshTimer = null;
  }

  rebootErrors.clear();
  liveScanFoundIps = new Set();
  activeScan = {
    running: true,
    mode: 'scan',
    id: scanId,
    scanned: 0,
    total: targetIps.length,
    foundCount: 0,
    startedAt: new Date().toISOString(),
    error: null,
  };
  bumpRevision();

  const t0 = performance.now();
  const scannedSet = new Set(targetIps);

  (async () => {
    try {
      const foundDevices = await scanIps(targetIps, {
        concurrency: 32,
        timeoutMs: 750,
        retries: 1,
        onDevice: (dev) => {
          upsertKnownDevice(dev);
          liveScanFoundIps.add(dev.ip);
          bumpRevision();
        },
        onProgress: ({ scanned, total, foundCount }) => {
          activeScan.scanned = scanned;
          activeScan.total = total;
          activeScan.foundCount = foundCount;
        },
      });

      const foundIpSet = new Set(foundDevices.map((d) => d.ip));

      // Mark previously known devices inside the scanned set that didn't respond as offline
      for (const ip of scannedSet) {
        if (!foundIpSet.has(ip) && persisted.knownDevices[ip]) {
          markDeviceOffline(ip);
        }
      }

      persisted.lastScanIps = foundDevices.map((d) => d.ip);

      // Prune unconfigured/un-nicknamed offline entries so transient DHCP leases don't accumulate
      for (const [ip, dev] of Object.entries(persisted.knownDevices)) {
        if (!dev?.online && !shouldRetainOfflineDevice(ip, dev)) {
          stopOfflineWatcher(ip);
          delete persisted.knownDevices[ip];
        }
      }

      persisted.lastScanAt = new Date().toISOString();
      persisted.lastScanDurationMs = Math.round(performance.now() - t0);
      lastRefreshCompletedAt = Date.now();
      liveScanFoundIps = new Set();
      activeScan.running = false;
      bumpRevision();
      savePersistedState();
    } catch (err) {
      console.error('[zw_scanner] Scan error:', err);
      liveScanFoundIps = new Set();
      activeScan.running = false;
      activeScan.error = err.message || 'Scan failed';
      bumpRevision();
    } finally {
      scheduleStandardAutoRefresh();
    }
  })();

  return { started: true, mode: 'scan', scanConfig: cfg, total: targetIps.length };
}

function startBackgroundRefresh() {
  if (activeScan.running) {
    return { started: false, alreadyRunning: true, scanConfig: persisted.scanConfig };
  }

  const targetIps = buildDeviceList().map((d) => d.ip);
  if (targetIps.length === 0) {
    return startBackgroundScan({});
  }

  const scanId = activeScan.id + 1;
  if (standardRefreshTimer) {
    clearTimeout(standardRefreshTimer);
    standardRefreshTimer = null;
  }

  rebootErrors.clear();
  liveScanFoundIps = new Set();
  activeScan = {
    running: true,
    mode: 'refresh',
    id: scanId,
    scanned: 0,
    total: targetIps.length,
    foundCount: 0,
    startedAt: new Date().toISOString(),
    error: null,
  };
  bumpRevision();

  (async () => {
    try {
      const foundDevices = await scanIps(targetIps, {
        concurrency: 16,
        timeoutMs: 750,
        retries: 1,
        onDevice: (dev) => {
          upsertKnownDevice(dev);
          liveScanFoundIps.add(dev.ip);
          bumpRevision();
        },
        onProgress: ({ scanned, total, foundCount }) => {
          activeScan.scanned = scanned;
          activeScan.total = total;
          activeScan.foundCount = foundCount;
        },
      });

      const foundIpSet = new Set(foundDevices.map((d) => d.ip));
      for (const ip of targetIps) {
        if (!foundIpSet.has(ip) && persisted.knownDevices[ip]) {
          markDeviceOffline(ip);
        }
      }

      const mergedLastIps = new Set(persisted.lastScanIps);
      for (const d of foundDevices) {
        mergedLastIps.add(d.ip);
      }
      persisted.lastScanIps = [...mergedLastIps].sort(compareIps);
      lastRefreshCompletedAt = Date.now();
      liveScanFoundIps = new Set();
      activeScan.running = false;
      bumpRevision();
      savePersistedState();
    } catch (err) {
      console.error('[zw_scanner] Refresh error:', err);
      liveScanFoundIps = new Set();
      activeScan.running = false;
      activeScan.error = err.message || 'Refresh failed';
      bumpRevision();
    } finally {
      scheduleStandardAutoRefresh();
    }
  })();

  return { started: true, mode: 'refresh', total: targetIps.length };
}

function refreshSingleDevice(ip) {
  if (!isValidIpv4(ip)) {
    return Promise.resolve({ ok: false, error: 'Invalid IPv4 address' });
  }
  if (activeScan.running || activeReboots.has(ip)) {
    return Promise.resolve({ ok: true, ip, skipped: true });
  }
  const existing = perIpRefreshInFlight.get(ip);
  if (existing) return existing;

  const task = (async () => {
    try {
      const dev = await probeAppliance(ip, { timeoutMs: 750, retries: 1 });
      if (dev.isZw) {
        upsertKnownDevice(dev);
        if (!persisted.lastScanIps.includes(ip)) {
          persisted.lastScanIps.push(ip);
          persisted.lastScanIps.sort(compareIps);
        }
      } else if (persisted.knownDevices[ip]) {
        markDeviceOffline(ip);
      }
      bumpRevision();
      savePersistedState();
      return { ok: true, ip, online: Boolean(dev.isZw), etag: getEtag() };
    } catch (err) {
      console.error(`[zw_scanner] Single-device refresh error for ${ip}:`, err.message);
      return { ok: false, ip, error: err.message || 'Refresh failed' };
    } finally {
      perIpRefreshInFlight.delete(ip);
    }
  })();

  perIpRefreshInFlight.set(ip, task);
  return task;
}

function openExternalHttpUrl(ip, subPath = '/') {
  if (!isValidIpv4(ip)) {
    throw new Error('Invalid IPv4 address');
  }
  const cleanPath = typeof subPath === 'string' && subPath.startsWith('/') ? subPath : '/';
  const url = `http://${ip}${cleanPath}`;

  const onLaunchError = (err) => {
    if (err) console.error('[zw_scanner] Failed to launch browser:', err.message);
  };
  if (process.platform === 'win32') {
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, onLaunchError);
  } else if (process.platform === 'darwin') {
    execFile('open', [url], onLaunchError);
  } else {
    execFile('xdg-open', [url], onLaunchError);
  }
  return { ok: true, url };
}

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    contentType: 'application/json',
  });
}

function triggerPanelOpenRefresh() {
  if (activeScan.running) {
    return { started: false, alreadyRunning: true };
  }
  if (buildDeviceList().length === 0) {
    return { started: false, empty: true };
  }
  if (Date.now() - lastRefreshCompletedAt < 1500) {
    return { started: false, recent: true };
  }
  return startBackgroundRefresh();
}

// ---------------------------------------------------------------------------
// Sidecar HTTP Server Registration
// ---------------------------------------------------------------------------

const app = new SidecarApp();

app.page('/', () => {
  triggerPanelOpenRefresh();
  return readFileSync(join(__dirname, 'index.html'), 'utf-8')
    .replace('href="/styles.css"', `href="/styles.css?v=${BOOT_ASSET_VERSION}"`)
    .replace('src="/app.js"', `src="/app.js?v=${BOOT_ASSET_VERSION}"`);
});

for (const [route, [filename, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(
    route,
    () =>
      new Response(readFileSync(join(__dirname, filename), 'utf-8'), {
        contentType,
        headers: { 'Cache-Control': 'no-store' },
      }),
    'GET'
  );
}

app.api(
  '/api/state',
  (data) => {
    const etag = getEtag();
    if (data.etag && data.etag === etag) {
      return { unchanged: true, etag };
    }
    return {
      unchanged: false,
      etag,
      scanConfig: persisted.scanConfig,
      sortRules: persisted.sortRules,
      activeScan,
      lastScanAt: persisted.lastScanAt,
      lastScanDurationMs: persisted.lastScanDurationMs,
      devices: buildDeviceList(),
    };
  },
  'GET'
);

app.api('/api/config', (data) => {
  const cfg = typeof data.range === 'string' && data.range.trim()
    ? parseRangeExpression(data.range)
    : normalizeScanConfig({
        prefix: data.prefix ?? persisted.scanConfig.prefix,
        start: data.start ?? persisted.scanConfig.start,
        end: data.end ?? persisted.scanConfig.end,
      });
  persisted.scanConfig = cfg;
  bumpRevision();
  savePersistedState();
  return { ok: true, scanConfig: cfg, etag: getEtag() };
}, 'POST');

app.api('/api/sort', (data) => {
  const sortRules = normalizeSortRules(data?.sortRules);
  persisted.sortRules = sortRules;
  bumpRevision();
  savePersistedState();
  return { ok: true, sortRules, etag: getEtag() };
}, 'POST');

app.api('/api/scan', (data) => {
  return startBackgroundScan(data || {});
}, 'POST');

app.api('/api/refresh', async (data) => {
  const singleIp = String(data?.ip || '').trim();
  if (singleIp) {
    if (!isValidIpv4(singleIp)) {
      return jsonError('Invalid IPv4 address', 400);
    }
    return refreshSingleDevice(singleIp);
  }
  if (data?.reason === 'panel-open') {
    return triggerPanelOpenRefresh();
  }
  return startBackgroundRefresh();
}, 'POST');

app.api('/api/nickname', (data) => {
  const ip = String(data?.ip || '').trim();
  if (!isValidIpv4(ip)) {
    return jsonError('Invalid IPv4 address', 400);
  }
  const nickname = String(data?.nickname ?? '').trim().slice(0, 64);
  const mac = persisted.knownDevices[ip]?.mac || '';
  if (nickname) {
    persisted.nicknames[ip] = nickname;
    if (mac) persisted.macNicknames[mac] = nickname;
  } else {
    delete persisted.nicknames[ip];
    if (mac) delete persisted.macNicknames[mac];
    if (persisted.knownDevices[ip] && !persisted.knownDevices[ip].online && !shouldRetainOfflineDevice(ip, persisted.knownDevices[ip]) && !persisted.lastScanIps.includes(ip)) {
      stopOfflineWatcher(ip);
      delete persisted.knownDevices[ip];
    }
  }
  bumpRevision();
  savePersistedState();
  return { ok: true, ip, nickname, etag: getEtag() };
}, 'POST');

app.api('/api/location', async (data) => {
  const ip = String(data?.ip || '').trim();
  if (!isValidIpv4(ip)) {
    return jsonError('Invalid IPv4 address', 400);
  }
  const cleanLocation = String(data?.location ?? '').trim();
  const locErr = validateLocation(cleanLocation);
  if (locErr) {
    return jsonError(locErr, 400);
  }

  try {
    const result = await updateApplianceLocation(ip, cleanLocation);
    if (result.device) {
      upsertKnownDevice(result.device);
      if (!persisted.lastScanIps.includes(ip)) {
        persisted.lastScanIps.push(ip);
        persisted.lastScanIps.sort(compareIps);
      }
    } else if (persisted.knownDevices[ip]) {
      persisted.knownDevices[ip].location = cleanLocation;
    }
    bumpRevision();
    savePersistedState();
    return { ok: true, ip, location: cleanLocation, etag: getEtag() };
  } catch (err) {
    void refreshSingleDevice(ip);
    return jsonError(err.message || 'Failed to update device location', 502);
  }
}, 'POST');

app.api('/api/reboot/prepare', async (data) => {
  const ip = String(data?.ip || '').trim();
  if (!isValidIpv4(ip)) {
    return jsonError('Invalid IPv4 address', 400);
  }
  rebootErrors.delete(ip);
  try {
    const bootSerial = await prepareReboot(ip);
    if (persisted.knownDevices[ip]) {
      persisted.knownDevices[ip].bootSerial = bootSerial;
      persisted.knownDevices[ip].online = true;
      stopOfflineWatcher(ip);
    }
    armedReboots.set(ip, {
      bootSerial,
      expiresAt: Date.now() + ARM_TTL_MS + ARM_SERVER_GRACE_MS,
    });
    bumpRevision();
    return { ok: true, ip, bootSerial, ttlMs: ARM_TTL_MS };
  } catch (err) {
    void refreshSingleDevice(ip);
    return jsonError(err.message || 'Failed to query boot serial', 502);
  }
}, 'POST');

app.api('/api/reboot/execute', async (data) => {
  const ip = String(data?.ip || '').trim();
  const bootSerial = String(data?.bootSerial || '').trim().toUpperCase();
  if (!isValidIpv4(ip) || !bootSerial) {
    return jsonError('Missing IP or bootSerial', 400);
  }

  const armed = armedReboots.get(ip);
  if (!armed || armed.bootSerial !== bootSerial || Date.now() > armed.expiresAt) {
    armedReboots.delete(ip);
    void refreshSingleDevice(ip);
    return jsonError('Reboot confirmation expired; please click Reboot again', 409);
  }
  armedReboots.delete(ip);
  rebootErrors.delete(ip);

  try {
    await triggerReboot(ip, bootSerial);
  } catch (err) {
    void refreshSingleDevice(ip);
    return jsonError(err.message || 'Reboot request failed', 502);
  }

  stopOfflineWatcher(ip);
  activeReboots.set(ip, {
    status: 'rebooting',
    previousBootSerial: bootSerial,
    startedAt: Date.now(),
  });
  bumpRevision();

  // Poll asynchronously until the device reconnects with a new boot_serial
  (async () => {
    try {
      const outcome = await waitForRebootCompletion(ip, bootSerial);
      activeReboots.delete(ip);
      if (outcome.device) {
        upsertKnownDevice(outcome.device);
        if (!persisted.lastScanIps.includes(ip)) {
          persisted.lastScanIps.push(ip);
          persisted.lastScanIps.sort(compareIps);
        }
        if (!outcome.rebooted) {
          rebootErrors.set(ip, {
            id: ++rebootErrorSeq,
            message: 'Device remained on the same boot serial after reboot attempt',
          });
        }
      } else {
        if (persisted.knownDevices[ip]) {
          markDeviceOffline(ip);
        }
        rebootErrors.set(ip, {
          id: ++rebootErrorSeq,
          message: 'Timed out waiting for device to come back online after reboot',
        });
      }
      bumpRevision();
      savePersistedState();
    } catch (err) {
      console.error(`[zw_scanner] Error polling reboot of ${ip}:`, err.message);
      activeReboots.delete(ip);
      rebootErrors.set(ip, {
        id: ++rebootErrorSeq,
        message: err.message || 'Error while waiting for device reboot',
      });
      bumpRevision();
    }
  })();

  return { ok: true, ip, status: 'rebooting', etag: getEtag() };
}, 'POST');

app.api('/api/open', (data) => {
  const ip = String(data?.ip || '').trim();
  const path = typeof data?.path === 'string' ? data.path : '/';
  return openExternalHttpUrl(ip, path);
}, 'POST');

scheduleStandardAutoRefresh();
console.log(`[zw_scanner] state file: ${STATE_FILE}`);
app.run();
