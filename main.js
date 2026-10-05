'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  clipboard,
  nativeTheme,
  screen,
  safeStorage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Client, utils } = require('ssh2');
const blur = require('./blur');

// ---------------------------------------------------------------- config ----

const DIR = path.join(os.homedir(), '.cssh');
const FILES = {
  config: path.join(DIR, 'config.json'),
  knownHosts: path.join(DIR, 'known_hosts.json'),
  hosts: path.join(DIR, 'hosts.json'),
  secrets: path.join(DIR, 'secrets.json'),
};

const DEFAULTS = {
  fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
  fontSize: 14,
  fontWeight: 400,
  lineHeight: 1.4,
  letterSpacing: 0.2,
  blur: true,           // frosted glass. false = clear see-through
  blurColor: '232323',  // frost tint, RRGGBB
  blurAlpha: 0.23,      // how much of that tint sits over the blur: 0..1
  scrim: 0,             // extra tint in the page itself: 0 = none, 1 = solid
  textShadow: true,     // lifts glyphs off the wallpaper
  transparentBlack: true, // let black backgrounds from remote apps show the glass
  rememberPasswords: true, // whether the save box starts ticked at a password prompt
  cursorStyle: 'bar',   // bar | block | underline
  cursorBlink: true,
  scrollback: 10000,
  keepalive: 20000,
  width: 1020,
  height: 660,
};

function readJSON(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(fallback) ? parsed : { ...fallback, ...parsed };
  } catch {
    return Array.isArray(fallback) ? fallback.slice() : { ...fallback };
  }
}

function writeJSON(file, data) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('cssh: could not write ' + file, e.message);
  }
}

let config = readJSON(FILES.config, DEFAULTS);

// ------------------------------------------------------------ ssh config ----

// Minimal ~/.ssh/config reader: Host blocks with HostName / User / Port / IdentityFile.
function sshConfigHosts() {
  let text;
  try {
    text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
  } catch {
    return [];
  }

  const blocks = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(\S+)[\s=]+(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'host') {
      current = { patterns: value.split(/\s+/), opts: {} };
      blocks.push(current);
    } else if (current) {
      current.opts[key] = value;
    }
  }
  return blocks;
}

function resolveAlias(name) {
  for (const block of sshConfigHosts()) {
    for (const pattern of block.patterns) {
      const source = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      if (new RegExp('^' + source + '$').test(name)) {
        return {
          host: block.opts.hostname || name,
          username: block.opts.user,
          port: block.opts.port ? Number(block.opts.port) : undefined,
          identityFile: block.opts.identityfile,
        };
      }
    }
  }
  return null;
}

// --------------------------------------------------------------- secrets ----

// Saved passwords, encrypted by the OS keystore (DPAPI on Windows) and tied to
// this Windows account — so the file is useless if it is copied off the
// machine. Nothing is ever written in the clear, and nothing is ever logged.

function vaultReady() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function readSecret(target) {
  if (!vaultReady()) return null;
  const blob = readJSON(FILES.secrets, {})[target];
  if (!blob) return null;
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch {
    return null; // written by another account, or the key changed
  }
}

function writeSecret(target, password) {
  if (!vaultReady() || !password) return false;
  const store = readJSON(FILES.secrets, {});
  store[target] = safeStorage.encryptString(password).toString('base64');
  writeJSON(FILES.secrets, store);
  return true;
}

function forgetSecret(target) {
  const store = readJSON(FILES.secrets, {});
  if (!(target in store)) return;
  delete store[target];
  writeJSON(FILES.secrets, store);
}

// A prompt asking for a password, at the very end of what the remote printed:
// "[sudo] password for joe:", "Password:", "Enter passphrase for key ...:".
const PASSWORD_PROMPT =
  /(?:^|[\r\n])[^\r\n]{0,90}?(?:password|passphrase)\b[^\r\n]{0,40}:[ \t]?$/i;

function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
}

// ------------------------------------------------------------ saved hosts ----

// [{ target, lastUsed, uses }] — newest first. Written on every successful connect.
function savedHosts() {
  const list = readJSON(FILES.hosts, []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => entry && typeof entry.target === 'string')
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}

