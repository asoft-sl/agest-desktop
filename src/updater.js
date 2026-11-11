/**
 * Actualización del TPV en Windows.
 *
 * La release de GitHub trae el Setup.exe de Squirrel. `start` lo descarga a una
 * carpeta temporal y va contando bytes: no abre otra ventana ni pregunta dónde
 * guardarlo. Cuando el archivo está entero, el estado pasa a `downloaded` y la
 * página muestra el botón de instalar. `install` lanza ese exe con --silent:
 * Squirrel deja la versión nueva en su propia carpeta (app-x.y.z) y el proceso
 * que está vendiendo sigue vivo. El reinicio solo ocurre cuando el renderer
 * llama a finish().
 */

const { app, net, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'asoft-sl/agest-desktop';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_DELAY_MS = 15000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const PROGRESS_EMIT_MS = 150;

const ALLOWED_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
]);

let started = false;
let checking = false;
let task = null;
let latest = null;
let lastProgressEmit = 0;

const listeners = new Map();

let state = {
  supported: false,
  checked: false,
  checkFailed: false,
  status: 'idle',
  currentVersion: '',
  nextVersion: null,
  tag: null,
  notes: '',
  percent: null,
  received: 0,
  total: 0,
  installerSize: null,
  installerName: null,
  installerReady: false,
  error: null,
};

function isSupported() {
  // También en el Electron de desarrollo: si no, la página cae al enlace y
  // Chromium abre otra ventana con el diálogo de guardar.
  return process.platform === 'win32';
}

function getState() {
  return { ...state };
}

function patch(partial) {
  state = { ...state, ...partial };
  const snapshot = getState();
  for (const [id, sender] of listeners) {
    if (sender.isDestroyed()) {
      listeners.delete(id);
      continue;
    }
    try {
      sender.send('updater:state', snapshot);
    } catch {
      listeners.delete(id);
    }
  }
}

function versionParts(value) {
  const [major = 0, minor = 0, patchNumber = 0] = String(value || '')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => parseInt(part, 10) || 0);
  return [major, minor, patchNumber];
}

function isNewerVersion(candidate, installed) {
  if (!candidate) return false;
  const [major, minor, patchNumber] = versionParts(candidate);
  const [currentMajor, currentMinor, currentPatch] = versionParts(installed);
  return (
    major > currentMajor
    || (major === currentMajor && minor > currentMinor)
    || (major === currentMajor && minor === currentMinor && patchNumber > currentPatch)
  );
}

function updateDir() {
  return path.join(os.tmpdir(), 'asoft-tpv-update');
}

function stateFile() {
  return path.join(app.getPath('userData'), 'update-state.json');
}

function readSaved() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

