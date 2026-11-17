/**
 * ESPZWApplianceT2 subnet probe, HTTP fingerprinter, and verified reboot engine.
 *
 * Supports mixed fleets:
 *   - Upgraded firmware (v1.1.11+): 1-request `GET /!sys/discover`
 *   - Legacy firmware (<= v1.1.10): `GET /!sys/boot_serial` + `GET /!sys/ota/state`
 *
 * Pure Node.js ESM (zero external dependencies). Can be imported by main.mjs
 * or invoked directly from CLI:
 *   node scanner.mjs [range]
 *   e.g. node scanner.mjs 192.168.1.1-254
 */

import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SCAN_CONFIG = {
  prefix: '192.168.1',
  start: 1,
  end: 254,
};

const VIRTUAL_IFACE_RE = /(?:loopback|vethernet|hyper-v|wsl|docker|br-|veth|vmware|vmnet|vbox|virtualbox|tailscale|zerotier|utun|tun\d|tap\d|wg\d)/i;

const BOOT_SERIAL_RE = /^[0-9A-F]{8}$/;
const MAC_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PREFIX_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAX_BODY_BYTES = 16 * 1024;

export function isValidIpv4(ip) {
  const m = IPV4_RE.exec(String(ip || '').trim());
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

export function isValidMac(mac) {
  return MAC_RE.test(String(mac || '').trim().toUpperCase());
}

export function isValidPrefix(prefix) {
  const m = PREFIX_RE.exec(String(prefix || '').trim());
  if (!m) return false;
  for (let i = 1; i <= 3; i++) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

export function ipToSortableInt(ip) {
  const m = IPV4_RE.exec(ip);
  if (!m) return 0;
  return (((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4])) >>> 0;
}

export function compareIps(a, b) {
  return ipToSortableInt(a) - ipToSortableInt(b);
}

export const MAX_SORT_RULES = 3;

export const VALID_SORT_KEYS = Object.freeze([
  'ip',
  'name',
  'nickname',
  'hostname',
  'location',
  'app',
]);

export const DEFAULT_SORT_RULES = Object.freeze([
  Object.freeze({ key: 'ip', dir: 'asc' }),
]);

const VALID_SORT_KEY_SET = new Set(VALID_SORT_KEYS);
const NATURAL_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});
const BUILD_MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Normalizes an array of sort rules into 1..3 deduplicated `{ key, dir }` entries,
 * falling back to `[{ key: 'ip', dir: 'asc' }]` if empty or invalid.
 */
export function normalizeSortRules(input) {
  if (!Array.isArray(input)) {
    return DEFAULT_SORT_RULES.map((r) => ({ ...r }));
  }
  const seen = new Set();
  const normalized = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key || '').trim().toLowerCase();
    if (!VALID_SORT_KEY_SET.has(key) || seen.has(key)) continue;
    const dir = String(item.dir || '').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';
    seen.add(key);
    normalized.push({ key, dir });
    if (normalized.length >= MAX_SORT_RULES) break;
  }
  return normalized.length > 0 ? normalized : DEFAULT_SORT_RULES.map((r) => ({ ...r }));
}

/**
 * Parses C `__DATE__ " " __TIME__` firmware build strings (e.g. `"Jul 14 2025 22:08:26"`,
 * `"Nov  5 2026 08:01:02"`) or ISO timestamps into epoch milliseconds, or `null` if invalid.
 */
export function parseBuildTimestamp(str) {
  const s = String(str ?? '').trim();
  if (!s) return null;
  const m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) {
    const mon = BUILD_MONTHS[m[1].toLowerCase()];
    if (mon !== undefined) {
      return Date.UTC(
        Number(m[3]),
        mon,
        Number(m[2]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6])
      );
    }
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Compares two firmware version strings newest-to-oldest (descending semver).
 * Empty versions always sort last.
 */
