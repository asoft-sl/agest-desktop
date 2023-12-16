const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { PosPrinter } = require("electron-pos-printer");

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  //detect if the app is running in development mode
  const isDev = require('electron-is-dev');

  //if it is, load the app from the localhost
  //otherwise load the app from the server
  const loadUrl = isDev ? 'http://localhost:5173' : 'https://tpv.asoft.es';

  // and load the app.
  mainWindow.loadURL(loadUrl);


  // Open the DevTools.
  mainWindow.webContents.openDevTools();

  //get the printers list
  ipcMain.handle('get-printers', async () => {
    //get the printers list from the system
    const printers = await mainWindow.webContents.getPrintersAsync();

    return printers;
  });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.




// const options = {
//   preview: false,
//   margin: '0 0 0 0',
//   copies: 1,
//   printerName: 'XP-80C',
//   timeOutPerLine: 400,
//   pageSize: '80mm' // page size
// }

// const data = [
//   {
//     type: 'image',
//     url: 'https://randomuser.me/api/portraits/men/43.jpg',     // file path
//     position: 'center',                                  // position of image: 'left' | 'center' | 'right'
//     width: '160px',                                           // width of image in px; default: auto
//     height: '60px',                                          // width of image in px; default: 50 or '50px'
//   }, {
//     type: 'text',                                       // 'text' | 'barCode' | 'qrCode' | 'image' | 'table
//     value: 'SAMPLE HEADING',
//     style: { fontWeight: "700", textAlign: 'center', fontSize: "24px" }
//   }
// ]

// PosPrinter.print(data, options)
//   .then(console.log)
//   .catch((error) => {
//     console.error(error);
//   });