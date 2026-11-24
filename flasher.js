// Reads which XCSoar firmware a board has from its flash, and writes the matching image from firmware/manifest.json.

import { ESPLoader, Transport } from "./vendor/esptool-js-0.7.1/bundle.js";

const ESPRESSIF_VID = 0x303a;
// The USB Serial/JTAG port ignores the baud rate; at the ROM's rate, esptool-js does not reopen the port
const BAUD_RATE = 115200;
// Stub commands that esptool-js does not send before a read, as esptool.py does
const ESP_SPI_SET_PARAMS = 0x0b;
const ESP_SPI_ATTACH = 0x0d;
const ESP_READ_FLASH = 0xd2;
// Small packets, one at a time: the stub drops the rest of a large packet when the browser is slow to fetch it
const READ_BLOCK_SIZE = 256;
const READ_MAX_IN_FLIGHT = 1;
const READ_TIMEOUT_MS = 5000;
const FLASH_SIZE = 16 * 1024 * 1024;
const TRACE_LIMIT = 160;
const PARTITION_TABLE_OFFSET = 0x8000;
const PARTITION_TABLE_SIZE = 0xc00;
const PARTITION_ENTRY_SIZE = 32;
const PARTITION_MAGIC = 0x50aa;
const TYPE_APP = 0x00;
const TYPE_DATA = 0x01;
const SUBTYPE_FACTORY = 0x00;
const SUBTYPE_OTA_FIRST = 0x10;
const SUBTYPE_OTA_LAST = 0x1f;
const SUBTYPE_OTADATA = 0x00;
const OTADATA_SECTOR = 0x1000;
const OTA_SELECT_SIZE = 32;
// esp_ota_img_states_t: an image the bootloader will not start
const OTA_STATE_INVALID = 3;
const OTA_STATE_ABORTED = 4;
const IMAGE_MAGIC = 0xe9;
// esp_app_desc_t follows the image header (24 bytes) and the first segment header (8 bytes)
const APP_DESC_OFFSET = 32;
const APP_DESC_SIZE = 256;
const APP_DESC_MAGIC = 0xabcd5432;

const $ = (id) => document.getElementById(id);

const log = (text) => {
  const pre = $("log");
  pre.textContent += text;
  pre.scrollTop = pre.scrollHeight;
};

const terminal = {
  clean() {},
  writeLine(data) {
    log(`${data}\n`);
  },
  write(data) {
    log(data);
  },
};

let manifest = null;
let transport = null;
let loader = null;
// What the board has now: { deviceName, elfSha256, esphomeVersion } or null
let installed = null;

function show(...ids) {
  for (const id of ["steps", "device", "progress", "done", "failed"])
    $(id).hidden = !ids.includes(id);
}

function fail(error) {
  console.error(error);
  log(`\nError: ${error?.message ?? error}\n`);
  $("failed-text").textContent = error?.message ?? String(error);
  show("failed");
  disconnect();
}

async function disconnect() {
  const t = transport;
  transport = null;
  loader = null;
  if (t !== null) {
    try {
      await t.disconnect();
    } catch (error) {
      console.warn(error);
    }
  }
}

function text(bytes, start, size) {
  const slice = bytes.subarray(start, start + size);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end));
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// esptool-js leaves the MD5 digest the stub sends after the data unread, and the next command then reads it as its
// answer; read it here and check the data against it
const DIGEST_SIZE = 16;
const DIGEST_TIMEOUT_MS = 3000;

const RESET_PULSE_MS = 100;

// esptool.py's hard reset: RTS high, then low. esptool-js 0.7.1 only sets it low, which does not reset the board
async function hardReset() {
  await transport.setDTR(false);
  await transport.setRTS(true);
  await new Promise((resolve) => setTimeout(resolve, RESET_PULSE_MS));
  await transport.setRTS(false);
}

function words(...values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value, true));
  return bytes;
}

// Attach the SPI flash and give the stub its size, as esptool.py does before it reads
async function prepareFlash() {
  await loader.checkCommand("attach SPI flash", ESP_SPI_ATTACH, words(0));
  await loader.checkCommand("set SPI flash parameters", ESP_SPI_SET_PARAMS,
    words(0, FLASH_SIZE, 64 * 1024, 4 * 1024, 256, 0xffff));
}