export function compareVersionsDesc(verA, verB) {
  const rawA = String(verA ?? '').trim().replace(/^[vV]/, '');
  const rawB = String(verB ?? '').trim().replace(/^[vV]/, '');
  if (!rawA && !rawB) return 0;
  if (!rawA) return 1;
  if (!rawB) return -1;

  const [coreA, preA = ''] = rawA.split('-', 2);
  const [coreB, preB = ''] = rawB.split('-', 2);
  const segsA = coreA.split('.');
  const segsB = coreB.split('.');
  const maxLen = Math.max(segsA.length, segsB.length);

  for (let i = 0; i < maxLen; i++) {
    const sA = segsA[i] ?? '0';
    const sB = segsB[i] ?? '0';
    const nA = /^\d+$/.test(sA) ? Number(sA) : NaN;
    const nB = /^\d+$/.test(sB) ? Number(sB) : NaN;
    if (!Number.isNaN(nA) && !Number.isNaN(nB)) {
      if (nA !== nB) return nB - nA; // newest first
    } else {
      const cmp = NATURAL_COLLATOR.compare(sB, sA);
      if (cmp !== 0) return cmp;
    }
  }

  // Semver: release (no pre-release tag) is newer than pre-release of the same core version
  if (!preA && preB) return -1;
  if (preA && !preB) return 1;
  if (preA && preB) {
    return NATURAL_COLLATOR.compare(preB, preA);
  }
  return 0;
}

function compareBuildTimesDesc(buildA, buildB) {
  const sA = String(buildA ?? '').trim();
  const sB = String(buildB ?? '').trim();
  if (!sA && !sB) return 0;
  if (!sA) return 1;
  if (!sB) return -1;

  const tA = parseBuildTimestamp(sA);
  const tB = parseBuildTimestamp(sB);
  if (tA !== null && tB !== null) {
    return tB - tA; // newest first
  }
  if (tA !== null) return -1;
  if (tB !== null) return 1;
  return NATURAL_COLLATOR.compare(sB, sA);
}

function compareNullableNatural(valA, valB, sign) {
  const sA = String(valA ?? '').trim();
  const sB = String(valB ?? '').trim();
  if (!sA && !sB) return 0;
  if (!sA) return 1; // empty values always sort last
  if (!sB) return -1;
  return NATURAL_COLLATOR.compare(sA, sB) * sign;
}

function compareSingleSortRule(a, b, rule) {
  const sign = rule.dir === 'desc' ? -1 : 1;
  switch (rule.key) {
    case 'ip':
      return compareIps(a?.ip || '', b?.ip || '') * sign;
    case 'name': {
      const effA = String(a?.nickname || a?.hostname || '').trim();
      const effB = String(b?.nickname || b?.hostname || '').trim();
      return compareNullableNatural(effA, effB, sign);
    }
    case 'nickname':
      return compareNullableNatural(a?.nickname, b?.nickname, sign);
    case 'hostname':
      return compareNullableNatural(a?.hostname, b?.hostname, sign);
    case 'location':
      return compareNullableNatural(a?.location, b?.location, sign);
    case 'app': {
      const projCmp = compareNullableNatural(a?.project, b?.project, sign);
      if (projCmp !== 0) return projCmp;
      // Within the same app name, version + build datetime always sort newest -> oldest
      const verCmp = compareVersionsDesc(a?.version, b?.version);
      if (verCmp !== 0) return verCmp;
      return compareBuildTimesDesc(a?.buildTime, b?.buildTime);
    }
    default:
      return 0;
  }
}

/**
 * Compares two device entries using up to 3 cascading `sortRules`,
 * with ascending IPv4 address as the deterministic final tie-breaker.
 */
export function compareDevices(a, b, sortRules = DEFAULT_SORT_RULES) {
  const rules = Array.isArray(sortRules) && sortRules.length > 0 ? sortRules : DEFAULT_SORT_RULES;
  for (const rule of rules) {
    const cmp = compareSingleSortRule(a, b, rule);
    if (cmp !== 0) return cmp;
  }
  return compareIps(a?.ip || '', b?.ip || '');
}

/**
 * Returns a new sorted copy of `devices` ordered by normalized `sortRules`.
 */
export function sortDevices(devices, sortRules = DEFAULT_SORT_RULES) {
  if (!Array.isArray(devices) || devices.length === 0) return [];
  const rules = normalizeSortRules(sortRules);
  return [...devices].sort((a, b) => compareDevices(a, b, rules));
}

/**
 * Validates location identically to ESPZWApplianceT2 AppConfig & zw_sysmgmt.js.
 * Returns `null` if valid, or a human-readable error message.
 */
export function validateLocation(str) {
  if (typeof str !== 'string') return 'Invalid location value.';
  if (/[\x00-\x1F\x7F]/.test(str)) {
    return 'Location cannot contain control characters.';
  }
  if (Buffer.byteLength(str, 'utf-8') > 64) {
    return 'Location must be at most 64 UTF-8 bytes.';
  }
  return null;
}

function isPrivateLanIpv4(ip) {
  const m = IPV4_RE.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 192 && b === 168) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Auto-detects the host's primary private IPv4 `/24` prefix (e.g. `192.168.1`
 * or `10.0.0`) for initial unconfigured setups, falling back to `192.168.1`.
 */
