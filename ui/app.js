'use strict';

const api = window.cssh;
const FitAddonCtor = window.FitAddon.FitAddon;
const WebLinksAddonCtor = window.WebLinksAddon.WebLinksAddon;

const el = {
  app: document.getElementById('app'),
  title: document.getElementById('title'),
  bar: document.getElementById('bar'),
  term: document.getElementById('term'),
  status: document.getElementById('status'),
  veil: document.getElementById('veil'),
  label: document.getElementById('label'),
  input: document.getElementById('input'),
  ghostTyped: document.getElementById('ghost-typed'),
  ghostRest: document.getElementById('ghost-rest'),
  hosts: document.getElementById('hosts'),
  note: document.getElementById('note'),
  offer: document.getElementById('offer'),
  save: document.getElementById('save'),
  savebox: document.getElementById('savebox'),
};

// Neutral by design: greys carry no colour cast, and the ANSI colours are
// muted so nothing glares through the glass.
const THEME = {
  background: 'rgba(0, 0, 0, 0)',
  foreground: '#e4e4e6',
  cursor: '#d6d6d8',
  cursorAccent: '#161617',
  selectionBackground: 'rgba(255, 255, 255, 0.17)',
  black: '#3d3d40',
  red: '#e08d94',
  green: '#a8c99a',
  yellow: '#ddc18a',
  blue: '#9bb4d4',
  magenta: '#c0a3cd',
  cyan: '#93c4c4',
  white: '#d4d4d6',
  brightBlack: '#606064',
  brightRed: '#f0a5ab',
  brightGreen: '#c0dbb2',
  brightYellow: '#efd6a4',
  brightBlue: '#b6cbe6',
  brightMagenta: '#d5bce0',
  brightCyan: '#aedcdc',
  brightWhite: '#f3f3f4',
};

let config = {};
let term;
let fit;
let mode = 'target'; // target | waiting | ask | blocked | shell
let ask = null;
let hints = [];
let hosts = [];
let shown = [];
let pick = -1;
let query = '';      // what the host list is filtered by
let baseValue = '';  // what the box shows when no row is picked
let lastTarget = '';
let maximized = false;
let statusTimer = null;
let armed = false;      // remote is asking for a password we have saved
let remember = false;   // user asked to save the one they are typing

// ------------------------------------------------------------------- ui ----

function setStatus(text, kind) {
  el.status.textContent = text;
  el.status.classList.toggle('warn', kind === 'warn');
  el.status.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.status.classList.remove('show'), 2600);
}

function setVeil(next, { label = '', note = '', value = '', placeholder = '', secret = false, warn = false } = {}) {
  mode = next;
  el.label.textContent = label;
  el.note.innerHTML = note;
  el.note.classList.toggle('warn', warn);
  el.input.type = secret ? 'password' : 'text';
  el.input.placeholder = placeholder;
  el.input.value = value;
  el.input.disabled = next === 'waiting' || next === 'blocked';
  el.veil.classList.add('show');
  el.veil.classList.toggle('blocked', next === 'blocked');
  if (next !== 'ask') showSaveBox(false);
  el.app.classList.toggle('asking', el.app.classList.contains('live'));
  // Prefilling the box must not filter the list — you have just disconnected
  // and are most likely looking for a different host.
  baseValue = next === 'target' ? value : '';
  query = '';
  pick = -1;
  renderHosts();
  drawGhost();
  if (!el.input.disabled) {
    el.input.focus();
    el.input.select();
  }
}

function hideVeil() {
  mode = 'shell';
  ask = null;
  showSaveBox(false);
  el.veil.classList.remove('show', 'blocked');
  el.app.classList.remove('asking');
  el.input.value = '';
  query = '';
  baseValue = '';
  pick = -1;
  renderHosts();
  drawGhost();
  if (term) term.focus();
}

function promptTarget(note, warn) {
  ask = null;
  setVeil('target', {
    label: 'connect',
    note: note || '',
    warn: !!warn,
    value: lastTarget,
    placeholder: 'user@host',
  });
}

