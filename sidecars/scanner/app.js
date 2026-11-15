/*
 * ZW Appliances Auxiliary Side Pane Frontend.
 *
 * Implements:
 * - Light/Dark theme synchronization with Antigravity host CSS tokens
 * - Adjustable subnet & host-octet range bar (with wheel step, paste parsing & 1-click All reset)
 * - Live scan progress bar & ETag-gated polling
 * - Compact two-row mixed-fleet device cards (`v1.1.11+` `/!sys/discover` + legacy fallback)
 * - Inline local nickname editor (MAC-indexed on upgraded devices, IP-bound on legacy devices)
 * - Two-phase Reboot -> fetch boot_serial -> Confirm button with withdrawing timeout progress bar
 */
(() => {
  const IDLE_POLL_MS = 2500;
  const FAST_POLL_MS = 450;
  const REFRESH_POLL_MS = 200;
  const TWO_CLICK_ARM_TTL_MS = 1500;
  const CARD_ERROR_TTL_MS = 5000;
  const UTF8_ENCODER = new TextEncoder();

  const $ = (id) => document.getElementById(id);

  const ui = {
    etag: '',
    snap: null,
    rangeInitialized: false,
    initialRefreshDone: false,
    panelWasHidden: false,
    isIntersecting: true,
    editingIp: null,
    editingDraft: '',
    editingLocationIp: null,
    editingLocationDraft: '',
    savingLocationIp: null,
    // Armed Refresh -> Re-scan state: { armedAt, expiresAt, ttlMs }
    scanArmed: null,
    scanRafId: null,
    scanArmTimeoutId: null,
    // Single active armed reboot state: { ip, phase: 'arming' | 'armed' | 'submitting', bootSerial, armedAt, expiresAt, ttlMs }
    armed: null,
    rafId: null,
    // Per-card inline error banners: ip -> { message, expiresAt, ttlMs, timerId }
    cardErrors: {},
    cardErrorRafId: null,
    seenRebootErrorIds: {},
    toastTimer: null,
  };

  function validateLocation(str) {
    if (typeof str !== 'string') return 'Invalid location value.';
    if (/[\x00-\x1F\x7F]/.test(str)) {
      return 'Location cannot contain control characters.';
    }
    if (UTF8_ENCODER.encode(str).length > 64) {
      return 'Location must be at most 64 UTF-8 bytes.';
    }
    return null;
  }

  // ---------- Host Theme Sync ----------
  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const nums = (computed.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = computed.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncThemeScheme();
  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Sidecar Fetch Helpers ----------
  function apiFetch(path, options = {}) {
    if (window.sidecar?.fetch) {
      return window.sidecar.fetch(path, options);
    }
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(path, { ...options, headers });
  }

  async function apiGet(path) {
    const res = await apiFetch(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path} failed (${res.status})`);
    return res.json();
  }

  async function apiPost(path, payload = {}) {
    const res = await apiFetch(path, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function showToast(msg, kind = 'error') {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('is-info', kind === 'info');
    el.classList.remove('hidden');
    if (ui.toastTimer) clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, 4500);
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function formatTimeAgoOrClock(iso, durationMs) {
    if (!iso) return 'Not scanned yet';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Not scanned yet';
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const durStr = typeof durationMs === 'number' ? ` (${(durationMs / 1000).toFixed(1)}s)` : '';
    return `Last scan ${timeStr}${durStr}`;
  }

  // ---------- Range Input Helpers ----------
  function currentRangeValues() {
    const prefix = $('range-prefix').value.trim().replace(/\.$/, '');
    let start = Number.parseInt($('range-start').value, 10);
    let end = Number.parseInt($('range-end').value, 10);
    if (!Number.isInteger(start)) start = 1;
    if (!Number.isInteger(end)) end = 254;
    start = Math.max(1, Math.min(254, start));
    end = Math.max(1, Math.min(254, end));
    return { prefix, start, end };
  }

  function updateAllResetVisibility() {
    const { start, end } = currentRangeValues();
    $('range-reset').classList.toggle('hidden', start === 1 && end === 254);
  }

  function applyScanConfigToInputs(cfg) {
    if (!cfg) return;
    $('range-prefix').value = cfg.prefix || '192.168.1';
    $('range-start').value = String(cfg.start ?? 1);
    $('range-end').value = String(cfg.end ?? 254);
    updateAllResetVisibility();
  }

  function tryParsePastedRange(text) {
    const s = String(text || '').trim();
    let m;
    if ((m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})\s*-\s*(\d{1,3})$/.exec(s))) {
      return { prefix: m[1], start: Number(m[2]), end: Number(m[3]) };
    }
    if ((m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})\s*-\s*(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/.exec(s))) {
      if (m[1] === m[3]) return { prefix: m[1], start: Number(m[2]), end: Number(m[4]) };
    }
    if ((m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(?:0\/24|\*)$/.exec(s))) {
      return { prefix: m[1], start: 1, end: 254 };
    }
    if ((m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/.exec(s))) {
      return { prefix: m[1], start: m[2], end: m[2] };
    }
    return null;
  }

  for (const id of ['range-prefix', 'range-start', 'range-end']) {
    const input = $(id);
    input.addEventListener('input', updateAllResetVisibility);
    input.addEventListener('paste', (e) => {
      const pasted = e.clipboardData?.getData('text') || '';
      const parsed = tryParsePastedRange(pasted);
      if (parsed) {
        e.preventDefault();
        applyScanConfigToInputs(parsed);
      }
    });
  }

  for (const id of ['range-start', 'range-end']) {
    const input = $(id);
    input.addEventListener('wheel', (e) => {
      e.preventDefault();
      const cur = Number.parseInt(input.value, 10) || 1;
      const step = e.shiftKey ? 10 : 1;
      const next = e.deltaY < 0 ? Math.min(254, cur + step) : Math.max(1, cur - step);
      input.value = String(next);
      updateAllResetVisibility();
    }, { passive: false });
  }

  $('range-reset').addEventListener('click', async () => {
    $('range-start').value = '1';
    $('range-end').value = '254';
    updateAllResetVisibility();
    try {
      const { prefix } = currentRangeValues();
      await apiPost('/api/config', { prefix, start: 1, end: 254 });
    } catch (err) {
      showToast(err.message);
    }
  });

  // ---------- Scan / Armed Refresh -> Re-scan ----------
  function stopScanArmTimers() {
    if (ui.scanRafId) {
      cancelAnimationFrame(ui.scanRafId);
      ui.scanRafId = null;
    }
    if (ui.scanArmTimeoutId) {
      clearTimeout(ui.scanArmTimeoutId);
      ui.scanArmTimeoutId = null;
    }
  }

  function clearScanArmState() {
    stopScanArmTimers();
    if (!ui.scanArmed) return;
    ui.scanArmed = null;
    renderHeader();
  }

  function tickCardErrorCountdowns() {
    const ips = Object.keys(ui.cardErrors);
    if (ips.length === 0) {
      ui.cardErrorRafId = null;
      return;
    }
    const now = performance.now();
    let expiredAny = false;
    for (const ip of ips) {
      const entry = ui.cardErrors[ip];
      if (!entry) continue;
      const remaining = entry.expiresAt - now;
      if (remaining <= 0) {
        if (entry.timerId) clearTimeout(entry.timerId);
        delete ui.cardErrors[ip];
        expiredAny = true;
      } else {
        const ratio = Math.max(0, Math.min(1, remaining / entry.ttlMs));
        const bar = document.querySelector(`.device-card[data-ip="${CSS.escape(ip)}"] .card-error-bar`);
        if (bar) {
          bar.style.transform = `scaleX(${ratio.toFixed(4)})`;
        }
      }
    }
    if (expiredAny) {
      renderDevices();
    }
    if (Object.keys(ui.cardErrors).length > 0) {
      ui.cardErrorRafId = requestAnimationFrame(tickCardErrorCountdowns);
    } else {
      ui.cardErrorRafId = null;
    }
  }

  function ensureCardErrorAnimation() {
    if (!ui.cardErrorRafId && Object.keys(ui.cardErrors).length > 0) {
      ui.cardErrorRafId = requestAnimationFrame(tickCardErrorCountdowns);
    }
  }

  function setCardError(ip, message, ttlMs = CARD_ERROR_TTL_MS) {
    if (!ip) return;
    if (ui.cardErrors[ip]?.timerId) {
      clearTimeout(ui.cardErrors[ip].timerId);
    }
    const now = performance.now();
    const timerId = setTimeout(() => {
      if (ui.cardErrors[ip]?.timerId === timerId) {
        delete ui.cardErrors[ip];
        renderDevices();
      }
    }, ttlMs);
    ui.cardErrors[ip] = {
      message: String(message || 'Request failed'),
      expiresAt: now + ttlMs,
      ttlMs,
      timerId,
    };
    renderDevices();
    ensureCardErrorAnimation();
  }

  function clearCardError(ip) {
    if (!ip || !ui.cardErrors[ip]) return;
    if (ui.cardErrors[ip].timerId) clearTimeout(ui.cardErrors[ip].timerId);
    delete ui.cardErrors[ip];
    renderDevices();
  }

  function clearAllCardErrors() {
    for (const entry of Object.values(ui.cardErrors)) {
      if (entry?.timerId) clearTimeout(entry.timerId);
    }
    ui.cardErrors = {};
    if (ui.cardErrorRafId) {
      cancelAnimationFrame(ui.cardErrorRafId);
      ui.cardErrorRafId = null;
    }
  }

  function refreshDeviceAfterError(ip) {
    if (!ip) return;
    apiPost('/api/refresh', { ip })
      .then(() => pollOnce(true))
      .catch(() => {});
  }

  async function triggerFullScan() {
    if (ui.snap?.activeScan?.running) return;
    clearAllCardErrors();
    try {
      const { prefix, start, end } = currentRangeValues();
      const res = await apiPost('/api/scan', { prefix, start, end });
      if (res.scanConfig) applyScanConfigToInputs(res.scanConfig);
      await pollOnce(true);
      reschedulePollLoop();
    } catch (err) {
      showToast(err.message);
    }
  }

  async function triggerRefreshEntries(reason = 'manual') {
    if (ui.snap?.activeScan?.running) return;
    if (reason === 'manual') {
      clearAllCardErrors();
    }
    try {
      const payload = reason === 'panel-open' ? { reason: 'panel-open' } : {};
      await apiPost('/api/refresh', payload);
      await pollOnce(true);
      reschedulePollLoop();
    } catch (err) {
      if (reason === 'manual') {
        showToast(err.message);
      }
    }
  }

  function expireScanArmAndRefresh() {
    if (!ui.scanArmed) return;
    stopScanArmTimers();
    ui.scanArmed = null;
    renderHeader();
    triggerRefreshEntries();
  }

  function tickScanArmCountdown() {
    if (!ui.scanArmed) {
      ui.scanRafId = null;
      return;
    }
    const now = performance.now();
    const remaining = ui.scanArmed.expiresAt - now;
    if (remaining <= 0) {
      expireScanArmAndRefresh();
      return;
    }
    const ratio = Math.max(0, Math.min(1, remaining / ui.scanArmed.ttlMs));
    const bar = $('scan-countdown-bar');
    if (bar) {
      bar.style.transform = `scaleX(${ratio.toFixed(4)})`;
    }
    ui.scanRafId = requestAnimationFrame(tickScanArmCountdown);
  }

  function startScanArmCountdown(ttlMs = TWO_CLICK_ARM_TTL_MS) {
    stopScanArmTimers();
    const now = performance.now();
    ui.scanArmed = {
      armedAt: now,
      expiresAt: now + ttlMs,
      ttlMs,
    };
    renderHeader();
    ui.scanRafId = requestAnimationFrame(tickScanArmCountdown);
    ui.scanArmTimeoutId = setTimeout(expireScanArmAndRefresh, ttlMs);
  }

  $('scan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ui.snap?.activeScan?.running) return;

    const hasEntries = (ui.snap?.devices?.length || 0) > 0;
    if (!hasEntries) {
      await triggerFullScan();
      return;
    }

    if (ui.scanArmed) {
      clearScanArmState();
      await triggerFullScan();
      return;
    }

    startScanArmCountdown(TWO_CLICK_ARM_TTL_MS);
  });

  // ---------- Armed Reboot Withdrawing Progress Bar Loop ----------
  function stopArmedAnimation() {
    if (ui.rafId) {
      cancelAnimationFrame(ui.rafId);
      ui.rafId = null;
    }
  }

  function clearArmedState() {
    stopArmedAnimation();
    if (!ui.armed) return;
    ui.armed = null;
    renderDevices();
  }

  function tickArmedCountdown() {
    if (!ui.armed || ui.armed.phase !== 'armed') {
      ui.rafId = null;
      return;
    }
    const now = performance.now();
    const remaining = ui.armed.expiresAt - now;
    if (remaining <= 0) {
      clearArmedState();
      return;
    }
    const ratio = Math.max(0, Math.min(1, remaining / ui.armed.ttlMs));
    const bar = document.querySelector(`.device-card[data-ip="${CSS.escape(ui.armed.ip)}"] .reboot-countdown-bar`);
    if (bar) {
      bar.style.transform = `scaleX(${ratio.toFixed(4)})`;
    }
    ui.rafId = requestAnimationFrame(tickArmedCountdown);
  }

  function startArmedCountdown(ip, bootSerial, ttlMs) {
    stopArmedAnimation();
    const now = performance.now();
    ui.armed = {
      ip,
      phase: 'armed',
      bootSerial,
      armedAt: now,
      expiresAt: now + ttlMs,
      ttlMs,
    };
    renderDevices();
    ui.rafId = requestAnimationFrame(tickArmedCountdown);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (ui.scanArmed) {
        clearScanArmState();
      }
      if (ui.armed?.phase === 'armed') {
        clearArmedState();
      }
    }
  });

  async function handleRebootButtonClick(ip) {
    // Second click while armed -> execute reboot!
    if (ui.armed && ui.armed.ip === ip && ui.armed.phase === 'armed') {
      const { bootSerial } = ui.armed;
      stopArmedAnimation();
      clearCardError(ip);
      ui.armed = { ip, phase: 'submitting' };
      renderDevices();
      try {
        await apiPost('/api/reboot/execute', { ip, bootSerial });
        ui.armed = null;
        await pollOnce(true);
      } catch (err) {
        ui.armed = null;
        setCardError(ip, err.message);
        refreshDeviceAfterError(ip);
      }
      return;
    }

    // Ignore if already arming/submitting
    if (ui.armed && ui.armed.ip === ip && (ui.armed.phase === 'arming' || ui.armed.phase === 'submitting')) {
      return;
    }

    // First click -> fetch fresh boot_serial to arm confirmation
    stopArmedAnimation();
    clearCardError(ip);
    ui.armed = { ip, phase: 'arming' };
    renderDevices();
    try {
      const res = await apiPost('/api/reboot/prepare', { ip });
      if (!ui.armed || ui.armed.ip !== ip || ui.armed.phase !== 'arming') return;
      startArmedCountdown(ip, res.bootSerial, res.ttlMs || TWO_CLICK_ARM_TTL_MS);
    } catch (err) {
      if (ui.armed?.ip === ip) ui.armed = null;
      setCardError(ip, err.message);
      refreshDeviceAfterError(ip);
    }
  }

  // ---------- Local Nickname Editing ----------
  function beginEditNickname(ip, currentNickname) {
    ui.editingLocationIp = null;
    ui.editingIp = ip;
    ui.editingDraft = currentNickname || '';
    renderDevices();
    const input = document.querySelector(`.device-card[data-ip="${CSS.escape(ip)}"] .nick-input`);
    if (input) {
      input.focus();
      input.select();
    }
  }

  async function commitNickname(ip, rawValue) {
    if (ui.editingIp !== ip) return;
    ui.editingIp = null;
    const nickname = String(rawValue ?? '').trim();
    const current = (ui.snap?.devices || []).find((d) => d.ip === ip)?.nickname || '';
    if (nickname === current) {
      renderDevices();
      return;
    }
    try {
      await apiPost('/api/nickname', { ip, nickname });
      await pollOnce(true);
    } catch (err) {
      showToast(err.message);
      renderDevices();
    }
  }

  function cancelEditNickname() {
    ui.editingIp = null;
    renderDevices();
  }

  // ---------- On-Device Location Editing (v1.1.11+) ----------
  function beginEditLocation(dev) {
    if (!dev || !dev.online || ui.savingLocationIp === dev.ip) return;
    clearCardError(dev.ip);
    ui.editingIp = null;
    ui.editingLocationIp = dev.ip;
    ui.editingLocationDraft = dev.location || '';
    renderDevices();
    const input = document.querySelector(`.device-card[data-ip="${CSS.escape(dev.ip)}"] .loc-input`);
    if (input) {
      input.focus();
      input.select();
    }
  }

  async function commitLocation(ip, rawValue, { fromBlur = false } = {}) {
    if (ui.editingLocationIp !== ip) return;
    const location = String(rawValue ?? '').trim();
    const locErr = validateLocation(location);
    if (locErr) {
      if (fromBlur) {
        ui.editingLocationIp = null;
      }
      setCardError(ip, locErr);
      if (!fromBlur) {
        const input = document.querySelector(`.device-card[data-ip="${CSS.escape(ip)}"] .loc-input`);
        if (input) {
          input.classList.add('is-invalid');
          input.focus();
        }
      }
      refreshDeviceAfterError(ip);
      return;
    }

    const current = (ui.snap?.devices || []).find((d) => d.ip === ip)?.location || '';
    ui.editingLocationIp = null;
    if (location === current) {
      renderDevices();
      return;
    }

    clearCardError(ip);
    ui.savingLocationIp = ip;
    renderDevices();
    try {
      await apiPost('/api/location', { ip, location });
      ui.savingLocationIp = null;
      await pollOnce(true);
    } catch (err) {
      ui.savingLocationIp = null;
      setCardError(ip, err.message);
      refreshDeviceAfterError(ip);
    }
  }

  function cancelEditLocation() {
    ui.editingLocationIp = null;
    renderDevices();
  }

  // ---------- Open Device URLs (`/` and `/config/`) ----------
  async function openDevicePath(ip, subPath, fallbackUrl) {
    if (window.parent && window.parent !== window) {
      try {
        await apiPost('/api/open', { ip, path: subPath });
        return;
      } catch {
        // Fallback to window.open below
      }
    }
    window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
  }

  // ---------- Rendering ----------
  function renderHeader() {
    if (!ui.snap) return;
    const { scanConfig, activeScan, lastScanAt, lastScanDurationMs, devices = [] } = ui.snap;

    if (!ui.rangeInitialized && scanConfig) {
      ui.rangeInitialized = true;
      applyScanConfigToInputs(scanConfig);
    }

    const onlineCount = devices.filter((d) => d.status === 'online').length;
    const rebootingCount = devices.filter((d) => d.status === 'rebooting').length;

    const badge = $('summary-badge');
    if (activeScan?.running) {
      const verb = activeScan.mode === 'refresh' ? 'Refreshing' : 'Scanning';
      badge.textContent = `${verb} ${activeScan.scanned}/${activeScan.total}`;
    } else if (devices.length === 0 && !lastScanAt) {
      badge.textContent = 'Ready';
    } else {
      const parts = [`${onlineCount} online`];
      if (rebootingCount > 0) parts.push(`${rebootingCount} rebooting`);
      if (devices.length > onlineCount + rebootingCount) {
        parts.push(`${devices.length - onlineCount - rebootingCount} offline`);
      }
      badge.textContent = parts.join(' · ');
    }

    $('last-scan').textContent = activeScan?.running && activeScan.mode !== 'refresh'
      ? `Found ${activeScan.foundCount} so far…`
      : formatTimeAgoOrClock(lastScanAt, lastScanDurationMs);

    const scanBtn = $('scan-btn');
    const scanLabel = $('scan-btn-label');
    const countdownBar = $('scan-countdown-bar');
    const progWrap = $('scan-progress-wrap');
    const progBar = $('scan-progress-bar');

    if (activeScan?.running) {
      if (ui.scanArmed) {
        stopScanArmTimers();
        ui.scanArmed = null;
      }
      scanBtn.disabled = true;
      scanBtn.classList.add('scanning');
      scanBtn.classList.remove('is-armed');
      if (countdownBar) countdownBar.style.transform = 'scaleX(0)';
      const pct = activeScan.total > 0 ? Math.round((activeScan.scanned / activeScan.total) * 100) : 0;
      scanLabel.textContent = `${pct}%`;
      progWrap.classList.add('is-active');
      progBar.style.width = `${pct}%`;
    } else if (ui.scanArmed && devices.length > 0) {
      scanBtn.disabled = false;
      scanBtn.classList.remove('scanning');
      scanBtn.classList.add('is-armed');
      scanLabel.textContent = 'Re-scan';
      const ratio = Math.max(0, Math.min(1, (ui.scanArmed.expiresAt - performance.now()) / ui.scanArmed.ttlMs));
      if (countdownBar) countdownBar.style.transform = `scaleX(${ratio.toFixed(4)})`;
      progWrap.classList.remove('is-active');
      progBar.style.width = '0%';
    } else {
      if (ui.scanArmed) {
        stopScanArmTimers();
        ui.scanArmed = null;
      }
      scanBtn.disabled = false;
      scanBtn.classList.remove('scanning', 'is-armed');
      if (countdownBar) countdownBar.style.transform = 'scaleX(0)';
      scanLabel.textContent = devices.length > 0 ? 'Refresh' : 'Scan';
      progWrap.classList.remove('is-active');
      progBar.style.width = '0%';
      if (activeScan?.error) {
        showToast(activeScan.error);
      }
    }
  }

  function buildCardHtml(dev) {
    const isEditingNick = ui.editingIp === dev.ip;
    const isEditingLoc = dev.supportsDiscover && ui.editingLocationIp === dev.ip;
    const isSavingLoc = dev.supportsDiscover && ui.savingLocationIp === dev.ip;

    const hasLatency = dev.status === 'online' && typeof dev.latencyMs === 'number';
    const statusClass =
      dev.status === 'online'
        ? 'status-online'
        : dev.status === 'rebooting'
        ? 'status-rebooting'
        : 'status-offline';
    const statusLabel =
      dev.status === 'online'
        ? (hasLatency ? `${dev.latencyMs}ms` : 'Online')
        : dev.status === 'rebooting'
        ? 'Rebooting…'
        : 'Offline';
    const statusTitle =
      dev.status === 'online'
        ? `Online${hasLatency ? ` (${dev.latencyMs}ms)` : ''} — Click to open ${dev.url}`
        : `Status: ${statusLabel} — Click to open ${dev.url}`;

    const nickEditIconSvg = `<svg class="nick-edit-icon" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
    const locEditIconSvg = `<svg class="loc-edit-icon" width="10.5" height="10.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
    const mapPinSvg = `<svg class="loc-pin-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 14.2s4.5-4.15 4.5-7.7a4.5 4.5 0 1 0-9 0c0 3.55 4.5 7.7 4.5 7.7z" fill="color-mix(in srgb, currentColor 18%, transparent)" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/>
      <circle cx="8" cy="6.5" r="1.5" fill="currentColor"/>
    </svg>`;

    let locHtml = '';
    if (dev.supportsDiscover) {
      if (isEditingLoc) {
        const locErr = validateLocation(String(ui.editingLocationDraft ?? '').trim());
        locHtml = `<span class="loc-editor">
          ${mapPinSvg}
          <input type="text" class="loc-input ${locErr ? 'is-invalid' : ''}" value="${esc(ui.editingLocationDraft)}" placeholder="(location)" maxlength="64" aria-label="Device location">
        </span>`;
      } else if (isSavingLoc) {
        locHtml = `<button type="button" class="loc-btn" disabled>
          ${mapPinSvg}
          <span class="loc-text">Saving…</span>
        </button>`;
      } else if (dev.location) {
        const locTitle = dev.online
          ? 'Click to update location'
          : 'Bring device online to update location';
        locHtml = `<button type="button" class="loc-btn" data-action="edit-loc" ${dev.online ? '' : 'disabled'} title="${esc(locTitle)}">
          ${mapPinSvg}
          <span class="loc-text">${esc(dev.location)}</span>
          ${dev.online ? locEditIconSvg : ''}
        </button>`;
      } else {
        const offlineTitleAttr = dev.online ? '' : ' title="Bring device online to set location"';
        locHtml = `<button type="button" class="loc-btn is-empty" data-action="edit-loc" ${dev.online ? '' : 'disabled'}${offlineTitleAttr}>
          ${mapPinSvg}
          <span class="loc-text">Set location…</span>
          ${dev.online ? locEditIconSvg : ''}
        </button>`;
      }
    }

    let topTitleHtml = '';
    if (isEditingNick) {
      topTitleHtml = `<input type="text" class="nick-input" value="${esc(ui.editingDraft)}" placeholder="(local nick name)" maxlength="64" aria-label="Local nick name">${locHtml}`;
    } else if (dev.supportsDiscover) {
      const hostLabel = dev.hostname || 'ZWAppliance';
      const innerLabelHtml = dev.nickname
        ? `<span class="nick-primary">${esc(dev.nickname)}</span>`
        : `<span class="nick-host-prefix">Host name:</span><span class="nick-primary is-host">${esc(hostLabel)}</span>`;
      const nickTitle = dev.nickname
        ? 'Click to update nick name'
        : 'Click to set local nick name';
      topTitleHtml = `<button type="button" class="nick-display" data-action="edit-nick" title="${nickTitle}">
        ${innerLabelHtml}
        ${nickEditIconSvg}
      </button>${locHtml}`;
    } else {
      const legacyTitleAttr = dev.nickname ? ' title="Click to update nick name"' : '';
      topTitleHtml = `<button type="button" class="nick-display ${dev.nickname ? '' : 'is-empty'}" data-action="edit-nick"${legacyTitleAttr}>
        <span class="nick-primary">${dev.nickname ? esc(dev.nickname) : 'Set nickname…'}</span>
        ${nickEditIconSvg}
      </button>`;
    }

    const projBadge = dev.project
      ? `<span class="proj-badge">${esc(dev.project)}</span>`
      : `<span class="proj-badge is-unknown">Unknown</span>`;

    const verHtml = dev.version ? `<span class="ver-text">v${esc(dev.version)}</span>` : '';
    const buildHtml = dev.buildTime ? `<span class="build-text">(${esc(dev.buildTime)})</span>` : '';
    const nextHtml = dev.nextBootPending
      ? `<span class="next-badge" title="Staged OTA image will boot after reboot">next: ${esc(dev.nextProject || 'alt')} ${esc(dev.nextVersion || '')}</span>`
      : '';

    // Configure + Reboot button states
    const cfgDisabled = dev.status !== 'online';
    const armedForThis = ui.armed?.ip === dev.ip ? ui.armed : null;
    let rebLabel = 'Reboot';
    let rebDisabled = dev.status !== 'online';
    let rebExtraClass = '';
    let initialScale = 0;

    if (dev.status === 'rebooting' || armedForThis?.phase === 'submitting') {
      rebLabel = 'Rebooting…';
      rebDisabled = true;
    } else if (armedForThis?.phase === 'arming') {
      rebLabel = 'Checking…';
      rebDisabled = true;
    } else if (armedForThis?.phase === 'armed') {
      rebLabel = 'Confirm';
      rebDisabled = false;
      rebExtraClass = 'is-armed';
      initialScale = Math.max(0, Math.min(1, (armedForThis.expiresAt - performance.now()) / armedForThis.ttlMs));
    }

    const cardErr = ui.cardErrors[dev.ip] || null;
    let cardErrorHtml = '';
    if (cardErr) {
      const errScale = Math.max(0, Math.min(1, (cardErr.expiresAt - performance.now()) / cardErr.ttlMs));
      cardErrorHtml = `<div class="card-error" role="alert">
          <span class="card-error-text">${esc(cardErr.message)}</span>
          <button type="button" class="card-error-close" data-action="dismiss-card-error" aria-label="Dismiss error">×</button>
          <span class="card-error-bar" style="transform: scaleX(${errScale.toFixed(4)})"></span>
        </div>`;
    }

    const cardClasses = [
      'device-card',
      dev.status === 'offline' ? 'is-offline' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${cardClasses}" data-ip="${esc(dev.ip)}" role="listitem">
        <div class="device-card-top">
          <div class="nick-wrap">${topTitleHtml}</div>
          <a
            href="${esc(dev.url)}"
            target="_blank"
            rel="noopener noreferrer"
            class="status-link ${statusClass}"
            data-action="open-root"
            title="${esc(statusTitle)}"
          >
            <span class="status-dot" aria-hidden="true"></span>
            <span class="status-state ${hasLatency ? 'is-latency' : ''}">${esc(statusLabel)}</span>
            <span class="status-ip">${esc(dev.ip)}</span>
            <span class="status-ext" aria-hidden="true">↗</span>
          </a>
        </div>
        <div class="device-card-bottom">
          <div class="fw-meta">
            ${projBadge}
            ${verHtml}
            ${buildHtml}
            ${nextHtml}
          </div>
          <div class="card-actions">
            <button
              type="button"
              class="config-btn"
              data-action="open-config"
              ${cfgDisabled ? 'disabled' : ''}
            >Configure</button>
            <button
              type="button"
              class="reboot-btn ${rebExtraClass}"
              data-action="reboot"
              ${rebDisabled ? 'disabled' : ''}
              title="${armedForThis?.phase === 'armed' ? 'Click again before timeout to confirm reboot' : `Reboot ${esc(dev.ip)}`}"
            >
              <span class="reboot-btn-sizer" aria-hidden="true">Rebooting…</span>
              <span class="reboot-btn-label">${rebLabel}</span>
              <span class="reboot-countdown-bar" style="transform: scaleX(${initialScale.toFixed(4)})"></span>
            </button>
          </div>
        </div>
        ${cardErrorHtml}
      </div>
    `;
  }

  function renderDevices() {
    if (!ui.snap) return;
    const devices = ui.snap.devices || [];
    const emptyEl = $('empty-state');
    const listEl = $('device-list');

    if (devices.length === 0) {
      emptyEl.classList.remove('hidden');
      listEl.classList.add('hidden');
      listEl.innerHTML = '';
      return;
    }

    emptyEl.classList.add('hidden');
    listEl.classList.remove('hidden');

    // Preserve active inline input cursor/value across live background updates
    const activeNickInput = ui.editingIp
      ? listEl.querySelector(`.device-card[data-ip="${CSS.escape(ui.editingIp)}"] .nick-input`)
      : null;
    const nickSelStart = activeNickInput ? activeNickInput.selectionStart : null;
    const nickSelEnd = activeNickInput ? activeNickInput.selectionEnd : null;
    if (activeNickInput) {
      ui.editingDraft = activeNickInput.value;
    }

    const activeLocInput = ui.editingLocationIp
      ? listEl.querySelector(`.device-card[data-ip="${CSS.escape(ui.editingLocationIp)}"] .loc-input`)
      : null;
    const locSelStart = activeLocInput ? activeLocInput.selectionStart : null;
    const locSelEnd = activeLocInput ? activeLocInput.selectionEnd : null;
    if (activeLocInput) {
      ui.editingLocationDraft = activeLocInput.value;
    }

    listEl.innerHTML = devices.map(buildCardHtml).join('');

    if (ui.editingIp) {
      const restored = listEl.querySelector(`.device-card[data-ip="${CSS.escape(ui.editingIp)}"] .nick-input`);
      if (restored) {
        restored.focus();
        if (nickSelStart !== null && nickSelEnd !== null) {
          restored.setSelectionRange(nickSelStart, nickSelEnd);
        }
      }
    } else if (ui.editingLocationIp) {
      const restored = listEl.querySelector(`.device-card[data-ip="${CSS.escape(ui.editingLocationIp)}"] .loc-input`);
      if (restored) {
        restored.focus();
        if (locSelStart !== null && locSelEnd !== null) {
          restored.setSelectionRange(locSelStart, locSelEnd);
        }
      }
    }
  }

  // Event delegation on device list
  const listEl = $('device-list');

  listEl.addEventListener('click', (e) => {
    const card = e.target.closest('.device-card');
    if (!card) return;
    const ip = card.dataset.ip;

    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'edit-nick') {
      const dev = (ui.snap?.devices || []).find((d) => d.ip === ip);
      beginEditNickname(ip, dev?.nickname || '');
    } else if (action === 'edit-loc') {
      const dev = (ui.snap?.devices || []).find((d) => d.ip === ip);
      beginEditLocation(dev);
    } else if (action === 'open-root') {
      e.preventDefault();
      openDevicePath(ip, '/', actionEl.getAttribute('href') || `http://${ip}/`);
    } else if (action === 'open-config') {
      openDevicePath(ip, '/config/', `http://${ip}/config/`);
    } else if (action === 'reboot') {
      handleRebootButtonClick(ip);
    } else if (action === 'dismiss-card-error') {
      clearCardError(ip);
    }
  });

  listEl.addEventListener('input', (e) => {
    if (e.target.classList.contains('nick-input')) {
      ui.editingDraft = e.target.value;
    } else if (e.target.classList.contains('loc-input')) {
      ui.editingLocationDraft = e.target.value;
      const locErr = validateLocation(e.target.value.trim());
      e.target.classList.toggle('is-invalid', Boolean(locErr));
    }
  });

  listEl.addEventListener('keydown', (e) => {
    const card = e.target.closest('.device-card');
    if (!card) return;

    if (e.target.classList.contains('nick-input')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitNickname(card.dataset.ip, e.target.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEditNickname();
      }
      return;
    }

    if (e.target.classList.contains('loc-input')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitLocation(card.dataset.ip, e.target.value, { fromBlur: false });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEditLocation();
      }
    }
  });

  listEl.addEventListener('focusout', (e) => {
    const isNick = e.target.classList.contains('nick-input');
    const isLoc = e.target.classList.contains('loc-input');
    if (!isNick && !isLoc) return;
    const card = e.target.closest('.device-card');
    if (!card) return;
    const ip = card.dataset.ip;
    const val = e.target.value;
    // Defer slightly so Escape keydown can cancel cleanly before blur commits
    setTimeout(() => {
      if (isNick && ui.editingIp === ip) {
        commitNickname(ip, val);
      } else if (isLoc && ui.editingLocationIp === ip) {
        commitLocation(ip, val, { fromBlur: true });
      }
    }, 80);
  });

  // ---------- Polling Loop & Panel Re-open Detection ----------
  let pollTimer = null;

  function computePollDelayMs() {
    if (!ui.snap) return IDLE_POLL_MS;
    if (ui.snap.activeScan?.running) {
      return ui.snap.activeScan.mode === 'refresh' ? REFRESH_POLL_MS : FAST_POLL_MS;
    }
    if ((ui.snap.devices || []).some((d) => d.status === 'rebooting')) {
      return FAST_POLL_MS;
    }
    return IDLE_POLL_MS;
  }

  function reschedulePollLoop() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(scheduleNextPoll, computePollDelayMs());
  }

  async function pollOnce(force = false) {
    try {
      const query = !force && ui.etag ? `?etag=${encodeURIComponent(ui.etag)}` : '';
      const data = await apiGet(`/api/state${query}`);
      if (!data.unchanged) {
        ui.etag = data.etag || '';
        ui.snap = data;
        let hasNewBackendError = false;
        for (const dev of data.devices || []) {
          if (dev.rebootError?.id && ui.seenRebootErrorIds[dev.ip] !== dev.rebootError.id) {
            ui.seenRebootErrorIds[dev.ip] = dev.rebootError.id;
            setCardError(dev.ip, dev.rebootError.message);
            refreshDeviceAfterError(dev.ip);
            hasNewBackendError = true;
          }
        }
        renderHeader();
        if (!hasNewBackendError) {
          renderDevices();
        }
        if (!ui.initialRefreshDone) {
          ui.initialRefreshDone = true;
          if ((data.devices || []).length > 0 && !data.activeScan?.running) {
            void triggerRefreshEntries('panel-open');
          }
        }
      }
    } catch (err) {
      console.warn('[zw_scanner] poll error:', err.message);
    }
  }

  async function scheduleNextPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    await pollOnce(false);
    reschedulePollLoop();
  }

  function isPanelCurrentlyVisible() {
    return (
      document.visibilityState !== 'hidden' &&
      window.innerWidth > 0 &&
      window.innerHeight > 0 &&
      ui.isIntersecting !== false
    );
  }

  function handlePanelVisibilityUpdate() {
    if (!isPanelCurrentlyVisible()) {
      ui.panelWasHidden = true;
      return;
    }
    if (ui.panelWasHidden) {
      ui.panelWasHidden = false;
      if ((ui.snap?.devices || []).length > 0 && !ui.snap?.activeScan?.running) {
        void triggerRefreshEntries('panel-open');
      } else {
        void pollOnce(true).then(reschedulePollLoop);
      }
    }
  }

  document.addEventListener('visibilitychange', handlePanelVisibilityUpdate);
  window.addEventListener('resize', handlePanelVisibilityUpdate);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(handlePanelVisibilityUpdate).observe(document.documentElement);
  }
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      if (entries.length > 0) {
        ui.isIntersecting = entries[entries.length - 1].isIntersecting;
        handlePanelVisibilityUpdate();
      }
    }).observe(document.documentElement);
  }

  if (!isPanelCurrentlyVisible()) {
    ui.panelWasHidden = true;
  }

  scheduleNextPoll();
})();
