'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  ipcRenderer.on(channel, (_event, payload) => handler(payload));
};

contextBridge.exposeInMainWorld('cssh', {
  init: () => ipcRenderer.invoke('app:init'),
  connect: (target, cols, rows) => ipcRenderer.invoke('ssh:connect', { target, cols, rows }),
  send: (data) => ipcRenderer.send('ssh:input', data),
  resize: (cols, rows) => ipcRenderer.send('ssh:resize', { cols, rows }),
  answer: (id, value, remember) => ipcRenderer.send('ssh:answer', { id, value, remember }),
  disconnect: () => ipcRenderer.send('ssh:disconnect'),
  saveConfig: (patch) => ipcRenderer.send('config:set', patch),
  window: (action) => ipcRenderer.send('win:action', action),
  drag: (payload) => ipcRenderer.send('win:drag', payload),
  toggleBlur: () => ipcRenderer.invoke('win:blur-toggle'),
  setTint: (alpha) => ipcRenderer.invoke('win:tint', alpha),
  fillSecret: () => ipcRenderer.invoke('secret:fill'),
  forgetHost: (target) => ipcRenderer.invoke('hosts:forget', target),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  readClipboard: () => ipcRenderer.invoke('clip:read'),
  writeClipboard: (text) => ipcRenderer.send('clip:write', text),

  onData: on('ssh:data'),
  onStatus: on('ssh:status'),
  onAsk: on('ssh:ask'),
  onConnected: on('ssh:connected'),
  onClosed: on('ssh:closed'),
  onError: on('ssh:error'),
  onHostKeyChanged: on('ssh:hostkey-changed'),
  onConfigChanged: on('config:changed'),
  onHostsChanged: on('hosts:changed'),
  onWindowState: on('win:state'),
  onArmed: on('secret:armed'),
});