// Inline ghost completion from saved hosts + ~/.ssh/config aliases.
function drawGhost() {
  const value = el.input.value;
  if (mode !== 'target' || !value || pick >= 0) {
    el.ghostTyped.textContent = '';
    el.ghostRest.textContent = '';
    return;
  }
  const match = hints.find((h) => h.startsWith(value) && h !== value);
  el.ghostTyped.textContent = match ? value : '';
  el.ghostRest.textContent = match ? match.slice(value.length) : '';
}

function acceptGhost() {
  if (!el.ghostRest.textContent) return false;
  el.input.value = el.ghostTyped.textContent + el.ghostRest.textContent;
  query = el.input.value;
  baseValue = el.input.value;
  drawGhost();
  return true;
}

// The checkbox is the whole story: on by default, so a password you type once
// is there next time unless you say otherwise.
function showSaveBox(visible) {
  el.save.classList.toggle('show', visible);
  el.save.hidden = !visible;
  el.savebox.checked = remember;
}

function setRemember(next) {
  remember = next;
  el.savebox.checked = next;
}

function setArmed(next) {
  armed = next;
  el.offer.textContent = next ? 'tab — fill saved password' : '';
  el.offer.classList.toggle('show', next);
}

// --------------------------------------------------------- saved hosts ----