function writeSaved(data) {
  const file = stateFile();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function clearSaved() {
  try {
    fs.unlinkSync(stateFile());
  } catch {
    // No había nada guardado.
  }
}

function installerFileName(name) {
  const base = path.basename(String(name || 'AsoftTPV-Setup.exe'))
    .replace(/[^A-Za-z0-9._ -]/g, '_');
  if (!base.toLowerCase().endsWith('.exe')) return 'AsoftTPV-Setup.exe';
  return base;
}

function removeTempInstallers(keepName) {
  let entries = [];
  try {
    entries = fs.readdirSync(updateDir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (keepName && (entry === keepName || entry === `${keepName}.part`)) continue;
    if (!entry.endsWith('.exe') && !entry.endsWith('.part') && entry !== 'relaunch.cmd') continue;
    try {
      fs.rmSync(path.join(updateDir(), entry), { force: true });
    } catch (err) {
      console.warn('[updater] no se pudo borrar el temporal:', entry, err.message);
    }
  }
}

/**
 * Un exe bajado por Chromium lleva la marca de zona. Sin firmar, SmartScreen
 * puede plantar un diálogo encima de la caja. Quitar el ADS no firma nada,
 * pero evita el aviso que solo existe por haber pasado por el navegador.
 */
function clearMarkOfTheWeb(filePath) {
  if (process.platform !== 'win32') return;
  try {
    fs.unlinkSync(`${filePath}:Zone.Identifier`);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('[updater] no se pudo quitar la marca de descarga:', err.message);
    }
  }
}

function headerValue(headers, name) {
  if (!headers) return '';
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function pickInstaller(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const exes = assets.filter((asset) => String(asset.name || '').toLowerCase().endsWith('.exe'));
  const setup = exes.find((asset) => /setup/i.test(asset.name || '')) || exes[0];
  if (!setup || !setup.browser_download_url) return null;

  let url;
  try {
    url = new URL(setup.browser_download_url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) return null;

  return {
    url: url.href,
    name: setup.name,
    size: Number(setup.size) || null,
    tag: release.tag_name || '',
    version: String(release.tag_name || '').replace(/^v/i, ''),
    notes: release.body || '',
  };
}

function fetchLatest() {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url: LATEST_RELEASE_URL, redirect: 'follow' });
    request.setHeader('Accept', 'application/vnd.github+json');
    request.setHeader('User-Agent', 'AsoftTPV-Updater');
    let body = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      request.abort();
      const error = new Error('No se ha podido comprobar la última versión');
      error.code = 'unreachable';
      finish(error);
    }, 20000);

    request.on('response', (response) => {
      response.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      response.on('end', () => {
        if (response.statusCode === 404) {
          const error = new Error('Todavía no hay ninguna versión publicada');
          error.code = 'no-releases';
          finish(error);
          return;
        }
        if (response.statusCode !== 200) {
          const error = new Error(
            response.statusCode === 403
              ? 'GitHub no ha podido comprobar las versiones'
              : 'No se ha podido comprobar la última versión',
          );
          error.code = 'unreachable';
          finish(error);
          return;
        }
        try {
          finish(null, JSON.parse(body));
        } catch (err) {
          finish(err);
        }
      });
    });
    request.on('error', (error) => finish(error));
    request.end();
  });
}

function savedInstaller(release) {
  const saved = readSaved();
  if (!saved || saved.version !== release.version) return null;
  if (saved.phase === 'applied') return { phase: 'applied' };
  if (!saved.installerPath) return null;
  try {
    const stat = fs.statSync(saved.installerPath);
    if (!saved.size || stat.size === saved.size) {
      return { phase: 'downloaded', path: saved.installerPath };
    }
  } catch {
    // El temporal ya no está: hay que volver a pedir confirmación.
  }
  return null;
}

function rememberRelease(release) {
  latest = release;
  return {
    nextVersion: release.version,
    tag: release.tag,
    notes: release.notes,
    installerSize: release.size,
    installerName: release.name,
    total: release.size || 0,
    checkFailed: false,
    checked: true,
    currentVersion: app.getVersion(),
  };
}

function releaseStillPending(release) {
  return !!release && isNewerVersion(release.version, app.getVersion());
}

/** Baja la ficha de la release. No cambia el estado de la UI. */
async function loadLatest() {
  const release = pickInstaller(await fetchLatest());
  if (!releaseStillPending(release)) {
    latest = null;
    return null;
  }
  latest = release;
  return release;
}