function rememberHost(target) {
  const list = savedHosts();
  const existing = list.find((entry) => entry.target === target);
  if (existing) {
    existing.lastUsed = Date.now();
    existing.uses = (existing.uses || 0) + 1;
  } else {
    list.unshift({ target, lastUsed: Date.now(), uses: 1 });
  }
  writeJSON(FILES.hosts, list.slice(0, 200));
  return savedHosts();
}

function forgetHost(target) {
  writeJSON(FILES.hosts, savedHosts().filter((entry) => entry.target !== target));
  forgetSecret(target); // forgetting a host forgets its password with it
  return savedHosts();
}

// Saved hosts plus ssh-config aliases, for inline completion.
function suggestions() {
  const aliases = sshConfigHosts()
    .flatMap((block) => block.patterns)
    .filter((pattern) => !pattern.includes('*') && !pattern.includes('?'));
  return [...new Set([...savedHosts().map((entry) => entry.target), ...aliases])];
}

// Accepts: host | user@host | user@host:port | an ssh-config alias
function parseTarget(input) {
  let text = input.trim().replace(/^ssh\s+/i, '');
  let username;
  let port;

  const at = text.lastIndexOf('@');
  if (at !== -1) {
    username = text.slice(0, at);
    text = text.slice(at + 1);
  }
  const colon = text.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(text.slice(colon + 1))) {
    port = Number(text.slice(colon + 1));
    text = text.slice(0, colon);
  }
  if (!text) return null;

  const alias = resolveAlias(text);
  const identityFile = alias && alias.identityFile
    ? alias.identityFile.replace(/^"|"$/g, '').replace(/^~/, os.homedir())
    : null;

  return {
    host: alias ? alias.host : text,
    username: username || (alias && alias.username) || os.userInfo().username,
    port: port || (alias && alias.port) || 22,
    identityFile,
    label: input.trim(),
  };
}

// ------------------------------------------------------------------ auth ----

function agentPath() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') {
    const pipe = '\\\\.\\pipe\\openssh-ssh-agent';
    try {
      if (fs.existsSync(pipe)) return pipe;
    } catch {
      // no agent
    }
  }
  return null;
}

