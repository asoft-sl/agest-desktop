// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts


const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    getPrinters: () => ipcRenderer.invoke('get-printers'),
    printTicket: (data, options) => ipcRenderer.invoke('print-ticket', data, options)
});