async function check() {
  if (!isSupported() || checking || task) return;
  if (
    state.status === 'downloading'
    || state.status === 'downloaded'
    || state.status === 'applying'
    || state.status === 'ready'
    || state.status === 'error'
  ) {
    return;
  }

  checking = true;
  try {
    let release;
    try {
      release = await loadLatest();
    } catch (err) {
      if (err.code === 'no-releases') {
        patch({ checked: true, checkFailed: false, status: 'idle' });
        return;
      }
      console.warn('[updater] no se pudo comprobar la versión:', err.message);
      if (state.status === 'idle') patch({ checked: true, checkFailed: true });
      return;
    }

    if (!release) {
      clearSaved();
      removeTempInstallers();
      patch({
        checked: true,
        checkFailed: false,
        status: 'idle',
        nextVersion: null,
        tag: null,
        notes: '',
        installerSize: null,
        installerName: null,
        installerReady: false,
        percent: null,
        error: null,
        currentVersion: app.getVersion(),
      });
      return;
    }

    const saved = savedInstaller(release);
    const info = rememberRelease(release);
    if (saved?.phase === 'applied') {
      patch({ ...info, status: 'ready', percent: null, error: null, installerReady: false });
      return;
    }
    if (saved?.phase === 'downloaded') {
      patch({
        ...info,
        status: 'downloaded',
        percent: 100,
        received: release.size || 0,
        error: null,
        installerReady: true,
      });
      return;
    }

    clearSaved();
    patch({
      ...info,
      status: 'available',
      percent: null,
      error: null,
      received: 0,
      installerReady: false,
    });
  } finally {
    checking = false;
  }
}

function reportProgress(received, total) {
  const percent = total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : null;
  state = { ...state, received, total, percent, status: 'downloading' };
  const now = Date.now();
  if (now - lastProgressEmit < PROGRESS_EMIT_MS && percent !== 99) return;
  lastProgressEmit = now;
  patch({});
}

function download(release) {
  const fileName = installerFileName(release.name);
  const dir = updateDir();
  fs.mkdirSync(dir, { recursive: true });
  removeTempInstallers(fileName);

  const finalPath = path.join(dir, fileName);
  const partPath = `${finalPath}.part`;
  try {
    fs.rmSync(partPath, { force: true });
  } catch {
    // No había una descarga a medias.
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, filePath) => {
      if (settled) return;
      settled = true;
      if (error) {
        try { fs.rmSync(partPath, { force: true }); } catch { /* parcial inservible */ }
        reject(error instanceof Error ? error : new Error('No se ha podido descargar la actualización'));
        return;
      }
      resolve(filePath);
    };

    const request = net.request({ method: 'GET', url: release.url, redirect: 'follow' });
    request.setHeader('Accept', 'application/octet-stream');
    request.setHeader('User-Agent', 'AsoftTPV-Updater');

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error('No se ha podido descargar la actualización'));
        return;
      }

      const total = Number(headerValue(response.headers, 'content-length')) || release.size || 0;
      const file = fs.createWriteStream(partPath);
      let received = 0;
      let stall = null;
      const armStall = () => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          request.abort();
          abort(new Error('No se ha podido descargar la actualización'));
        }, 60000);
      };

      const abort = (error) => {
        clearTimeout(stall);
        response.unpipe?.();
        file.destroy();
        finish(error);
      };
      armStall();

      response.on('data', (chunk) => {
        if (settled) return;
        armStall();
        received += chunk.length;
        if (!file.write(chunk)) {
          response.pause();
          file.once('drain', () => response.resume());
        }
        reportProgress(received, total);
      });
      response.on('aborted', () => abort(new Error('No se ha podido descargar la actualización')));
      response.on('error', (error) => abort(error));
      response.on('end', () => {
        if (settled) return;
        clearTimeout(stall);
        file.end(() => {
          if (received <= 0 || (release.size && received !== release.size)) {
            finish(new Error('La descarga no ha llegado entera'));
            return;
          }
          try {
            fs.renameSync(partPath, finalPath);
          } catch (err) {
            finish(err);
            return;
          }
          clearMarkOfTheWeb(finalPath);
          finish(null, finalPath);
        });
      });
      file.on('error', (error) => abort(error));
    });
    request.on('error', (error) => finish(error));
    request.end();
  });
}

function runInstaller(installerPath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(installerPath, ['--silent'], {
        cwd: path.dirname(installerPath),
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (err) {
      resolve({ code: -1, error: err.message });
      return;
    }
    child.on('error', (err) => resolve({ code: -1, error: err.message }));
    child.on('exit', (code) => resolve({ code: code == null ? -1 : code }));
  });
}