function defaultKeys() {
  const dir = path.join(os.homedir(), '.ssh');
  return ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa']
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

// --------------------------------------------------------------- session ----

class Session {
  constructor(win) {
    this.win = win;
    this.conn = null;
    this.stream = null;
    this.pending = new Map();
    this.nextAskId = 1;
  }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  status(text, kind) {
    this.send('ssh:status', { text, kind: kind || 'info' });
  }

  // Ask the renderer for something: password, passphrase, host-key trust.
  ask(request) {
    const id = this.nextAskId++;
    this.send('ssh:ask', { id, ...request });
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  answer(id, value, remember) {
    if (remember) this.remember = true;
    const resolve = this.pending.get(id);
    if (resolve) {
      this.pending.delete(id);
      resolve(value);
    }
  }

  cancelPending() {
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }

  connect(target, size) {
    this.disconnect(true);
    this.target = target;
    this.size = size;
    this.closedByUser = false;
    this.authenticated = false;
    this.remember = false;
    this.lastPassword = null;
    this.tail = '';
    this.armed = false;

    // Auth ladder, tried in order and filtered by what the server offers.
    this.methods = [];
    const agent = agentPath();
    if (agent) this.methods.push({ kind: 'agent', agent });
    const keys = target.identityFile ? [target.identityFile] : defaultKeys();
    for (const file of keys) this.methods.push({ kind: 'key', file });
    if (readSecret(target.label)) this.methods.push({ kind: 'saved' });
    this.methods.push({ kind: 'password' });
    this.methods.push({ kind: 'keyboard-interactive' });
    this.methodIndex = 0;
    this.passwordTries = 0;

    const conn = new Client();
    this.conn = conn;
    this.status('connecting to ' + target.host + '…');

    conn.on('ready', () => {
      this.authenticated = true;
      conn.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, stream) => {
        if (err) return this.fail(err.message);
        this.stream = stream;
        this.send('ssh:connected', {
          label: target.label,
          host: target.host,
          username: target.username,
        });
        // A connection that actually opened a shell is worth remembering.
        broadcastHosts(rememberHost(target.label));
        if (this.remember && this.lastPassword) {
          if (writeSecret(target.label, this.lastPassword)) {
            this.status('password saved for ' + target.label);
          }
        }
        this.lastPassword = null;

        stream.on('data', (data) => {
          this.watchForPrompt(data);
          this.send('ssh:data', data);
        });
        stream.stderr.on('data', (data) => {
          this.watchForPrompt(data);
          this.send('ssh:data', data);
        });
        stream.on('close', () => conn.end());
      });
    });

    conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      const answers = [];
      const nextPrompt = async () => {
        for (const prompt of prompts) {
          const value = await this.ask({
            type: prompt.echo ? 'text' : 'password',
            label: String(prompt.prompt || 'response').replace(/:\s*$/, ''),
            note: instructions || '',
          });
          if (value === null) {
            this.disconnect(true);
            this.send('ssh:closed', { authenticated: false });
            return;
          }
          answers.push(value);
        }
        finish(answers);
      };
      nextPrompt();
    });

    conn.on('error', (err) => this.fail(err.message));

    conn.on('close', () => {
      this.cancelPending();
      this.stream = null;
      if (!this.closedByUser) this.send('ssh:closed', { authenticated: this.authenticated });
    });

    try {
      conn.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        tryKeyboard: true,
        readyTimeout: 20000,
        keepaliveInterval: config.keepalive,
        hostVerifier: (key, cb) => this.verifyHost(key, cb),
        authHandler: (methodsLeft, partial, cb) => {
          this.nextAuth(methodsLeft, cb);
        },
      });
    } catch (e) {
      this.fail(e.message);
    }
  }

  async nextAuth(methodsLeft, cb) {
    const allows = (name) => !methodsLeft || methodsLeft.includes(name);
    const username = this.target.username;

    while (this.methodIndex < this.methods.length) {
      const method = this.methods[this.methodIndex++];

      if (method.kind === 'agent') {
        if (!allows('publickey')) continue;
        this.status('trying ssh agent…');
        return cb({ type: 'agent', username, agent: method.agent });
      }

      if (method.kind === 'key') {
        if (!allows('publickey')) continue;
        const key = await this.loadKey(method.file);
        if (!key) continue;
        this.status('trying ' + path.basename(method.file) + '…');
        return cb({ type: 'publickey', username, key });
      }

      if (method.kind === 'saved') {
        if (!allows('password')) continue;
        const saved = readSecret(this.target.label);
        if (!saved) continue;
        this.status('using saved password…');
        this.lastPassword = saved;
        return cb({ type: 'password', username, password: saved });
      }

      if (method.kind === 'password') {
        if (!allows('password')) continue;
        const password = await this.ask({
          type: 'password',
          label: 'password for ' + username + '@' + this.target.host,
          canRemember: vaultReady(),
        });
        if (password === null) return cb(false);
        this.lastPassword = password;
        // Up to three attempts before falling through to the next method.
        if (++this.passwordTries < 3) {
          this.methods.splice(this.methodIndex, 0, { kind: 'password' });
        }
        return cb({ type: 'password', username, password });
      }

      if (method.kind === 'keyboard-interactive') {
        if (!allows('keyboard-interactive')) continue;
        return cb({ type: 'keyboard-interactive', username });
      }
    }
    return cb(false);
  }

  async loadKey(file) {
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      return null;
    }

    let key = utils.parseKey(buffer);
    if (key instanceof Error) {
      if (!/encrypt|passphrase/i.test(key.message)) return null;
      const passphrase = await this.ask({
        type: 'password',
        label: 'passphrase for ' + path.basename(file),
      });
      if (passphrase === null) return null;
      key = utils.parseKey(buffer, passphrase);
      if (key instanceof Error) {
        this.status('wrong passphrase for ' + path.basename(file), 'warn');
        return null;
      }
    }
    return Array.isArray(key) ? key[0] : key;
  }

  verifyHost(key, cb) {
    const fingerprint =
      'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    const id = this.target.host + ':' + this.target.port;
    const known = readJSON(FILES.knownHosts, {});

    if (known[id] === fingerprint) return cb(true);

    if (known[id]) {
      this.send('ssh:hostkey-changed', { id, expected: known[id], got: fingerprint });
      return cb(false);
    }

    this.ask({ type: 'hostkey', label: id, fingerprint }).then((answer) => {
      if (answer === null) return cb(false);
      known[id] = fingerprint;
      writeJSON(FILES.knownHosts, known);
      cb(true);
    });
  }

  fail(message) {
    this.cancelPending();
    this.send('ssh:error', { message });
    this.disconnect(true);
  }

  // Offer the saved password when the remote is clearly asking for one — a
  // sudo prompt, say. Nothing is sent until the keystroke comes back.
  watchForPrompt(chunk) {
    if (!this.target || !readSecret(this.target.label)) return;
    this.tail = (this.tail + stripAnsi(chunk.toString('utf8'))).slice(-300);
    this.setArmed(PASSWORD_PROMPT.test(this.tail));
  }

  setArmed(next) {
    if (next === this.armed) return;
    this.armed = next;
    this.send('secret:armed', { armed: next });
  }

  // Typing dismisses the offer: if they have started entering it themselves,
  // filling underneath them would be worse than useless.
  write(data) {
    if (!this.stream) return;
    this.tail = '';
    this.setArmed(false);
    this.stream.write(data);
  }

  fillSecret() {
    if (!this.armed || !this.stream) return false;
    const secret = readSecret(this.target.label);
    this.tail = '';
    this.setArmed(false);
    if (!secret) return false;
    // Enter over a pty is a carriage return; the line discipline turns it
    // into a newline. A bare newline types the password but never submits.
    this.stream.write(secret + String.fromCharCode(13));
    return true;
  }

  resize(cols, rows) {
    this.size = { cols, rows };
    if (this.stream) {
      try {
        this.stream.setWindow(rows, cols, 0, 0);
      } catch {
        // stream already gone
      }
    }
  }

  disconnect(byUser) {
    if (byUser) this.closedByUser = true;
    this.cancelPending();
    this.stream = null;
    if (this.conn) {
      try {
        this.conn.end();
      } catch {
        // already closed
      }
    }
    this.conn = null;
  }
}

