'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lwclipper', {
  toolsStatus: () => ipcRenderer.invoke('tools:status'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseCacheFolder: () => ipcRenderer.invoke('dialog:chooseCacheFolder'),
  openAppFiles: () => ipcRenderer.invoke('shell:openAppFiles'),
  fitWindow: (delta) => ipcRenderer.invoke('window:fit', delta),
  deleteAppFiles: () => ipcRenderer.invoke('app:deleteAppFiles'),
  clearCache: () => ipcRenderer.invoke('tools:clearCache'),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  probe: (url, cookies) => ipcRenderer.invoke('video:probe', { url, cookies }),
  download: (videoId, sourceUrl, title, format, cookies) =>
    ipcRenderer.invoke('video:download', { videoId, sourceUrl, title, format, cookies }),
  trim: (media, destination, start, end, accurate, compression, audio, crop, video) =>
    ipcRenderer.invoke('video:trim',
      { media, destination, start, end, accurate, compression, audio, crop, video }),
  audioPeaks: (filePath, duration, buckets) =>
    ipcRenderer.invoke('audio:peaks', { filePath, duration, buckets }),
  abortAudioPeaks: () => ipcRenderer.invoke('audio:abortPeaks'),
  openAudioTrack: () => ipcRenderer.invoke('dialog:openAudio'),
  saveAsDialog: (title, isAudio, format) =>
    ipcRenderer.invoke('dialog:saveAs', { title, isAudio, format }),
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
  openCacheFolder: (reveal) => ipcRenderer.invoke('shell:openCacheFolder', reveal),
  openFile: (filePath) => ipcRenderer.invoke('shell:openFile', filePath),
  readClipboardText: () => ipcRenderer.invoke('clipboard:readText'),
  fileUrl: (filePath) => ipcRenderer.invoke('shell:fileUrl', filePath),
  onProgress: (callback) => {
    ipcRenderer.removeAllListeners('job:progress');
    ipcRenderer.on('job:progress', (_event, payload) => callback(payload));
  },
});