function ago(stamp) {
  if (!stamp) return '';
  const seconds = Math.max(0, (Date.now() - stamp) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return Math.round(minutes) + 'm ago';
  const hours = minutes / 60;
  if (hours < 24) return Math.round(hours) + 'h ago';
  const days = hours / 24;
  if (days < 7) return Math.round(days) + 'd ago';
  return new Date(stamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderHosts() {
  el.hosts.textContent = '';
  if (mode !== 'target') {
    shown = [];
    return;
  }

  const needle = query.trim().toLowerCase();
  shown = hosts.filter((h) => !needle || h.target.toLowerCase().includes(needle)).slice(0, 8);
  if (pick >= shown.length) pick = shown.length - 1;

  for (const [index, host] of shown.entries()) {
    const row = document.createElement('li');
    row.className = index === pick ? 'on' : '';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = host.target;

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = ago(host.lastUsed);

    const drop = document.createElement('button');
    drop.className = 'drop';
    drop.textContent = '×';
    drop.title = 'forget ' + host.target;
    drop.addEventListener('click', (event) => {
      event.stopPropagation();
      forget(host.target);
    });

    row.append(name, when, drop);
    row.addEventListener('click', () => connectTo(host.target));
    el.hosts.append(row);
  }
}

function movePick(delta) {
  if (!shown.length) return;
  pick = Math.min(shown.length - 1, Math.max(-1, pick + delta));
  el.input.value = pick === -1 ? baseValue : shown[pick].target;
  renderHosts();
  drawGhost();
  const current = el.hosts.children[pick];
  if (current) current.scrollIntoView({ block: 'nearest' });
}

async function forget(target) {
  hosts = await api.forgetHost(target);
  hints = hints.filter((h) => h !== target);
  if (pick >= 0) pick = -1;
  renderHosts();
  setStatus('forgot ' + target);
}

// ---------------------------------------------------------------- submit ----

async function connectTo(target) {
  if (!target) return;
  lastTarget = target;
  setVeil('waiting', { label: 'connecting…' });
  const result = await api.connect(target, term.cols, term.rows);
  if (!result.ok) promptTarget(result.message, true);
}

function submit() {
  if (mode === 'ask' && ask) {
    const id = ask.id;
    const wanted = remember;
    ask = null;
    remember = false;
    api.answer(id, el.input.value, wanted);
    setVeil('waiting', { label: 'authenticating…' });
    return;
  }
  if (mode === 'target') {
    const target = pick >= 0 ? shown[pick].target : el.input.value.trim() || lastTarget;
    connectTo(target);
  }
}

function cancel() {
  if (mode === 'ask' && ask) {
    const id = ask.id;
    ask = null;
    api.answer(id, null);
    promptTarget('cancelled');
    return;
  }
  if (mode === 'waiting') {
    api.disconnect();
    promptTarget('cancelled');
    return;
  }
  if (mode === 'blocked') {
    promptTarget('');
    return;
  }
  if (mode === 'target') {
    if (pick >= 0) {
      pick = -1;
      el.input.value = baseValue;
      renderHosts();
    } else if (el.input.value) {
      el.input.value = '';
      query = '';
      baseValue = '';
      renderHosts();
      drawGhost();
    } else {
      api.window('close');
    }
  }
}

// ------------------------------------------------------------- terminal ----

function buildTerm() {
  term = new window.Terminal({
    allowTransparency: true,
    theme: THEME,
    fontFamily: config.fontFamily,
    fontSize: config.fontSize,
    fontWeight: config.fontWeight,
    fontWeightBold: 600,
    lineHeight: config.lineHeight,
    letterSpacing: config.letterSpacing,
    cursorBlink: config.cursorBlink,
    cursorStyle: config.cursorStyle,
    cursorInactiveStyle: 'outline',
    scrollback: config.scrollback,
    smoothScrollDuration: 90,
    scrollOnUserInput: true,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    macOptionIsMeta: true,
  });

  fit = new FitAddonCtor();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddonCtor((event, uri) => api.openExternal(uri)));
  term.open(el.term);

  term.onData((data) => {
    // Typing anywhere in the scrollback should bring you back to the prompt
    // rather than leaving you stranded up the buffer.
    term.scrollToBottom();
    api.send(data);
  });
  term.onBinary((data) => {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 255;
    api.send(bytes);
  });
  term.onResize(({ cols, rows }) => api.resize(cols, rows));
  term.onTitleChange((title) => {
    if (mode === 'shell' && title) el.title.textContent = title;
  });

  const resize = () => {
    try {
      fit.fit();
    } catch {
      // element not laid out yet
    }
  };
  new ResizeObserver(resize).observe(el.term);
  resize();
}

function setFontSize(next) {
  const size = Math.max(9, Math.min(28, next));
  term.options.fontSize = size;
  fit.fit();
  api.saveConfig({ fontSize: size });
  setStatus('font ' + size + 'px');
}

// With the blur on, the tint belongs to the window effect itself; without it,
// the page's own scrim is all there is.
async function setTint(step) {
  if (config.blur) {
    const result = await api.setTint((config.blurAlpha || 0) + step);
    if (result.ok) {
      config.blurAlpha = result.blurAlpha;
      setStatus('frost tint ' + Math.round(result.blurAlpha * 100) + '%');
    }
    return;
  }
  const scrim = Math.max(0, Math.min(1, Math.round((config.scrim + step) * 100) / 100));
  document.documentElement.style.setProperty('--scrim', String(scrim));
  config.scrim = scrim;
  api.saveConfig({ scrim });
  setStatus('tint ' + Math.round(scrim * 100) + '%');
}

async function toggleBlur() {
  const result = await api.toggleBlur();
  if (result.ok) setStatus(result.blur ? 'frosted' : 'clear');
}

async function paste() {
  const text = await api.readClipboard();
  if (!text) return;
  if (mode === 'shell') term.paste(text);
  else {
    el.input.value += text.replace(/[\r\n]+/g, ' ').trim();
    query = el.input.value;
    pick = -1;
    renderHosts();
    drawGhost();
  }
}

function copy() {
  const selection = term ? term.getSelection() : '';
  if (!selection) return false;
  api.writeClipboard(selection);
  term.clearSelection();
  setStatus('copied');
  return true;
}

// ------------------------------------------------------------ shortcuts ----

document.addEventListener(
  'keydown',
  (event) => {
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key;
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (ctrl && event.shiftKey) {
      const lower = key.toLowerCase();
      if (lower === 'n') return stop(), api.window('new');
      if (lower === 'w') return stop(), api.window('close');
      if (lower === 'c') return stop(), void copy();
      if (lower === 'v') return stop(), void paste();
      if (lower === 'g') return stop(), void toggleBlur();
      if (lower === 'd') {
        stop();
        api.disconnect();
        el.app.classList.remove('live');
        el.title.textContent = 'cssh';
        promptTarget('disconnected');
        return;
      }
      if (key === 'ArrowUp') return stop(), void setTint(0.04);
      if (key === 'ArrowDown') return stop(), void setTint(-0.04);
      if (key === 'Enter') return stop(), api.window('toggle-max');
    }

    if (ctrl && !event.shiftKey) {
      if (key === '=' || key === '+') return stop(), setFontSize(term.options.fontSize + 1);
      if (key === '-' || key === '_') return stop(), setFontSize(term.options.fontSize - 1);
      if (key === '0') return stop(), setFontSize(14);
      if (key === 'Delete' && mode === 'target' && pick >= 0) return stop(), void forget(shown[pick].target);
      if (key.toLowerCase() === 'v' && mode === 'shell') return stop(), void paste();
      if (key.toLowerCase() === 'c' && mode === 'shell' && term.hasSelection()) return stop(), void copy();
      // ^A is beginning-of-line in a shell, so select-all is dialog-only.
      if (key.toLowerCase() === 's' && mode === 'ask' && ask && ask.canRemember) {
        stop();
        setRemember(!remember);
        return;
      }
      if (key.toLowerCase() === 'a' && mode !== 'shell' && !el.input.disabled) {
        stop();
        el.input.focus();
        el.input.select();
        return;
      }
    }

    // Tab is completion in a shell — only claim it while a password prompt is
    // actually on screen and we have something to fill.
    if (mode === 'shell' && armed && key === 'Tab' && !ctrl && !event.shiftKey) {
      stop();
      api.fillSecret();
      return;
    }

    if (mode === 'shell') return;

    if (key === 'Enter') return stop(), submit();
    if (key === 'Escape') return stop(), cancel();

    if (mode !== 'target') return;

    if (key === 'Tab') return stop(), void acceptGhost();
    if (key === 'ArrowRight' && el.input.selectionStart === el.input.value.length) {
      if (acceptGhost()) stop();
      return;
    }
    if (key === 'ArrowDown') return stop(), movePick(1);
    if (key === 'ArrowUp') return stop(), movePick(-1);
  },
  true
);

el.savebox.addEventListener('change', () => {
  remember = el.savebox.checked;
  if (!el.input.disabled) el.input.focus();
});

el.input.addEventListener('input', () => {
  query = el.input.value;
  baseValue = el.input.value;
  pick = -1;
  renderHosts();
  drawGhost();
});

el.term.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (!copy()) paste();
});