// ----------------------------------------------------------------- glass ----

// Hand the window to DWM to blur, or take the effect back off for clear mode.
function applyGlass(win) {
  if (!win || win.isDestroyed()) return;
  if (config.blur) {
    blur.apply(win, { color: config.blurColor, alpha: config.blurAlpha });
  } else {
    blur.clear(win);
  }
}

// --------------------------------------------------------------- windows ----

const sessions = new Map();

// `cssh user@host` connects straight away; only the first window uses it.
let pendingTarget = (() => {
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'));
  const candidate = args.pop();
  if (!candidate || candidate === '.') return null;
  if (/\.(js|json|asar)$/i.test(candidate)) return null;
  return /^[A-Za-z0-9._@:-]+$/.test(candidate) ? candidate : null;
})();

function createWindow(bounds) {
  const win = new BrowserWindow({
    width: (bounds && bounds.width) || config.width,
    height: (bounds && bounds.height) || config.height,
    x: bounds && bounds.x,
    y: bounds && bounds.y,
    minWidth: 420,
    minHeight: 260,
    icon: path.join(__dirname, 'cssh.ico'),
    // Always see-through: the frost is drawn by the page, so switching between
    // frosted and clear costs nothing and never needs a new window.
    frame: false,
    transparent: true,
    roundedCorners: true,
    hasShadow: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    applyGlass(win);
  });

  sessions.set(win.id, new Session(win));

  const reportState = () => {
    if (!win.isDestroyed()) win.webContents.send('win:state', { maximized: win.isMaximized() });
  };
  win.on('maximize', reportState);
  win.on('unmaximize', reportState);
  win.webContents.on('did-finish-load', reportState);

  win.on('closed', () => {
    const session = sessions.get(win.id);
    if (session) {
      session.disconnect(true);
      sessions.delete(win.id);
    }
    drags.delete(win.id);
  });

  return win;
}

function broadcastHosts(list) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('hosts:changed', list);
  }
}

// --------------------------------------------------- drag off a maximized ----

// Windows restores a maximized window when you drag its title bar; frameless
// windows don't, so the title bar hands the gesture over to us instead.
const drags = new Map();

