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

## Publicar una versión

Las releases se compilan solas en GitHub Actions: basta con publicar una
etiqueta y el instalador de Windows aparece en la sección Releases del repo.

```bash
# 1. Sube los cambios
git add .
git commit -m "feat: ..."
git push origin main

# 2. Publica la etiqueta con la versión (v1.0, v1.1, v2.0...)
git tag v1.1
git push origin v1.1
```

La Actions compila con `npm run make`, sube el `.exe` como artefacto y abre la
release con las notas de cambios y el instalador adjunto. También se puede
lanzar a mano desde **Actions > Release > Run workflow**, pero sin publicar
etiqueta no se crea ninguna release.

El TPV descarga la última versión desde **Ajustes > General > Aplicación de
escritorio**, así que la release tiene que dejar el `.exe` como adjunto.

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

## El papel de la impresora

El TPV manda en `options.pageSize` el ancho del rollo tal cual (`'80mm'`, `'58mm'`) y Electron lo traduce al tamaño real de pagina, asi que el ancho llega a la impresora. Lo que no llega bien es el alto: cuando `pageSize` es un texto, `electron-pos-printer` pone de alto la altura del contenido del ticket, una medida que no corresponde a ningun formulario del driver. Los drivers de rollo sustituyen ese papel por su propio (normalmente A4) y el ticket sale encogido y centrado sobre el rollo.

Por eso, antes de imprimir, `resolvePageSize()` pregunta a la impresora que formularios declara —en Windows vienen en el `printer-capabilities` que devuelve `getPrinters()`— y si alguno es del ancho del rollo, le pide ese formulario tal cual, que es papel que el driver no va a sustituir. Si la impresora no anuncia ninguno (en macOS y Linux no los anuncian) se manda el rollo como siempre y decide el driver.

## Tecnologias

- [Electron](https://www.electronjs.org/) 40
- [Electron Forge](https://www.electronforge.io/) 7
- [electron-pos-printer](https://github.com/nicholowen/electron-pos-printer)

## Licencia

MIT - [ASoft SL](mailto:info@asoft.es)
