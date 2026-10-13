const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const isDev = !app.isPackaged;

// Buffer circular de logs del proceso principal (últimas 500 líneas)
const MAIN_LOG_MAX = 500;
const mainLogBuffer = [];
// webContents.id -> callback que reenvía cada entry a ese renderer
const mainLogListeners = new Map();

function stringifyArg(arg) {
  if (typeof arg === 'string') return arg;
  try {
    const json = JSON.stringify(arg, null, 2);
    return json === undefined ? String(arg) : json;
  } catch {
    // Estructuras circulares y objetos raros: se cae a String antes que romper
    // el log (y con él, la impresión).
    try {
      return String(arg);
    } catch {
      return '[no serializable]';
    }
  }
}

function pushMainLog(level, message, ...args) {
  const entry = {
    t: Date.now(),
    level,
    message: typeof message === 'string' ? message : String(message),
    args: args.map(stringifyArg),
  };
  mainLogBuffer.push(entry);
  if (mainLogBuffer.length > MAIN_LOG_MAX) mainLogBuffer.shift();
  // Notificar a listeners (UI en renderer)
  for (const cb of mainLogListeners.values()) {
    try { cb(entry); } catch {}
  }
  // También a consola nativa. OJO: tiene que ser la consola original, guardada
  // antes de interceptarla. Si se llama a console[level] aquí, esa llamada vuelve
  // a entrar en pushMainLog y se recursa hasta el "Maximum call stack size
  // exceeded", que es el error que veía el TPV en producción.
  (nativeConsole[level] || nativeConsole.log)(
    `[${new Date(entry.t).toISOString()}]`,
    message,
    ...args,
  );
}

// Interceptar console.* del main para que todo pase por el buffer
const nativeConsole = { log: console.log, warn: console.warn, error: console.error };
console.log = (...a) => pushMainLog('log', ...a);
console.warn = (...a) => pushMainLog('warn', ...a);
console.error = (...a) => pushMainLog('error', ...a);

// Una promesa rechazada sin capturar se queda en la consola de Windows, que en
// un TPV nadie mira. Se pasa por el log que la UI de Ajustes lee, que es lo
// único que ayuda a saber qué pasó en una instalación concreta.
process.on('unhandledRejection', (reason) => {
  console.error('Promesa rechazada sin capturar en el proceso principal:', reason);
});

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

// La aplicación es siempre la de producción. No hay forma de apuntarla a otro
// sitio a propósito: el TPV no se usa en desarrollo, y un `isDev ? ... : ...`
// en función de `app.isPackaged` ya dejó instalaciones viendo un `localhost` en
// el que no hay nada, que es una pantalla en blanco sin explicación.
const PROD_URL = 'https://apptpv.asoft.es';

// ---------------------------------------------------------------------------
// Sin caché
//
// El TPV se actualiza solo, sin instalar nada: si el navegador guarda la
// respuesta del servidor, una versión nueva desplegada no llega al TPV hasta que
// expire el TTL, y puede quedarse horas con la versión vieja.
//
// La única vía que se usa son las cabeceras de respuesta: `onHeadersReceived`
// quita las de cualquier tiempo de vida que declare el servidor —`Cache-Control`,
// `Expires`, `ETag`— y devuelve `no-store` en su lugar, y Chromium no guarda en
// memoria ni en disco una respuesta marcada así. Así que no depende de que
// Chromium respete un `max-age` ni del tamaño que le pongamos a la caché.
//
// Lo que NO se usa, y es importante: `session.setCacheSize(0)`. Ese método ya no
// existe en la API de sesión (las 40.6.1 con las que se compila sólo ofrecen
// `getCacheSize()` y `clearCache()`), así que llamarlo lanzaba un TypeError
// dentro de createWindow() antes de navegar y dejaba la ventana en blanco para
// siempre, sin log ni error visible. `clearCache()` sí existe, pero vacía la
// caché que hubiera: no impide que se escriba otra.
//
// La cabecera se pone en todas las respuestas de la sesión, incluidas las de
// terceros, para que ningún recurso (un `.woff2` de una CDN, por ejemplo)
// sobreviva a un reinicio de la aplicación.
//
// Esto no toca el almacenamiento del navegador: `localStorage`, `sessionStorage`,
// cookies e IndexedDB siguen en la partición `persist:tpv` y persisten como
// siempre. Lo que se pierde entre arranques son los ficheros cacheados
// (HTML, JS, CSS, imágenes), que es lo único que tiene que desaparecer.
// ---------------------------------------------------------------------------