export function detectDefaultPrefix(fallback = DEFAULT_SCAN_CONFIG.prefix) {
  try {
    const nets = networkInterfaces();
    const candidates = [];
    for (const [name, addrs] of Object.entries(nets || {})) {
      if (!Array.isArray(addrs)) continue;
      const isVirtual = VIRTUAL_IFACE_RE.test(name);
      for (const addr of addrs) {
        if (!addr || addr.internal) continue;
        const isV4 = addr.family === 'IPv4' || addr.family === 4;
        if (!isV4 || !isPrivateLanIpv4(addr.address)) continue;
        const parts = addr.address.split('.');
        const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
        let score = isVirtual ? 0 : 10;
        if (parts[0] === '192' && parts[1] === '168') score += 5;
        candidates.push({ prefix, score });
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0].prefix;
    }
  } catch {
    // Ignore OS interface enumeration errors and fall back cleanly
  }
  return fallback;
}

export function detectDefaultScanConfig() {
  return {
    prefix: detectDefaultPrefix(),
    start: DEFAULT_SCAN_CONFIG.start,
    end: DEFAULT_SCAN_CONFIG.end,
  };
}

/**
 * Normalizes { prefix, start, end } into validated bounds.
 */
export function normalizeScanConfig(input = {}) {
  const rawPrefix = String(input.prefix ?? DEFAULT_SCAN_CONFIG.prefix).trim().replace(/\.$/, '');
  if (!isValidPrefix(rawPrefix)) {
    throw new Error(`Invalid IPv4 /24 prefix: "${rawPrefix}" (expected e.g. 192.168.1)`);
  }
  let start = Number.parseInt(String(input.start ?? DEFAULT_SCAN_CONFIG.start), 10);
  let end = Number.parseInt(String(input.end ?? DEFAULT_SCAN_CONFIG.end), 10);
  if (!Number.isInteger(start)) start = 1;
  if (!Number.isInteger(end)) end = 254;
  start = Math.max(1, Math.min(254, start));
  end = Math.max(1, Math.min(254, end));
  if (start > end) [start, end] = [end, start];
  return { prefix: rawPrefix, start, end };
}

/**
 * Parses flexible human range expressions into { prefix, start, end }:
 *   - "192.168.1.32-127"
 *   - "192.168.1.32 - 192.168.1.127"
 *   - "192.168.1.0/24" or "192.168.1.*"
 *   - "192.168.1.50"
 */
export function parseRangeExpression(expr) {
  const s = String(expr || '').trim();
  let m;
  if ((m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})\s*-\s*(\d{1,3})$/.exec(s))) {
    return normalizeScanConfig({ prefix: m[1], start: m[2], end: m[3] });
  }
  if ((m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})\s*-\s*(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/.exec(s))) {
    if (m[1] !== m[3]) throw new Error('Start and end IPs must be in the same /24 subnet');
    return normalizeScanConfig({ prefix: m[1], start: m[2], end: m[4] });
  }
  if ((m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(?:0\/24|\*)$/.exec(s))) {
    return normalizeScanConfig({ prefix: m[1], start: 1, end: 254 });
  }
  if ((m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/.exec(s))) {
    return normalizeScanConfig({ prefix: m[1], start: m[2], end: m[2] });
  }
  if (isValidPrefix(s)) {
    return normalizeScanConfig({ prefix: s, start: 1, end: 254 });
  }
  throw new Error(`Unrecognized range "${s}"`);
}

/**
 * Builds the sorted list of target IPs from { prefix, start, end } plus optional extraIps.
 */
export function buildTargetIps(scanConfig, extraIps = []) {
  const cfg = normalizeScanConfig(scanConfig);
  const set = new Set();
  for (let i = cfg.start; i <= cfg.end; i++) {
    set.add(`${cfg.prefix}.${i}`);
  }
  for (const ip of extraIps) {
    if (isValidIpv4(ip) && ip.startsWith(`${cfg.prefix}.`)) {
      set.add(ip);
    }
  }
  return [...set].sort(compareIps);
}

/**
 * Single HTTP request with `Connection: close` and zero keep-alive pooling so
 * ESP8266 lwIP sockets are freed immediately after each request.
 */
