# Agest Desktop

Aplicacion de escritorio para el sistema TPV de ASoft, construida con Electron. Envuelve la aplicacion web [apptpv.asoft.es](https://apptpv.asoft.es) en un cliente nativo con soporte para impresion de tickets POS.

## Caracteristicas

- Cliente de escritorio nativo multiplataforma (Windows, macOS, Linux)
- Impresion de tickets mediante impresoras POS (via `electron-pos-printer`)
- Modo pantalla completa para uso en terminales de punto de venta
- Sesion persistente entre reinicios de la aplicacion

## Requisitos

- [Node.js](https://nodejs.org/) >= 18
- npm

## Instalacion

```bash
git clone https://github.com/asoft-sl/agest-desktop.git
cd agest-desktop
npm install
```

## Uso

### Desarrollo

```bash
npm start
```

### Generar ejecutable

```bash
npm run package
```

### Crear instalador

```bash
npm run make
```

Los instaladores se generan en el directorio `out/` para la plataforma actual:

| Plataforma | Formato          |
|------------|------------------|
| Windows    | Squirrel (.exe)  |
| macOS      | ZIP              |
| Linux      | DEB, RPM         |

## Estructura del proyecto

```
agest-desktop/
├── src/
│   ├── index.js       # Proceso principal de Electron
│   ├── preload.js     # Script de preload (bridge de impresion)
│   ├── index.html     # Pagina de fallback
│   └── index.css      # Estilos de fallback
├── forge.config.js    # Configuracion de Electron Forge
└── package.json
```

## API expuesta al contexto web

A traves del preload script, la aplicacion web tiene acceso a:

```js
// Obtener lista de impresoras del sistema
const printers = await window.electron.getPrinters();

// Imprimir un ticket
await window.electron.printTicket(data, options);
```

## Tecnologias

- [Electron](https://www.electronjs.org/) 28
- [Electron Forge](https://www.electronforge.io/) 7
- [electron-pos-printer](https://github.com/nicholowen/electron-pos-printer)

## Licencia

MIT - [ASoft SL](mailto:info@asoft.es)