const NO_CACHE_HEADERS = new Set([
  'cache-control',
  'pragma',
  'expires',
  'etag',
  'last-modified',
]);

const NO_CACHE_VALUE = 'no-store, no-cache, must-revalidate, max-age=0';

/**
 * Deja la sesión de la ventana con respuestas no cacheables.
 *
 * Todo va dentro de un try/catch a propósito: esto se ejecuta antes de navegar,
 * así que cualquier excepción aquí deja la ventana en blanco y sin explicación.
 * Que falle la limpieza de caché no puede ser motivo para que el TPV no arranque.
 */
function disableCaching(session) {
  try {
    session.clearCache().catch((err) => {
      console.warn('No se pudo vaciar la caché de la sesión:', err.message);
    });

    session.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = details.responseHeaders || {};

      // Las cabeceras llegan con el case tal cual lo mandó el servidor
      // ("Cache-Control", "cache-control", ...), así que se filtran sin
      // distinguirlas.
      for (const header of Object.keys(responseHeaders)) {
        if (NO_CACHE_HEADERS.has(header.toLowerCase())) delete responseHeaders[header];
      }

      responseHeaders['Cache-Control'] = NO_CACHE_VALUE;
      responseHeaders['Pragma'] = 'no-cache';
      responseHeaders['Expires'] = '0';

      callback({ cancel: false, responseHeaders });
    });
  } catch (err) {
    console.error('No se pudo desactivar la caché, se sigue con la de por defecto:', err.message);
  }
}

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

// ---------------------------------------------------------------------------
// Errores de carga
//
// La ventana se queda en blanco —pantalla blanca, sin mensaje y sin reacción a
// nada— cuando la carga no "falla" sino que no termina: la red del TPV está
// caída, el DNS no resuelve, o hay un proxy que acepta la conexión y no contesta
// nunca. En esos casos no salta ningún error y la aplicación se queda esperando
// en silencio. Además hay fallos que Electron no considera error de carga, como
// un 502 de un balanceador o un 504 por el TLS caducado, que llegan como una
// respuesta válida y pintan la página de error del propio Chromium (o nada).
//
// Por eso la carga se vigila por cuatro vías y, en cuanto una falla, se sustituye
// la ventana por una página de error propia que dice qué pasó y deja reintentar.
// ---------------------------------------------------------------------------

/** Sin cargar nada en ese tiempo, se da la carga por fallida. */
const PAGE_LOAD_TIMEOUT = 20000;