document.getElementById('min').addEventListener('click', () => api.window('minimize'));
document.getElementById('max').addEventListener('click', () => api.window('toggle-max'));
document.getElementById('close').addEventListener('click', () => api.window('close'));

el.veil.addEventListener('mousedown', (event) => {
  if (
    !el.input.disabled &&
    !event.target.closest('#hosts') &&
    !event.target.closest('#save') &&
    event.target !== el.input
  ) {
    event.preventDefault();
    el.input.focus();
  }
});

// ----------------------------------------------- dragging off a maximize ----

// While maximized the title bar is no-drag, so the pointer gesture is ours:
// past a few pixels we restore the window under the cursor and keep moving it,
// which is what every other Windows app does.
let drag = null;

el.bar.addEventListener('pointerdown', (event) => {
  if (!maximized || event.button !== 0 || event.target.closest('#controls')) return;
  const rect = el.bar.getBoundingClientRect();
  drag = {
    id: event.pointerId,
    x: event.screenX,
    y: event.screenY,
    ratio: Math.min(0.92, Math.max(0.08, (event.clientX - rect.left) / rect.width)),
    live: false,
  };
  // Restoring mid-gesture clears `maxed`, which would hand the bar straight
  // back to the OS drag region and cut the drag short. This keeps it ours.
  el.app.classList.add('dragging');
  el.bar.setPointerCapture(event.pointerId);
});

