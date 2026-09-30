import { ipcRenderer } from "electron";

const RECORDER_PORT_CHANNEL = "zcode-browser-video-recorder:port";

// MessagePort cannot be proxied through contextBridge; the dedicated preload only transfers the port directed by main to
// Same trusted recorder document, without exposing ipcRenderer or any general Electron capabilities.
ipcRenderer.once(RECORDER_PORT_CHANNEL, (event) => {
  const [port] = event.ports;
  if (port) window.postMessage(RECORDER_PORT_CHANNEL, "*", [port]);
});