/** Margen que se le da a la app para pintar antes de darla por en blanco. */
const BLANK_GRACE_MS = 2500;

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

  disableCaching(mainWindow.webContents.session);

  const loadUrl = PROD_URL;

  // Evita mostrar dos veces la página de error (un fallo de carga dispara varios
  // de estos avisos).
  let showingError = false;
  let loadTimer = null;
  let blankTimer = null;

  const clearTimers = () => {
    clearTimeout(loadTimer);
    clearTimeout(blankTimer);
  };

  /** Sustituye la ventana por la página de error. `code` va al log y a la página. */
  const showError = (code, message) => {
    if (showingError || mainWindow.isDestroyed()) return;
    showingError = true;
    clearTimers();
    console.error(`[carga] ${loadUrl} -> ${code}: ${message}`);
    loadErrorPage(mainWindow, loadUrl, `${message} (${code})`);
  };

  // Reloj de la carga: es lo único que cubre el caso en el que la conexión se
  // queda colgada sin llegar a fallar nunca.
  const armLoadTimer = () => {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      showError('TIMEOUT', `El servidor no respondió en ${PAGE_LOAD_TIMEOUT / 1000} s`);
    }, PAGE_LOAD_TIMEOUT);
  };

  // Un HTTP >= 400 no cuenta como carga fallida: la respuesta llega y se
  // muestra la página de error del propio Chromium, que no explica nada. Se
  // sustituye por la nuestra, que sí.
  //
  // El recurso principal se identifica con 'mainFrame', no con 'main': ese
  // último valor no existe y la comparación nunca cuadraba, así que esta vía
  // estaba muerta y sólo funcionaba el fallo de carga de más abajo.
  mainWindow.webContents.session.webRequest.onCompleted((details) => {
    if (showingError) return;
    if (details.resourceType !== 'mainFrame') return;
    if (details.statusCode >= 400) {
      showError(`HTTP_${details.statusCode}`, `El servidor respondió ${details.statusCode}`);
    }
  });

  mainWindow.webContents.on('did-start-loading', armLoadTimer);

  mainWindow.webContents.on('did-finish-load', () => {
    clearTimers();
    // La propia página de error también dispara esto.
    if (isErrorPage(mainWindow)) return;
    // La app cargó (también puede ser después de pulsar Reintentar), así que un
    // error anterior deja de valer y este evento ya no pinta de blanco.
    showingError = false;
    mainWindow.setFullScreen(true);
    blankTimer = setTimeout(checkBlank, BLANK_GRACE_MS);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 es ERR_ABORTED: una carga cancelada por otra navegación, no un fallo de
    // conexión. Sin esta comprobación, recargar cancela la carga anterior y el
    // TPV se corta a sí mismo.
    if (errorCode === -3) return;

    // Un subframe que falla (un logo, un iframe de un tercero) no deja la app en
    // blanco, así que no se sustituye la ventana por una página de error.
    if (!isMainFrame) {
      console.warn('Fallo en un subframe:', validatedURL, errorCode, errorDescription);
      return;
    }

    showError(`ERR_${errorCode}`, errorDescription);
  });

  /**
   * Última comprobación: la carga terminó "bien" pero no pintó nada. Pasa cuando
   * el bundle de la SPA no monta (un error de JavaScript, una versión
   * incompatible), cuando el backend devuelve un 200 con el body vacío, o cuando
   * un error viene dentro de un JSON que la app no sabe mostrar.
   *
   * No basta con mirar que el body no tenga hijos: el HTML de producción es una
   * SPA y su body siempre contiene un `<div id="root">` vacío hasta que React
   * monta, así que ese criterio nunca se cumplía y la comprobación no detectaba
   * nada. Lo que se mira es si hay algo pintado: texto, o una imagen, un SVG, un
   * canvas o un vídeo. Un TPV en blanco es lo que sale cuando nada de eso existe.
   */
  const checkBlank = async () => {
    if (showingError || mainWindow.isDestroyed()) return;
    // Puede haber empezado otra navegación durante el margen.
    if (mainWindow.webContents.isLoading()) return;

    try {
      const blank = await mainWindow.webContents.executeJavaScript(
        `(() => {
          const b = document.body;
          if (!b) return true;
          if (b.textContent.trim()) return false;
          return !b.querySelector('img, svg, canvas, video, picture, iframe');
        })()`,
      );
      if (blank) showError('BLANK', 'La página se cargó pero se quedó en blanco');
    } catch (err) {
      // No es una página web, o ya se ha navegado: no hay nada que comprobar.
      console.warn('[carga] no se pudo comprobar la página en blanco:', err.message);
    }
  };

  const startLoad = () => {
    armLoadTimer();
    return mainWindow.loadURL(loadUrl).catch((err) => {
      showError('LOAD', err.message);
    });
  };

  startLoad();

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

    ipcMain.handle('main-log:subscribe', (event) => {
      const sender = event.sender;
      const cb = (entry) => sender.send('main-log:entry', entry);
      mainLogListeners.set(sender.id, cb);
      // Si el renderer se cierra sin desuscribirse (recarga, cierre de
      // pestaña), el callback se queda colgado: se limpia al destruirse.
      sender.once('destroyed', () => mainLogListeners.delete(sender.id));
      return true;
    });

    ipcMain.handle('main-log:unsubscribe', (event) => {
      mainLogListeners.delete(event.sender.id);
      return true;
    });

    // Reintentar desde la página de error. Va por IPC y no con `location.href`
    // para que el main pueda reiniciar la vigilancia de carga: si la app vuelve
    // a fallar, sin esto el error anterior seguiría en pantalla y la ventana se
    // quedaría en blanco otra vez.
    ipcMain.on('retry-load', () => {
      showingError = false;
      clearTimers();
      startLoad();
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

/** Ruta del fichero donde se escribe la página de error. */
function errorPagePath() {
  return path.join(app.getPath('userData'), 'error.html');
}

/** Si la ventana está mostrando nuestra página de error en vez de la app. */
function isErrorPage(win) {
  try {
    return win.webContents.getURL() === pathToFileURL(errorPagePath()).href;
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Sustituye lo que haya en la ventana por la página de error.
 *
 * `heading` y `hint` se personalizan porque no todo lo que llega aquí es un
 * problema de red: un fallo de la propia aplicación no puede decirle al
 * usuario que revise su conexión.
 */
function loadErrorPage(win, url, errorMessage, { heading, hint } = {}) {
  // La URL y el mensaje vienen de la red y de Chromium, así que se escapan
  // antes de meterse en el HTML.
  const safeUrl = escapeHtml(url);
  const safeMessage = escapeHtml(errorMessage);
  const safeHeading = escapeHtml(heading || 'No se pudo cargar el TPV');
  const safeHint = escapeHtml(hint || 'Revisa la conexión de red del equipo y vuelve a intentarlo.');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Asoft TPV - Error</title>
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
    <h1>${safeHeading}</h1>
    <p>No se pudo cargar la aplicación desde:<br><strong>${safeUrl}</strong></p>
    <p>${safeHint}</p>
    <div class="error">${safeMessage}</div>
    <button id="retry" data-url="${safeUrl}">Reintentar</button>
  </div>
  <script>
    document.getElementById('retry').addEventListener('click', function () {
      // Se avisa al proceso principal, que reinicia la vigilancia de carga: si
      // la app vuelve a fallar tiene que poder mostrar el error otra vez. Si el
      // preload no estuviera disponible (y no debería), se navega igualmente.
      if (window.electron && window.electron.retryLoad) {
        window.electron.retryLoad();
      } else {
        location.href = this.dataset.url;
      }
    });
  </script>
</body>
</html>`;
  fs.writeFileSync(errorPagePath(), html);
  win.loadFile(errorPagePath());
}

/**
 * Un fallo del proceso principal antes de navegar deja la ventana en blanco y
 * sin decir nada: eso fue exactamente lo que pasó con una API de sesión que ya
 * no existía, y ni log ni error visible. Si la aplicación ni siquiera ha
 * podido arrancar, tiene que verse en pantalla.
 */
function showFatalError(err) {
  const message = err?.stack || err?.message || String(err);
  console.error('La aplicación no ha podido arrancar:', err);

  const win = BrowserWindow.getAllWindows()[0];

  if (win && !win.isDestroyed()) {
    try {
      loadErrorPage(win, PROD_URL, message, {
        heading: 'No se pudo iniciar el TPV',
        hint: 'Esto es un fallo de la aplicación instalada, no de la conexión. Reinicia el equipo y, si sigue igual, reinstala el TPV.',
      });
      return;
    } catch (pageErr) {
      console.error('Tampoco se ha podido mostrar la página de error:', pageErr.message);
    }
  }

  dialog.showErrorBox('Asoft TPV', `No se pudo iniciar la aplicación:\n\n${message}`);
}

app.whenReady()
  .then(createWindow)
  .catch(showFatalError);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    Promise.resolve().then(createWindow).catch(showFatalError);
  }
});