el.bar.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.id) return;
  if (!drag.live) {
    if (Math.abs(event.screenX - drag.x) + Math.abs(event.screenY - drag.y) < 5) return;
    drag.live = true;
    api.drag({ phase: 'start', screenX: event.screenX, screenY: event.screenY, grabRatio: drag.ratio });
    return;
  }
  api.drag({ phase: 'move', screenX: event.screenX, screenY: event.screenY });
});

function endDrag(event) {
  if (!drag || (event && event.pointerId !== drag.id)) return;
  if (el.bar.hasPointerCapture(drag.id)) el.bar.releasePointerCapture(drag.id);
  if (drag.live) api.drag({ phase: 'end' });
  el.app.classList.remove('dragging');
  drag = null;
}

el.bar.addEventListener('pointerup', endDrag);
el.bar.addEventListener('pointercancel', endDrag);
el.bar.addEventListener('dblclick', (event) => {
  if (event.target.closest('#controls')) return;
  api.window('toggle-max');
});

// ------------------------------------------------------------- ssh wiring --

api.onData((data) => term.write(data));

api.onStatus(({ text, kind }) => {
  if (mode === 'waiting') el.label.textContent = text;
  else setStatus(text, kind);
});

api.onAsk((request) => {
  ask = request;
  if (request.type === 'hostkey') {
    setVeil('ask', {
      label: 'unknown host  ' + request.label,
      placeholder: 'enter to trust, esc to cancel',
      note: '<b>' + request.fingerprint + '</b>\nverify this fingerprint before trusting it.',
    });
    return;
  }
  remember = !!request.canRemember && config.rememberPasswords !== false;
  setVeil('ask', {
    label: request.label,
    secret: request.type === 'password',
    note: request.note || '',
  });
  showSaveBox(!!request.canRemember);
});

api.onConnected(({ label, host, username }) => {
  lastTarget = label;
  if (!hints.includes(label)) hints.unshift(label);
  el.title.textContent = username + '@' + host;
  el.app.classList.add('live');
  term.reset();
  hideVeil();
  fit.fit();
  setStatus('connected');
});

api.onClosed(() => {
  setArmed(false);
  el.app.classList.remove('live');
  el.title.textContent = 'cssh';
  promptTarget('connection closed');
});

api.onError(({ message }) => {
  el.app.classList.remove('live');
  el.title.textContent = 'cssh';
  promptTarget(String(message).toLowerCase(), true);
});

api.onHostKeyChanged(({ id, expected, got }) => {
  el.app.classList.remove('live');
  setVeil('blocked', {
    label: 'host key changed for ' + id,
    warn: true,
    note:
      'expected <b>' +
      expected +
      '</b>\nreceived <b>' +
      got +
      '</b>\n\nthis can mean the server was rebuilt — or that something is intercepting the connection.\nremove the entry from ~/.cssh/known_hosts.json to trust the new key.\n\nesc to go back',
  });
});

api.onHostsChanged((list) => {
  hosts = list || [];
  hints = [...new Set([...hosts.map((h) => h.target), ...hints])];
  renderHosts();
});

api.onConfigChanged((next) => {
  config = next;
  document.documentElement.style.setProperty('--scrim', String(config.scrim));
  el.app.classList.toggle('clear', !config.blur);
});

api.onArmed(({ armed: isArmed }) => setArmed(isArmed));

api.onWindowState(({ maximized: isMax }) => {
  maximized = isMax;
  el.app.classList.toggle('maxed', isMax);
});

// ----------------------------------------------------------------- boot ----

(async function boot() {
  const info = await api.init();
  config = info.config;
  hosts = info.hosts || [];
  hints = info.suggestions || [];

  document.documentElement.style.setProperty('--scrim', String(config.scrim));
  if (config.fontFamily) document.documentElement.style.setProperty('--ui', config.fontFamily);
  el.app.classList.toggle('no-shadow', config.textShadow === false);
  el.app.classList.toggle('clear', !config.blur);
  el.app.classList.toggle('clear-black', config.transparentBlack !== false);

  buildTerm();
  promptTarget('');

  if (info.target) {
    lastTarget = info.target;
    el.input.value = info.target;
    query = info.target;
    submit();
  }
})();