// esptool.py's READ_FLASH, with its block size and number of packets in flight
async function readFlash(address, size) {
  const result = await loader.checkCommand("read flash", ESP_READ_FLASH,
    words(address, size, READ_BLOCK_SIZE, READ_MAX_IN_FLIGHT));
  if (result !== 0 && !(result instanceof Uint8Array))
    throw new Error(`Reading the flash failed (${result}).`);
  const data = new Uint8Array(size);
  let received = 0;
  while (received < size) {
    const packet = await loader.transport.read(READ_TIMEOUT_MS);
    if (received + packet.length > size)
      throw new Error("Reading the flash failed: more data than asked for.");
    data.set(packet, received);
    received += packet.length;
    await loader.transport.write(words(received));
  }
  const digest = await loader.transport.read(DIGEST_TIMEOUT_MS);
  if (!(digest instanceof Uint8Array) || digest.length !== DIGEST_SIZE)
    throw new Error("Reading the flash failed: no checksum after the data.");
  if (hex(digest) !== md5(data))
    throw new Error("Reading the flash failed: wrong checksum.");
  return data;
}

// MD5 (RFC 1321), only for checking the small reads above
function md5(bytes) {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++)
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const r = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const length = bytes.length;
  const padded = new Uint8Array(((length + 8) >> 6) * 64 + 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(length / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const shift = r[(i >> 4) * 4 + (i % 4)];
      const sum = (a + f + k[i] + view.getUint32(chunk + g * 4, true)) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((word, i) => outView.setUint32(i * 4, word, true));
  return hex(out);
}

function parsePartitions(table) {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const partitions = [];
  for (let i = 0; i + PARTITION_ENTRY_SIZE <= table.length; i += PARTITION_ENTRY_SIZE) {
    if (view.getUint16(i, true) !== PARTITION_MAGIC)
      break;
    partitions.push({
      type: table[i + 2],
      subtype: table[i + 3],
      offset: view.getUint32(i + 4, true),
      size: view.getUint32(i + 8, true),
      label: text(table, i + 12, 16),
    });
  }
  return partitions;
}

// The app partition the bootloader starts: the OTA slot with the highest valid sequence number, else the first one
async function activeApp(partitions) {
  const ota = partitions.filter(
    (p) => p.type === TYPE_APP && p.subtype >= SUBTYPE_OTA_FIRST && p.subtype <= SUBTYPE_OTA_LAST);
  const factory = partitions.find((p) => p.type === TYPE_APP && p.subtype === SUBTYPE_FACTORY);
  const otadata = partitions.find((p) => p.type === TYPE_DATA && p.subtype === SUBTYPE_OTADATA);
  if (ota.length === 0)
    return factory ?? null;
  if (otadata === undefined)
    return factory ?? ota[0];

  let best = 0;
  for (const sector of [0, OTADATA_SECTOR]) {
    const entry = await readFlash(otadata.offset + sector, OTA_SELECT_SIZE);
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    const seq = view.getUint32(0, true);
    const state = view.getUint32(24, true);
    if (seq === 0xffffffff || seq === 0 || state === OTA_STATE_INVALID || state === OTA_STATE_ABORTED)
      continue;
    best = Math.max(best, seq);
  }
  if (best === 0)
    return factory ?? ota[0];
  return ota[(best - 1) % ota.length];
}

async function readInstalled() {
  log("Reading the partition table\n");
  const table = await readFlash(PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE);
  const partitions = parsePartitions(table);
  if (partitions.length === 0)
    return null;
  log("Reading which app partition starts\n");
  const app = await activeApp(partitions);
  if (app === null)
    return null;
  log(`Reading the app header in ${app.label}\n`);
  const header = await readFlash(app.offset, APP_DESC_OFFSET + APP_DESC_SIZE);
  const desc = header.subarray(APP_DESC_OFFSET);
  const view = new DataView(desc.buffer, desc.byteOffset, desc.byteLength);
  if (header[0] !== IMAGE_MAGIC || view.getUint32(0, true) !== APP_DESC_MAGIC)
    return null;
  return {
    esphomeVersion: text(desc, 16, 32),
    deviceName: text(desc, 48, 32),
    elfSha256: hex(desc.subarray(144, 176)),
  };
}

function selectedBuild() {
  return manifest.builds.find((b) => b.variant === $("variant").value) ?? null;
}

function updateSelection() {
  const build = selectedBuild();
  $("variant-description").textContent = build?.description ?? "";
  const matches = installed !== null && build !== null && build.device_name === installed.deviceName;
  const known = installed !== null && manifest.builds.some((b) => b.device_name === installed.deviceName);
  $("variant-warning").hidden = build === null || !known || matches;
  $("install").disabled = build === null;
  if (build === null) {
    $("latest").textContent = "Choose the model of your device.";
  } else if (matches && build.elf_sha256 === installed.elfSha256) {
    $("latest").textContent = `The device already has this version (${build.version}). Installing it again does no harm.`;
  } else {
    $("latest").textContent = `Version ${build.version} will be installed.`;
  }
}

function fillVariants() {
  const select = $("variant");
  select.replaceChildren();
  const known = installed !== null ? manifest.builds.find((b) => b.device_name === installed.deviceName) : undefined;
  if (known === undefined) {
    const prompt = new Option("Choose your device", "");
    prompt.disabled = true;
    prompt.selected = true;
    select.add(prompt);
  }
  for (const build of manifest.builds)
    select.add(new Option(build.title, build.variant, false, build === known));
  updateSelection();
}

async function connect() {
  $("log").textContent = "";
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
  } catch {
    // Closed without choosing a device
    return;
  }

  try {
    $("connect").disabled = true;
    $("connect").textContent = "Connecting...";
    transport = new Transport(port, true);
    transport.trace = (message) => log(`  ${message.slice(0, TRACE_LIMIT)}\n`);
    loader = new ESPLoader({ transport, baudrate: BAUD_RATE, romBaudrate: BAUD_RATE, terminal });
    const chip = await loader.main();
    log("Attaching the flash\n");
    await prepareFlash();
    if (loader.chip.CHIP_NAME !== "ESP32-P4")
      throw new Error(`This device has an ${loader.chip.CHIP_NAME}; the firmware here is for the ESP32-P4.`);
    $("chip").textContent = chip;

    installed = await readInstalled();
    // Tracing the 6 MB write would slow it down and fill the log
    transport.tracing = false;
    const known = installed !== null ? manifest.builds.find((b) => b.device_name === installed.deviceName) : undefined;
    if (known !== undefined)
      $("installed").textContent = `XCSoar for the ${known.title}`;
    else if (installed !== null)
      $("installed").textContent = `Other firmware ("${installed.deviceName}")`;
    else
      $("installed").textContent = "No firmware found";
    fillVariants();
    show("device");
  } catch (error) {
    fail(error);
  } finally {
    $("connect").disabled = false;
    $("connect").textContent = "Connect";
  }
}