export function httpRequestRaw(ip, { method = 'GET', path = '/', body = null, contentType = null, timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    let resRef = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, latencyMs: Math.round(performance.now() - t0) });
    };

    const payloadBuf = body !== null && body !== undefined
      ? (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf-8'))
      : null;

    const headers = {
      Host: ip,
      Connection: 'close',
      Accept: '*/*',
    };
    if (payloadBuf) {
      headers['Content-Length'] = String(payloadBuf.length);
      if (contentType) headers['Content-Type'] = contentType;
    }

    const req = http.request(
      {
        host: ip,
        port: 80,
        path,
        method,
        agent: false,
        headers,
      },
      (res) => {
        resRef = res;
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          if (total < MAX_BODY_BYTES) {
            const slice = total + chunk.length > MAX_BODY_BYTES
              ? chunk.subarray(0, MAX_BODY_BYTES - total)
              : chunk;
            chunks.push(slice);
          }
          total += chunk.length;
          if (total >= MAX_BODY_BYTES) {
            res.destroy();
          }
        });
        res.on('end', () => {
          const respBody = Buffer.concat(chunks).toString('utf-8');
          const respContentType = String(res.headers['content-type'] || '');
          finish({
            ok: true,
            status: res.statusCode || 0,
            headers: res.headers,
            contentType: respContentType,
            body: respBody,
          });
        });
        res.on('error', (err) => {
          finish({ ok: false, error: err.code || err.message || 'read_error' });
        });
      }
    );

    const timer = setTimeout(() => {
      if (resRef) resRef.destroy();
      req.destroy();
      finish({ ok: false, error: 'ETIMEDOUT' });
    }, timeoutMs);

    req.on('error', (err) => {
      finish({ ok: false, error: err.code || err.message || 'connect_error' });
    });

    if (payloadBuf) req.write(payloadBuf);
    req.end();
  });
}

export function httpGetRaw(ip, path, timeoutMs = 1000) {
  return httpRequestRaw(ip, { method: 'GET', path, timeoutMs });
}

/**
 * Parses and validates a `/!sys/discover` JSON response body.
 */
function parseDiscoverPayload(body) {
  try {
    const data = JSON.parse(body);
    if (!data || typeof data !== 'object') return null;
    const bootSerial = String(data.boot_serial || '').trim().toUpperCase();
    if (!BOOT_SERIAL_RE.test(bootSerial)) return null;
    const id = data.identity;
    const fw = data.firmware;
    if (!id || typeof id !== 'object' || !fw || typeof fw !== 'object') return null;
    const mac = String(id.mac || '').trim().toUpperCase();
    return {
      bootSerial,
      mac: isValidMac(mac) ? mac : '',
      hostname: typeof id.hostname === 'string' ? id.hostname : '',
      location: typeof id.location === 'string' ? id.location : '',
      project: typeof fw.name === 'string' && fw.name ? fw.name : 'ZWAppliance',
      version: typeof fw.version === 'string' ? fw.version : '',
      buildTime: typeof fw.build_time === 'string' ? fw.build_time : '',
    };
  } catch {
    return null;
  }
}

/**
 * Probes `/!sys/discover` first with 1 optional timeout retry to accommodate
 * ESP8266 `WIFI_PS_MIN_MODEM` DTIM beacon wakeup latency (up to ~550 ms).
 */
export async function probeDiscover(ip, { timeoutMs = 750, retries = 1 } = {}) {
  let attempt = 0;
  while (true) {
    const currentTimeout = attempt === 0 ? timeoutMs : timeoutMs + 150;
    const res = await httpGetRaw(ip, '/!sys/discover', currentTimeout);
    if (res.ok) {
      if (res.status === 200) {
        const parsed = parseDiscoverPayload(res.body);
        if (parsed) {
          return {
            reachable: true,
            supported: true,
            ...parsed,
            latencyMs: res.latencyMs,
          };
        }
      }
      return {
        reachable: true,
        supported: false,
        status: res.status,
        latencyMs: res.latencyMs,
      };
    }
    if (attempt < retries && res.error === 'ETIMEDOUT') {
      attempt++;
      continue;
    }
    return {
      reachable: false,
      supported: false,
      error: res.error,
      latencyMs: res.latencyMs,
    };
  }
}

/**
 * Probes `/!sys/boot_serial` with optional timeout retry.
 */
