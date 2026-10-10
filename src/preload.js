// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts


const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    getPrinters: () => ipcRenderer.invoke('get-printers'),
    printTicket: (data, options) => ipcRenderer.invoke('print-ticket', data, options),
    // Logs del proceso principal
    mainLog: {
      get: () => ipcRenderer.invoke('main-log:get'),
      subscribe: async (cb) => {
        // cb recibe cada entrada nueva
        const cleanup = await ipcRenderer.invoke('main-log:subscribe');
        ipcRenderer.on('main-log:entry', (_e, entry) => cb(entry));
        return async () => {
          await cleanup();
          ipcRenderer.off('main-log:entry', (_e, entry) => cb(entry));
        };
      },
    },
});
