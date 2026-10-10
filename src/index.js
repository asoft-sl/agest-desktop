const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;

// Buffer circular de logs del proceso principal (últimas 500 líneas)
const MAIN_LOG_MAX = 500;
const mainLogBuffer = [];
const mainLogListeners = new Set();

function pushMainLog(level, message, ...args) {
  const entry = {
    t: Date.now(),
    level,
    message: typeof message === 'string' ? message : String(message),
    args: args.map(a => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))),
  };
  mainLogBuffer.push(entry);
  if (mainLogBuffer.length > MAIN_LOG_MAX) mainLogBuffer.shift();
  // Notificar a listeners (UI en renderer)
  for (const cb of mainLogListeners) {
    try { cb(entry); } catch {}
  }
  // También a consola nativa
  console[level](`[${new Date(entry.t).toISOString()}]`, message, ...args);
}

// Interceptar console.* del main para que todo pase por el buffer
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
console.log = (...a) => pushMainLog('log', ...a);
console.warn = (...a) => pushMainLog('warn', ...a);
console.error = (...a) => pushMainLog('error', ...a);

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

// ---------------------------------------------------------------------------
// El papel de la impresora
//
// electron-pos-printer manda el ancho del rollo ('80mm' / '58mm') y Electron lo
// traduce al tamaño real de página, así que el ancho sí llega a la impresora.
// Lo que falla es el alto: cuando `pageSize` es un texto, la librería pone de
// alto la altura del contenido del ticket (post-printer.ts), una medida que no
// corresponde a ningún formulario del driver. Los drivers de rollo no tienen
// ese formulario, así que lo sustituyen por su papel por defecto —normalmente
// A4— y el ticket sale encogido sobre el rollo: texto pequeño y centrado, con
// márgenes a los lados. Lo mismo pasa al imprimir en directo; con el diálogo se
// ve bien porque el usuario elige a mano el rollo.
//
// Por eso, antes de imprimir se pregunta a la impresora qué formularios
// declara y, si alguno es del ancho del rollo, se pide ese formulario tal cual
// (mismo ancho y mismo alto), que es papel que el driver conoce y no va a
// sustituir. Si la impresora no anuncia ninguno —en macOS y Linux no los
// anuncian— se manda el rollo como siempre y decide el driver.
// ---------------------------------------------------------------------------

// 1 px = 264.5833 micras, la conversión que hace electron-pos-printer.
const MICRONS_PER_PIXEL = 264.5833;

// Los drivers miden el rollo un poco justo (72, 76, 78 mm...) y no siempre
// cuadran al milímetro, así que se acepta el formulario que más se le parezca.
const MICRONS_TOLERANCE = 2000;

// Tope del alto de página: 1,5 m, de sobra para un rollo y por debajo del
// límite de Chromium (200 pulgadas) y del tamaño de ventana que aguanta Windows.
const MAX_PAGE_MICROS = 1500000;

/** Ancho del rollo en micras a partir del `pageSize` del TPV ('80mm', '58mm'). */
function rollMicrons(pageSize) {
  if (typeof pageSize !== 'string') return null;

  const width = parseFloat(pageSize);
  return Number.isFinite(width) ? Math.ceil(width * 1000) : null;
}

/**
 * Formularios que declara el driver. En Windows vienen en el JSON de
 * `printer-capabilities` de cada impresora (`{ paperSizes: [{ name, size: {
 * width_microns, height_microns }, isDefault }] }`); en macOS y Linux no
 * existen y se devuelve una lista vacía.
 */
function driverPaperSizes(printer) {
  const capabilities = printer?.options?.['printer-capabilities'];
  if (typeof capabilities !== 'string') return [];

  try {
    return JSON.parse(capabilities).paperSizes || [];
  } catch (e) {
    console.warn('printer-capabilities ilegible:', e.message);
    return [];
  }
}