export async function probeBootSerial(ip, { timeoutMs = 750, retries = 1 } = {}) {
  let attempt = 0;
  while (true) {
    const currentTimeout = attempt === 0 ? timeoutMs : timeoutMs + 150;
    const res = await httpGetRaw(ip, '/!sys/boot_serial', currentTimeout);
    if (res.ok) {
      const trimmed = res.body.trim();
      const isZw = res.status === 200 && BOOT_SERIAL_RE.test(trimmed);
      return {
        reachable: true,
        isZw,
        bootSerial: isZw ? trimmed : null,
        quirkHeader: res.contentType === '200 OK',
        latencyMs: res.latencyMs,
      };
    }
    if (attempt < retries && res.error === 'ETIMEDOUT') {
      attempt++;
      continue;
    }
    return {
      reachable: false,
      isZw: false,
      bootSerial: null,
      error: res.error,
      latencyMs: res.latencyMs,
    };
  }
}

function extractHtmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/**
 * Full sequential fingerprint + metadata read for one candidate IP.
 * Never opens concurrent sockets to the same ESP8266:
 *   1. Try `GET /!sys/discover` (1-request fast path on v1.1.11+).
 *   2. If host is unreachable, stop immediately.
 *   3. If host returned 404 / non-discover HTTP response, fall back to
 *      legacy `GET /!sys/boot_serial` + `GET /!sys/ota/state`.
 */
export async function probeAppliance(ip, { timeoutMs = 750, retries = 1 } = {}) {
  const disc = await probeDiscover(ip, { timeoutMs, retries });
  if (!disc.reachable) {
    return {
      ip,
      online: false,
      isZw: false,
      httpOpen: false,
    };
  }

  if (disc.supported) {
    return {
      ip,
      online: true,
      isZw: true,
      supportsDiscover: true,
      bootSerial: disc.bootSerial,
      mac: disc.mac,
      hostname: disc.hostname,
      location: disc.location,
      project: disc.project,
      version: disc.version,
      buildTime: disc.buildTime,
      idfVer: '',
      runningSlot: null,
      otaRestricted: false,
      latencyMs: disc.latencyMs,
      lastSeenAt: new Date().toISOString(),
    };
  }

  // Host responded over HTTP (already awake), so probe legacy `/!sys/boot_serial`
  const bs = await probeBootSerial(ip, { timeoutMs: Math.max(timeoutMs, 900), retries: 0 });
  if (!bs.isZw) {
    return {
      ip,
      online: false,
      isZw: false,
      httpOpen: bs.reachable,
    };
  }

  let project = null;
  let version = null;
  let buildTime = null;
  let idfVer = null;
  let runningSlot = null;
  let otaRestricted = false;

  // Sequential request: /!sys/ota/state (`cur_part` is always emitted at index [0])
  const otaRes = await httpGetRaw(ip, '/!sys/ota/state', 2000);
  if (otaRes.ok && otaRes.status === 200) {
    try {
      const slots = JSON.parse(otaRes.body);
      if (Array.isArray(slots) && slots.length > 0) {
        const cur = slots[0] || {};
        project = cur.image_name || null;
        version = cur.image_ver || null;
        buildTime = cur.build_time || null;
        idfVer = cur.idf_ver || null;
        runningSlot = typeof cur.index === 'number' ? cur.index : null;
      }
    } catch {
      // Malformed JSON fallback below
    }
  } else if (otaRes.ok && otaRes.status === 403) {
    otaRestricted = true;
  }

  // Fallback only if /!sys/ota/state was disabled or netmask-restricted
  if (!project) {
    const rootRes = await httpGetRaw(ip, '/', 1500);
    if (rootRes.ok && rootRes.status === 200) {
      const title = extractHtmlTitle(rootRes.body);
      if (title) project = title;
    }
  }

  return {
    ip,
    online: true,
    isZw: true,
    supportsDiscover: false,
    bootSerial: bs.bootSerial,
    mac: '',
    hostname: '',
    location: '',
    project: project || 'ZWAppliance',
    version: version || '',
    buildTime: buildTime || '',
    idfVer: idfVer || '',
    runningSlot,
    otaRestricted,
    latencyMs: disc.latencyMs,
    lastSeenAt: new Date().toISOString(),
  };
}

/**
 * Validates and persists `{ location }` to an upgraded appliance via partial
 * `PUT /!sys/config?section=identity` (preserving `hostname`), then refreshes
 * `/!sys/discover`.
 */