function beginDrag(win, { screenX, screenY, grabRatio }) {
  const restored = win.getNormalBounds();
  let width = restored.width;
  let height = restored.height;

  if (win.isMaximized()) {
    const area = screen.getDisplayNearestPoint({ x: screenX, y: screenY }).workArea;
    // If the window was never smaller, fall back to a sane restored size.
    if (width >= area.width && height >= area.height) {
      width = Math.round(area.width * 0.72);
      height = Math.round(area.height * 0.78);
    }
    win.unmaximize();
    win.setBounds({
      x: Math.round(screenX - width * grabRatio),
      y: Math.round(screenY - 17),
      width,
      height,
    });
  }

  const bounds = win.getBounds();
  drags.set(win.id, { dx: screenX - bounds.x, dy: screenY - bounds.y });
}

function moveDrag(win, { screenX, screenY }) {
  const grab = drags.get(win.id);
  if (!grab) return;
  win.setPosition(Math.round(screenX - grab.dx), Math.round(screenY - grab.dy));
}

function sessionFor(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? sessions.get(win.id) : null;
}

// ------------------------------------------------------------------- ipc ----

ipcMain.handle('app:init', () => {
  const target = pendingTarget;
  pendingTarget = null;
  return { config, suggestions: suggestions(), hosts: savedHosts(), target };
});

ipcMain.handle('hosts:forget', (event, target) => {
  const list = forgetHost(target);
  broadcastHosts(list);
  return list;
});

ipcMain.handle('ssh:connect', (event, { target, cols, rows }) => {
  const session = sessionFor(event);
  if (!session) return { ok: false, message: 'no session' };

  const parsed = parseTarget(target);
  if (!parsed) return { ok: false, message: 'need a host' };

  session.connect(parsed, { cols, rows });
  return { ok: true, target: { host: parsed.host, username: parsed.username, port: parsed.port } };
});

ipcMain.on('ssh:input', (event, data) => {
  const session = sessionFor(event);
  if (session) session.write(data);
});

ipcMain.on('ssh:resize', (event, { cols, rows }) => {
  const session = sessionFor(event);
  if (session) session.resize(cols, rows);
});

ipcMain.on('ssh:answer', (event, { id, value, remember }) => {
  const session = sessionFor(event);
  if (session) session.answer(id, value, remember);
});

ipcMain.handle('secret:fill', (event) => {
  const session = sessionFor(event);
  return { ok: !!session && session.fillSecret() };
});

ipcMain.on('ssh:disconnect', (event) => {
  const session = sessionFor(event);
  if (session) session.disconnect(true);
});

ipcMain.on('config:set', (event, patch) => {
  config = { ...config, ...patch };
  writeJSON(FILES.config, config);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('config:changed', config);
  }
});

ipcMain.on('win:action', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'close') win.close();
  else if (action === 'new') createWindow();
  else if (action === 'toggle-max') (win.isMaximized() ? win.unmaximize() : win.maximize());
});

ipcMain.handle('win:blur-toggle', () => {
  config = { ...config, blur: !config.blur, scrim: config.blur ? 0.45 : 0 };
  writeJSON(FILES.config, config);
  for (const win of BrowserWindow.getAllWindows()) {
    applyGlass(win);
    win.webContents.send('config:changed', config);
  }
  return { ok: true, blur: config.blur };
});

// The tint lives in the window effect, not the page, so changing it re-applies.
ipcMain.handle('win:tint', (event, alpha) => {
  const blurAlpha = Math.max(0, Math.min(0.95, Math.round(alpha * 100) / 100));
  config = { ...config, blurAlpha };
  writeJSON(FILES.config, config);
  for (const win of BrowserWindow.getAllWindows()) applyGlass(win);
  return { ok: true, blurAlpha };
});

ipcMain.on('win:drag', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (payload.phase === 'start') beginDrag(win, payload);
  else if (payload.phase === 'move') moveDrag(win, payload);
  else drags.delete(win.id);
});

ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.on('clip:write', (event, text) => clipboard.writeText(String(text)));

ipcMain.on('open-external', (event, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

// ------------------------------------------------------------------- app ----

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
