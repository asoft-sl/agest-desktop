// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts


const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    getPrinters: () => ipcRenderer.invoke('get-printers'),
    printTicket: (data, options) => ipcRenderer.invoke('print-ticket', data, options),
    // Recarga la aplicación desde la página de error de conexión.
    retryLoad: () => ipcRenderer.send('retry-load'),
    // Logs del proceso principal
    mainLog: {
      get: () => ipcRenderer.invoke('main-log:get'),
      subscribe: (cb) => {
        // cb es el callback del renderer. Nos suscribimos en main y
        // reenviamos cada entry vía ipcRenderer.on. Usamos una referencia
        // estable para que el off funcione al limpiar.
        const listener = (_e, entry) => cb(entry);
        ipcRenderer.on('main-log:entry', listener);
        // Pedimos al main que empiece a enviar a este renderer. La
        // desuscripción no puede volver como función: Electron clona el valor
        // de retorno del invoke y una función no se puede clonar. Se pide con
        // otro invoke.
        return ipcRenderer
          .invoke('main-log:subscribe')
          .then(() => {
            return async () => {
              ipcRenderer.off('main-log:entry', listener);
              await ipcRenderer.invoke('main-log:unsubscribe');
            };
          })
          .catch((err) => {
            // No se pudo suscribir: fuera el listener local, que si no se
            // acumula uno por montaje del componente.
            ipcRenderer.off('main-log:entry', listener);
            throw err;
          });
      },
    },
});