export async function updateApplianceLocation(ip, location = '') {
  if (!isValidIpv4(ip)) throw new Error('Invalid IP address');

  const cleanLocation = String(location ?? '').trim();
  const locErr = validateLocation(cleanLocation);
  if (locErr) throw new Error(locErr);

  const putRes = await httpRequestRaw(ip, {
    method: 'PUT',
    path: '/!sys/config?section=identity',
    body: JSON.stringify({ location: cleanLocation }),
    contentType: 'application/json',
    timeoutMs: 3000,
  });

  if (!putRes.ok) {
    throw new Error('Failed to update location: device unreachable or timed out');
  }
  if (putRes.status !== 204 && putRes.status !== 200) {
    throw new Error(putRes.body.trim() || `Location update rejected (HTTP ${putRes.status})`);
  }

  const refreshed = await probeAppliance(ip, { timeoutMs: 1500, retries: 1 });
  return {
    location: cleanLocation,
    device: refreshed.isZw ? refreshed : null,
  };
}

/**
 * Parallel subnet sweep (high concurrency across distinct IPs, strictly
 * sequential per IP).
 */
export async function scanIps(ips, { concurrency = 32, timeoutMs = 750, retries = 1, onProgress, onDevice, shouldCancel } = {}) {
  const total = ips.length;
  let cursor = 0;
  let scanned = 0;
  const found = [];

  async function worker() {
    while (true) {
      if (shouldCancel?.()) return;
      const idx = cursor++;
      if (idx >= total) return;
      const ip = ips[idx];
      const result = await probeAppliance(ip, { timeoutMs, retries });
      if (shouldCancel?.()) return;
      scanned++;
      if (result.isZw) {
        found.push(result);
        onDevice?.(result);
      }
      onProgress?.({ scanned, total, foundCount: found.length });
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, total || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  found.sort((a, b) => compareIps(a.ip, b.ip));
  return found;
}

/**
 * Step 1 of two-phase reboot: fetches the live boot_serial from the target MCU.
 */
export async function prepareReboot(ip) {
  if (!isValidIpv4(ip)) throw new Error('Invalid IP address');
  const bs = await probeBootSerial(ip, { timeoutMs: 900, retries: 1 });
  if (!bs.reachable) {
    throw new Error('Failed to get boot serial: device unreachable or timed out');
  }
  if (!bs.isZw || !bs.bootSerial) {
    throw new Error('Device did not return a valid boot serial');
  }
  return bs.bootSerial;
}

/**
 * Step 2 of two-phase reboot: sends GET /!sys/reboot?bs=<bootSerial>.
 */
export async function triggerReboot(ip, bootSerial) {
  if (!isValidIpv4(ip)) throw new Error('Invalid IP address');
  const bs = String(bootSerial || '').trim().toUpperCase();
  if (!BOOT_SERIAL_RE.test(bs)) {
    throw new Error('Invalid boot serial token');
  }
  const res = await httpGetRaw(ip, `/!sys/reboot?bs=${encodeURIComponent(bs)}`, 2500);
  if (res.ok) {
    if (res.status === 204 || res.status === 200) {
      return { ok: true };
    }
    throw new Error(res.body.trim() || `Reboot rejected with HTTP ${res.status}`);
  }
  // ECONNRESET can occur if lwIP tears down right as ZW_SYSTEM_EVENT_REBOOT fires.
  if (res.error === 'ECONNRESET') {
    return { ok: true };
  }
  throw new Error(`Reboot request failed: ${res.error}`);
}

/**
 * Polls a rebooting device until a new boot_serial appears, then returns its
 * refreshed appliance metadata.
 */
export async function waitForRebootCompletion(ip, previousBootSerial, { initialDelayMs = 2200, pollIntervalMs = 2200, maxWaitMs = 30000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  await new Promise((r) => setTimeout(r, initialDelayMs));

  while (Date.now() < deadline) {
    const dev = await probeAppliance(ip, { timeoutMs: 1100, retries: 0 });
    if (dev.online && dev.isZw && dev.bootSerial && dev.bootSerial !== previousBootSerial) {
      return { rebooted: true, device: dev };
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Final check even if bootSerial somehow matched or took extra time
  const lastCheck = await probeAppliance(ip, { timeoutMs: 1500, retries: 1 });
  return {
    rebooted: Boolean(lastCheck.online && lastCheck.bootSerial !== previousBootSerial),
    device: lastCheck.online ? lastCheck : null,
  };
}

// Standalone CLI entrypoint: `node scanner.mjs [range]`
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()
) {
  const arg = process.argv[2];
  const cfg = arg ? parseRangeExpression(arg) : detectDefaultScanConfig();
  const ips = buildTargetIps(cfg);
  const t0 = performance.now();
  const devices = await scanIps(ips);
  const elapsedMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify({ scanConfig: cfg, count: devices.length, elapsedMs, devices }, null, 2));
}
