'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lwclipper', {
  toolsStatus: () => ipcRenderer.invoke('tools:status'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseCacheFolder: () => ipcRenderer.invoke('dialog:chooseCacheFolder'),
  openAppFiles: () => ipcRenderer.invoke('shell:openAppFiles'),
  fitWindow: (delta) => ipcRenderer.invoke('window:fit', delta),
  releaseWindowHeight: () => ipcRenderer.invoke('window:release'),
  deleteAppFiles: () => ipcRenderer.invoke('app:deleteAppFiles'),
  clearCache: (ticked) => ipcRenderer.invoke('tools:clearCache', ticked),
  listClaims: () => ipcRenderer.invoke('tools:claims'),
  cachedNames: (sources) => ipcRenderer.invoke('tools:cacheNames', sources),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  probe: (url, cookies) => ipcRenderer.invoke('video:probe', { url, cookies }),
  download: (videoId, sourceUrl, title, format, cookies) =>
    ipcRenderer.invoke('video:download', { videoId, sourceUrl, title, format, cookies }),
  trim: (media, destination, start, end, accurate, compression, audio, crop, video) =>
    ipcRenderer.invoke('video:trim',
      { media, destination, start, end, accurate, compression, audio, crop, video }),
  compose: (layers, project, trim, destination, compression) =>
    ipcRenderer.invoke('video:compose',
      { layers, project, trim, destination, compression }),
  audioPeaks: (filePath, duration, buckets) =>
    ipcRenderer.invoke('audio:peaks', { filePath, duration, buckets }),
  abortAudioPeaks: () => ipcRenderer.invoke('audio:abortPeaks'),
  filmstrip: (filePath, duration, tiles, at) =>
    ipcRenderer.invoke('video:filmstrip', { filePath, duration, tiles, at }),
  openAudioTrack: () => ipcRenderer.invoke('dialog:openAudio'),
  saveAsDialog: (title, isAudio, format, isProject) =>
    ipcRenderer.invoke('dialog:saveAs', { title, isAudio, format, isProject }),
  quickSaveTarget: (title, isAudio, format) =>
    ipcRenderer.invoke('path:quickSaveTarget', { title, isAudio, format }),
  supportedTypes: () => ipcRenderer.invoke('media:supportedTypes'),
  loadLocalMedia: () => ipcRenderer.invoke('dialog:openMedia'),
  // A dropped File carries no usable path of its own: Electron 32 removed the
  // File.path augmentation, and the type definitions still declare it, so
  // reading file.path silently yields undefined. webUtils is one of the six
  // modules a sandboxed preload may require, which is what keeps this on the
  // preload side of the bridge rather than needing the sandbox relaxed.
  pathForFile: (file) => webUtils.getPathForFile(file),
  describeMedia: (filePath) => ipcRenderer.invoke('media:describe', filePath),
  // Step 13, the project file. The renderer holds the document; the main
  // process owns the dialogs and every stat behind a fingerprint.
  projectSaveDialog: (suggested) => ipcRenderer.invoke('project:saveDialog', suggested),
  saveProject: (filePath, state, previous) =>
    ipcRenderer.invoke('project:save', { filePath, state, previous }),
  projectOpenDialog: () => ipcRenderer.invoke('project:openDialog'),
  openProject: (filePath) => ipcRenderer.invoke('project:open', filePath),
  // The close guard. The window is held shut until the renderer answers, and
  // allowClose is the answer.
  onClosing: (callback) => {
    ipcRenderer.removeAllListeners('app:closing');
    ipcRenderer.on('app:closing', () => callback());
  },
  allowClose: () => ipcRenderer.invoke('app:allowClose'),
  // Asked once at startup, because the events only fire on a change and the
  // window can be launched maximized by the system.
  windowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  // Maximized or not. The window's own doing, so only main can say.
  onWindowState: (callback) => {
    ipcRenderer.removeAllListeners('window:state');
    ipcRenderer.on('window:state', (_event, payload) => callback(payload));
  },
  openCacheFolder: (reveal) => ipcRenderer.invoke('shell:openCacheFolder', reveal),
  openFile: (filePath) => ipcRenderer.invoke('shell:openFile', filePath),
  readClipboardText: () => ipcRenderer.invoke('clipboard:readText'),
  fileUrl: (filePath) => ipcRenderer.invoke('shell:fileUrl', filePath),
  onProgress: (callback) => {
    ipcRenderer.removeAllListeners('job:progress');
    ipcRenderer.on('job:progress', (_event, payload) => callback(payload));
  },
});