async function apply(installerPath, release) {
  writeSaved({
    version: release.version,
    tag: release.tag,
    notes: release.notes,
    size: release.size,
    phase: 'downloaded',
    installerPath,
  });
  patch({
    ...rememberRelease(release),
    status: 'applying',
    percent: null,
    error: null,
  });
  console.log('[updater] instalando en silencio', release.version);

  const result = await runInstaller(installerPath);
  if (result.code !== 0) {
    throw new Error(`El instalador ha fallado (código ${result.code}). Puedes reintentar sin cerrar la caja.`);
  }

  try {
    fs.rmSync(installerPath, { force: true });
  } catch {
    // La instalación ya está hecha; el temporal es prescindible.
  }
  writeSaved({
    version: release.version,
    tag: release.tag,
    notes: release.notes,
    size: release.size,
    phase: 'applied',
    installerPath: null,
  });
  patch({ status: 'ready', percent: null, error: null, installerReady: false });
  console.log('[updater] lista para reiniciar', release.version);
}

function fail(err) {
  const message = err?.message || 'No se ha podido actualizar';
  console.error('[updater]', message);
  const saved = latest && savedInstaller(latest);
  patch({
    status: 'error',
    error: message,
    percent: null,
    installerReady: saved?.phase === 'downloaded',
  });
}

function markDownloaded(release, filePath) {
  let received = release.size || 0;
  try {
    received = fs.statSync(filePath).size;
  } catch {
    // El tamaño de la release basta para la barra.
  }
  writeSaved({
    version: release.version,
    tag: release.tag,
    notes: release.notes,
    size: release.size,
    phase: 'downloaded',
    installerPath: filePath,
  });
  patch({
    ...rememberRelease(release),
    status: 'downloaded',
    percent: 100,
    received,
    total: release.size || received,
    error: null,
    installerReady: true,
  });
  console.log('[updater] descarga lista', release.version, filePath);
}

function beginUpdate() {
  if (!isSupported()) return getState();
  if (
    task
    || state.status === 'downloading'
    || state.status === 'downloaded'
    || state.status === 'applying'
    || state.status === 'ready'
  ) {
    return getState();
  }

  // El renderer pinta la barra en cuanto vuelve este IPC. El estado tiene que
  // cambiar antes del primer await, o no hay avance hasta que GitHub conteste.
  if (releaseStillPending(latest)) {
    const saved = savedInstaller(latest);
    if (saved?.phase === 'applied') {
      patch({ ...rememberRelease(latest), status: 'ready', percent: null, error: null, installerReady: false });
      return getState();
    }
    if (saved?.phase === 'downloaded') {
      markDownloaded(latest, saved.path);
      return getState();
    }
    patch({
      ...rememberRelease(latest),
      status: 'downloading',
      percent: 0,
      received: 0,
      error: null,
      installerReady: false,
    });
  }

  task = (async () => {
    if (!releaseStillPending(latest)) {
      try {
        await loadLatest();
      } catch (err) {
        if (err.code !== 'no-releases') {
          console.warn('[updater] no se pudo comprobar la versión:', err.message);
        }
      }
    }
    if (!releaseStillPending(latest)) {
      patch({ checked: true, checkFailed: false, status: 'idle', error: null });
      return;
    }

    const saved = savedInstaller(latest);
    if (saved?.phase === 'applied') {
      patch({ ...rememberRelease(latest), status: 'ready', percent: null, error: null, installerReady: false });
      return;
    }
    if (saved?.phase === 'downloaded') {
      markDownloaded(latest, saved.path);
      return;
    }

    patch({
      ...rememberRelease(latest),
      status: 'downloading',
      percent: 0,
      received: 0,
      error: null,
      installerReady: false,
    });
    const file = await download(latest);
    markDownloaded(latest, file);
  })().catch(fail).finally(() => {
    task = null;
  });

  return getState();
}

