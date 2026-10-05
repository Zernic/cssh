'use strict';

// Native acrylic blur-behind, the way Windhawk's Translucent Windows mod does
// it: the undocumented SetWindowCompositionAttribute with
// ACCENT_ENABLE_ACRYLICBLURBEHIND. Unlike DWM's modern backdrop types, this one
// takes the tint colour AND alpha from us, which is what makes it read as light
// glass instead of a dark slab. DWM blurs live, so every window behind shows
// through, on every monitor, with nothing to capture or keep in sync.
//
// Structures are marshalled by hand into Buffers — only plain integers and one
// buffer pointer cross the boundary, so there is nothing exotic to get wrong.
//
// The accent policy alone is enough here: Windhawk pairs it with
// DwmEnableBlurBehindWindow because it targets ordinary opaque windows, but
// ours is already a layered transparent window, and the extra call only adds a
// second DWM effect to argue with this one.

const koffi = require('koffi');

const WCA_ACCENT_POLICY = 19;
const ACCENT_DISABLED = 0;
const ACCENT_ENABLE_BLURBEHIND = 3;
const ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;

let api;

function load() {
  if (api !== undefined) return api;
  try {
    const user32 = koffi.load('user32.dll');

    api = {
      setComposition: user32.func(
        'int __stdcall SetWindowCompositionAttribute(uint64 hwnd, void *data)'
      ),
    };
  } catch (e) {
    console.error('cssh: window composition unavailable —', e.message);
    api = null;
  }
  return api;
}

// koffi hands back uint64 as a Number when it fits and a BigInt when it does
// not; Buffer.writeBigUInt64LE insists on BigInt either way.
function big(value) {
  return typeof value === 'bigint' ? value : BigInt(value || 0);
}

function handleOf(win) {
  try {
    const buffer = win.getNativeWindowHandle();
    return buffer.length === 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0));
  } catch {
    return null;
  }
}

// DWM wants the tint as 0xAABBGGRR — alpha first, then the colour byte-reversed.
function gradientColor(hex, alpha) {
  const clean = String(hex || '232323').replace(/^#/, '');
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  const a = Math.max(0, Math.min(255, Math.round((alpha != null ? alpha : 0.23) * 255)));
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function setAccent(hwnd, state, gradient) {
  const lib = load();
  if (!lib || hwnd === null) return false;

  // ACCENT_POLICY { int AccentState; int AccentFlags; DWORD GradientColor; int AnimationId; }
  const policy = Buffer.alloc(16);
  policy.writeInt32LE(state, 0);
  policy.writeInt32LE(0, 4);
  policy.writeUInt32LE(gradient >>> 0, 8);
  policy.writeInt32LE(0, 12);

  // WINCOMPATTRDATA { DWORD Attrib; PVOID pvData; SIZE_T cbData; } — 8-byte aligned.
  const data = Buffer.alloc(24);
  data.writeInt32LE(WCA_ACCENT_POLICY, 0);
  data.writeBigUInt64LE(BigInt(koffi.address(policy)), 8);
  data.writeBigUInt64LE(16n, 16);

  try {
    lib.setComposition(big(hwnd), data);
    return true;
  } catch (e) {
    console.error('cssh: SetWindowCompositionAttribute failed —', e.message);
    return false;
  }
}

function available() {
  return !!load();
}

// tint: { color: "232323", alpha: 0..1, acrylic: bool }
function apply(win, tint) {
  const hwnd = handleOf(win);
  if (hwnd === null) return false;

  return setAccent(
    hwnd,
    tint && tint.acrylic === false ? ACCENT_ENABLE_BLURBEHIND : ACCENT_ENABLE_ACRYLICBLURBEHIND,
    gradientColor(tint && tint.color, tint && tint.alpha)
  );
}

function clear(win) {
  const hwnd = handleOf(win);
  if (hwnd === null) return false;
  return setAccent(hwnd, ACCENT_DISABLED, 0);
}

module.exports = { apply, clear, available, gradientColor };
