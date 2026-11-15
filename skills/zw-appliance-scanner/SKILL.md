---
name: zw-appliance-scanner
description: Discover, inspect, and open the ZW Appliances side panel for ESPZWApplianceT2 microcontroller devices on the local network. Activate when the user asks to open the ZW Appliances panel, find deployed ESP8266 / ESPZWApplianceT2 devices, check their firmware versions, or resolve device locations, hostnames, MAC addresses, or nicknames to IP addresses.
---

# ZW Appliance Scanner (`esp-zw-app-scanner`)

Provides an Auxiliary Side Pane UI (**ZW Appliances**), persisted device inventory, and a zero-dependency CLI subnet scanner for `ESPZWApplianceT2`-based microcontroller appliances across mixed firmware fleets.

---

## 1. Opening the Side Panel in Chat

To give the user a one-click pill to open or toggle the **ZW Appliances** Auxiliary Side Pane, emit this markdown link:

```markdown
[ZW Appliances](sidecar://esp-zw-app-scanner/scanner/)
```

---

## 2. Reading Persisted Device Inventory, Identities & Nicknames

The sidecar stores the configured scan range (`scanConfig`), local nicknames (`nicknames` + MAC-indexed `macNicknames`), and the most recent discovered device inventory (`knownDevices`) at:

`~/.gemini/antigravity/sidecar_data/esp-zw-app-scanner/scanner/data/state.json`
*(on Windows: `$HOME\.gemini\antigravity\sidecar_data\esp-zw-app-scanner\scanner\data\state.json`)*

Read this JSON file first whenever the user refers to a deployed appliance by its **location** (`location`), **hostname** (`hostname`), **MAC address** (`mac`), **nickname** (`nicknames[ip]` / `macNicknames[mac]`), or **firmware/project name** (`project`, e.g. `TWiLight`, `ESPClockMovementMod`, etc.).

- **Upgraded devices (`supportsDiscover: true`, `ESPZWApplianceT2 v1.1.11+`)**: Carry hardware-permanent `mac` (`XX:XX:XX:XX:XX:XX`), active `hostname` (custom or `<Appliance>-<6hex>` auto-derived), and on-device `location`. Automatically reconciled by `mac` (including any local `macNicknames[mac]`) if their DHCP IP changes.
- **Legacy devices (`supportsDiscover: false`, `<= v1.1.10`)**: Labelled via local IP-bound `nicknames[ip]`.

---

## 3. On-Demand CLI Subnet Scan (`scanner.mjs`)

Relative to this `SKILL.md` file (`<plugin-root>/skills/zw-appliance-scanner/SKILL.md`), the pure Node.js ESM scanner can also be invoked directly from a terminal when no inventory exists yet or when probing an explicit subnet/IP range:

```bash
# Auto-detect active /24 LAN prefix (or specify e.g. 192.168.1.0/24, 192.168.1.32-127, 192.168.1.50)
node "<plugin-root>/sidecars/scanner/scanner.mjs" 192.168.1.1-254
```

*(On Windows without a standalone `node` on `PATH`, run via Antigravity's bundled Node shim: `& "$env:APPDATA\Antigravity\bin\agy-node.cmd" "<plugin-root>\sidecars\scanner\scanner.mjs" 192.168.1.1-254`.)*

Outputs structured JSON (`{ scanConfig, count, elapsedMs, devices }`) to `stdout`.

---

## 4. Discovery & Identity Protocol Summary (`ESPZWApplianceT2`)

- **Fast-Path Discovery (`v1.1.11+`)**: `GET http://<ip>/!sys/discover` (`Connection: close`) returns `{ "boot_serial", "identity": { "mac", "hostname", "location" }, "firmware": { "name", "version", "build_time" } }` in a single lightweight RAM/DROM read.
- **On-Device Identity Config (`v1.1.11+`)**: `GET | PUT http://<ip>/!sys/config?section=identity` reads or updates `{ "hostname", "location" }` in `/storage/app_config.json` (empty `hostname: ""` restores automatic `<Appliance>-<6hex>` derivation).
- **Legacy Fallback (`<= v1.1.10`)**: When `/!sys/discover` returns `404`, falls back sequentially to `GET http://<ip>/!sys/boot_serial` (`8`-char uppercase hex) + `GET http://<ip>/!sys/ota/state` (element `[0]` is the currently running OTA slot).
- **Safety Rules**:
  - Never probe `/!sys/prov/sta.aplist` during discovery (triggers a blocking active Wi-Fi scan on the MCU).
  - Always serialize HTTP requests per IP with `Connection: close` so ESP8266 lwIP sockets are freed immediately.