/**
 * Chromium solo admite páginas de 353 micras (0,35 mm) a 200 pulgadas, y el
 * alto del formulario es el que acaba mandando la librería como alto de la
 * página: un rollo continuo declarado como "10 m" daría una ventana de 38000
 * píxeles que Windows no crea. Un formulario fuera de rango no sirve, así que se
 * descarta y se sigue con el ancho del rollo como hasta ahora.
 */
function usableForm(paper) {
  if (!paper?.size) return null;

  const width = Number(paper.size.width_microns);
  const height = Number(paper.size.height_microns);

  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 353 || height < 353) return null;
  if (height > MAX_PAGE_MICROS) return null;

  return paper;
}

/**
 * Devuelve el `pageSize` que se le pasa a electron-pos-printer: el formulario
 * del rollo que declara la impresora, o el que venga si no declara ninguno.
 *
 * El objeto va en píxeles porque electron-pos-printer lo convierte a micras con
 * la misma constante, así que el ancho y el alto que salen son los del
 * formulario. Además, al ser un objeto la librería deja de medir el contenido
 * para poner ese alto como alto de página.
 */
async function resolvePageSize(options, win) {
  const width = rollMicrons(options?.pageSize);
  if (!width || !options?.printerName) return options?.pageSize;

  const printers = await win.webContents.getPrintersAsync();
  const printer = printers.find((p) => p.name === options.printerName);
  const sizes = driverPaperSizes(printer);

  // Primero el que el driver tiene por defecto y luego el que coincida, por si
  // el ancho del rollo aparece en más de un formulario.
  const paper = sizes
    .filter((s) => Number.isFinite(Number(s.size?.width_microns)))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .find((s) => Math.abs(Number(s.size.width_microns) - width) <= MICRONS_TOLERANCE);

  const page = usableForm(paper);
  if (!page) {
    // No hay formulario del rollo: se manda el ancho como siempre y decide el
    // driver. El log dice si la impresora es que no los anuncia (macOS y Linux)
    // o si es que los tiene, pero ninguno del ancho pedido.
    console.log(
      `[impresion] ${options.printerName} no declara un formulario de ${width / 1000}mm;`,
      `formularios: ${sizes.map((s) => s.name).join(', ') || 'ninguno'}`,
    );
    return options.pageSize;
  }

  console.log(
    `[impresion] ${options.printerName}: ${options.pageSize} -> ${paper.name}`,
    `(${Number(paper.size.width_microns) / 1000}x${Number(paper.size.height_microns) / 1000}mm)`,
  );

  return {
    width: Number(paper.size.width_microns) / MICRONS_PER_PIXEL,
    height: Number(paper.size.height_microns) / MICRONS_PER_PIXEL,
  };
}

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
      return activeWindow(mainWindow).webContents.getPrintersAsync();
    });

    ipcMain.handle('print-ticket', async (_event, data, options) => {
      if (!PosPrinter) throw new Error('Printer module not available');

      // El papel lo decide la impresora: si declara un formulario del ancho del
      // rollo se le pide ese, que no va a sustituir por otro.
      const pageSize = await resolvePageSize(options, activeWindow(mainWindow));
      return PosPrinter.print(data, { ...options, pageSize });
    });

    // Logs del proceso principal para la UI de Ajustes
    ipcMain.handle('main-log:get', () => mainLogBuffer.slice(-200));

    ipcMain.handle('main-log:subscribe', (_event, rendererId) => {
      // El renderer manda su ID; le devolvemos un handler para cancelar
      const cb = (entry) => {
        _event.sender.send('main-log:entry', entry);
      };
      mainLogListeners.add(cb);
      // Devolver función de cleanup (el renderer la llamará al desmontar)
      return () => mainLogListeners.delete(cb);
    });
  }
};

/**
 * La ventana desde la que se consulta el sistema de impresión. La enfocada es
 * la del TPV, que es la que tiene el preload y la que llama; la principal es el
 * respaldo para cuando no haya ninguna enfocada.
 */
function activeWindow(mainWindow) {
  return BrowserWindow.getFocusedWindow() || mainWindow;
}

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