function install() {
  if (!isSupported()) return getState();
  if (task || state.status === 'downloading' || state.status === 'applying' || state.status === 'ready') {
    return getState();
  }

  const saved = latest && savedInstaller(latest);
  if (!saved || saved.phase !== 'downloaded') {
    patch({
      status: state.status === 'downloaded' || state.status === 'error' ? 'available' : state.status,
      installerReady: false,
      error: null,
    });
    return beginUpdate();
  }

  patch({
    ...rememberRelease(latest),
    status: 'applying',
    percent: null,
    error: null,
    installerReady: true,
  });
  task = apply(saved.path, latest)
    .catch(fail)
    .finally(() => {
      task = null;
    });
  return getState();
}

function quoteCmd(value) {
  return `"${String(value).replace(/"/g, '')}"`;
}

/**
 * Update.exe tiene que arrancar cuando este proceso ya ha soltado el cierre
 * de instancia única. Si no, la versión nueva se ve como segunda instancia,
 * se cierra, y esta también: el TPV se queda apagado. El .cmd espera a que
 * este PID desaparezca y entonces lanza el stub de Squirrel, que abre la
 * versión más alta. `start` lo saca del job de Electron, que si no mataría
 * al hijo al salir.
 */
function finish() {
  if (state.status !== 'ready') {
    return { ok: false, error: 'La actualización todavía no está lista' };
  }

  const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  const exeName = path.basename(process.execPath);
  if (!fs.existsSync(updateExe)) {
    const error = 'No se puede reiniciar a la versión nueva desde esta instalación';
    patch({ status: 'error', error });
    return { ok: false, error };
  }

  const scriptPath = path.join(updateDir(), 'relaunch.cmd');
  const script = [
    '@echo off',
    'setlocal',
    ':wait',
    `tasklist /FI "PID eq ${process.pid}" | find "${process.pid}" >nul`,
    'if not errorlevel 1 (',
    '  ping -n 2 127.0.0.1 >nul',
    '  goto wait',
    ')',
    `start "" ${quoteCmd(updateExe)} --processStart ${quoteCmd(exeName)}`,
    'endlocal',
    '',
  ].join('\r\n');

  try {
    fs.mkdirSync(updateDir(), { recursive: true });
    fs.writeFileSync(scriptPath, script, 'utf8');
    const child = spawn('cmd.exe', ['/d', '/c', 'start', '', '/min', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    const error = 'No se ha podido preparar el reinicio';
    console.error('[updater]', error, err.message);
    patch({ status: 'error', error });
    return { ok: false, error };
  }

  console.log('[updater] el usuario termina la instalación; se cierra el TPV');
  app.quit();
  return { ok: true };
}

function registerIpc() {
  if (ipcMain.listenerCount('updater:get-state') > 0) return;

  ipcMain.handle('updater:get-state', () => getState());
  ipcMain.handle('updater:start', () => beginUpdate());
  ipcMain.handle('updater:install', () => install());
  ipcMain.handle('updater:finish', () => finish());
  ipcMain.handle('updater:check', () => {
    if (
      state.status === 'downloading'
      || state.status === 'downloaded'
      || state.status === 'applying'
      || state.status === 'ready'
    ) {
      return getState();
    }
    state = { ...state, status: state.status === 'error' ? 'idle' : state.status, checkFailed: false };
    check();
    return getState();
  });
  ipcMain.handle('updater:subscribe', (event) => {
    const sender = event.sender;
    listeners.set(sender.id, sender);
    sender.once('destroyed', () => listeners.delete(sender.id));
    sender.send('updater:state', getState());
    return true;
  });
  ipcMain.handle('updater:unsubscribe', (event) => {
    listeners.delete(event.sender.id);
    return true;
  });
}

function startUpdater() {
  if (started) return;
  started = true;
  state = {
    ...state,
    supported: isSupported(),
    currentVersion: app.getVersion(),
  };
  registerIpc();
  if (!state.supported) return;

  setTimeout(() => {
    check();
    setInterval(() => {
      check();
    }, CHECK_INTERVAL_MS);
  }, CHECK_DELAY_MS);
}

module.exports = { startUpdater };
