const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { listCertificates, signWithCertificate } = require('./wincert.cjs');

const DIST = path.join(__dirname, '..', 'dist');

// Protocolo próprio (app://): o pdf.js e o OCR usam workers e fetch, que não
// funcionam bem com file://.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win = null;
let rendererReady = false;
let dirty = false;
const pending = [];

function pdfArg(argv) {
  return argv.slice(1).find((a) => /\.pdf$/i.test(a) && !a.startsWith('--'));
}

async function sendFile(filePath) {
  if (!filePath) return;
  try {
    const bytes = await fs.readFile(filePath);
    const file = { name: path.basename(filePath), bytes: new Uint8Array(bytes) };
    if (win && rendererReady) win.webContents.send('open-file', file);
    else pending.push(file);
  } catch (e) {
    dialog.showErrorBox('PDF Studio', `Não foi possível abrir ${filePath}: ${e.message}`);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'PDF Studio',
    backgroundColor: '#eef0f3',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  win.on('close', (e) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Sair sem salvar', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'PDF Studio',
      message: 'Há alterações não salvas.',
      detail: 'Se sair agora, as alterações feitas no documento serão perdidas.',
    });
    if (choice === 1) e.preventDefault();
  });
  win.on('closed', () => {
    win = null;
    rendererReady = false;
  });
  void win.loadURL('app://pdf-studio/index.html');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    void sendFile(pdfArg(argv));
  });
  app.on('open-file', (e, filePath) => {
    e.preventDefault();
    void sendFile(filePath);
  });

  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      const { pathname } = new URL(req.url);
      const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      const file = path.normalize(path.join(DIST, rel));
      if (!file.startsWith(DIST + path.sep)) return new Response('Proibido', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });

    ipcMain.on('renderer-ready', () => {
      rendererReady = true;
      while (pending.length) win?.webContents.send('open-file', pending.shift());
    });
    ipcMain.on('set-dirty', (_e, value) => (dirty = value));
    ipcMain.handle('save-file', async (_e, { bytes, suggestedName, filePath }) => {
      let target = filePath;
      if (!target) {
        if (process.env.PDFSTUDIO_SAVE_DIR) {
          target = path.join(process.env.PDFSTUDIO_SAVE_DIR, suggestedName); // usado nos testes
        } else {
          const res = await dialog.showSaveDialog(win, {
            defaultPath: suggestedName,
            filters: [{ name: 'Documento PDF', extensions: ['pdf'] }],
          });
          if (res.canceled || !res.filePath) return null;
          target = res.filePath;
        }
      }
      await fs.writeFile(target, Buffer.from(bytes));
      return target;
    });
    ipcMain.handle('list-certificates', () => listCertificates());
    ipcMain.handle('sign-with-certificate', (_e, { thumbprint, bytes }) => signWithCertificate(thumbprint, bytes));

    Menu.setApplicationMenu(null);
    createWindow();
    void sendFile(pdfArg(process.argv));
  });

  app.on('window-all-closed', () => app.quit());
}