async function download(build) {
  $("progress-title").textContent = "Downloading";
  const response = await fetch(`firmware/${build.file}`, { cache: "no-cache" });
  if (!response.ok)
    throw new Error(`Downloading the firmware failed (HTTP ${response.status}).`);
  const reader = response.body.getReader();
  const image = new Uint8Array(build.size);
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done)
      break;
    if (received + value.length > image.length)
      throw new Error("The downloaded firmware is larger than expected.");
    image.set(value, received);
    received += value.length;
    $("progress-bar").value = (100 * received) / build.size;
  }
  if (received !== build.size)
    throw new Error("The downloaded firmware is incomplete.");
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", image)));
  if (digest !== build.sha256)
    throw new Error("The downloaded firmware is damaged (wrong checksum).");
  return image;
}

async function install() {
  const build = selectedBuild();
  if (build === null)
    return;
  try {
    show("progress");
    $("progress-bar").value = 0;
    $("progress-text").textContent = "Do not unplug the device.";
    const image = await download(build);

    $("progress-title").textContent = "Installing";
    $("progress-bar").value = 0;
    await loader.writeFlash({
      fileArray: [{ data: image, address: 0 }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_index, written, total) => {
        $("progress-bar").value = (100 * written) / total;
      },
    });
    $("progress-title").textContent = "Restarting";
    log("Restarting the device\n");
    await hardReset();
    await disconnect();
    show("done");
  } catch (error) {
    fail(error);
  }
}

async function start() {
  if (!("serial" in navigator)) {
    $("unsupported").hidden = false;
    $("steps").hidden = true;
    return;
  }
  try {
    const response = await fetch("firmware/manifest.json", { cache: "no-cache" });
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`);
    manifest = await response.json();
  } catch (error) {
    fail(new Error(`The list of firmware could not be loaded (${error.message}).`));
    return;
  }
  $("connect").disabled = false;
}

$("connect").addEventListener("click", connect);
$("variant").addEventListener("change", updateSelection);
$("install").addEventListener("click", install);
$("disconnect").addEventListener("click", async () => {
  // Left alone, the board would stay in its bootloader until it is unplugged
  try {
    if (transport !== null)
      await hardReset();
  } catch (error) {
    console.warn(error);
  }
  await disconnect();
  show("steps");
});
$("copy-log").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("log").textContent);
    $("copy-log").textContent = "Copied";
  } catch {
    $("copy-log").textContent = "Copy failed";
  }
  setTimeout(() => {
    $("copy-log").textContent = "Copy all";
  }, 2000);
});
$("again").addEventListener("click", () => show("steps"));
$("retry").addEventListener("click", () => show("steps"));
start();
