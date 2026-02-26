const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;

let PosPrinter;
try {
  PosPrinter = require("electron-pos-printer").PosPrinter;
} catch (e) {
  console.error('electron-pos-printer failed to load:', e.message);
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
try {
  if (require('electron-squirrel-startup')) {
    app.quit();
  }
} catch (e) {
  // electron-squirrel-startup not available in dev
}

const PROD_URL = 'https://apptpv.asoft.es';
const DEV_URL = 'http://localhost:5174';

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:tpv',
    },
  });

  const loadUrl = isDev ? DEV_URL : PROD_URL;

  // Track if we already showed an error page to avoid loops
  let showingError = false;

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.setFullScreen(true);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('Page failed to load:', errorCode, errorDescription);
    if (errorCode === -3) return;
    if (showingError) return;
    showingError = true;
    loadErrorPage(mainWindow, validatedURL || loadUrl, errorDescription);
  });

  mainWindow.loadURL(loadUrl).catch((err) => {
    console.error('Failed to load URL:', err.message);
    if (!showingError) {
      showingError = true;
      loadErrorPage(mainWindow, loadUrl, err.message);
    }
  });

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Register IPC handlers only once
  if (!ipcMain.listenerCount('get-printers')) {
    ipcMain.handle('get-printers', async () => {
      const focusedWindow = BrowserWindow.getFocusedWindow();
      const win = focusedWindow || mainWindow;
      return win.webContents.getPrintersAsync();
    });

    ipcMain.handle('print-ticket', (_event, data, options) => {
      if (!PosPrinter) throw new Error('Printer module not available');
      return PosPrinter.print(data, options);
    });
  }
};

function loadErrorPage(win, url, errorMessage) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Asoft TPV - Error de conexión</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; color: #333; }
    .container { text-align: center; max-width: 500px; padding: 40px; }
    h1 { font-size: 24px; margin-bottom: 16px; }
    p { color: #666; margin-bottom: 24px; }
    .error { font-size: 13px; color: #999; background: #eee; padding: 8px 16px; border-radius: 6px; margin-bottom: 24px; word-break: break-all; }
    button { background: #2563eb; color: white; border: none; padding: 12px 32px; border-radius: 8px; font-size: 16px; cursor: pointer; }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="container">
    <h1>No se pudo conectar</h1>
    <p>No se pudo cargar la aplicación desde:<br><strong>${url}</strong></p>
    <div class="error">${errorMessage}</div>
    <button onclick="location.reload()">Reintentar</button>
  </div>
</body>
</html>`;
  const errorFilePath = path.join(app.getPath('userData'), 'error.html');
  fs.writeFileSync(errorFilePath, html);
  win.loadFile(errorFilePath);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
