const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const http = require('http');

let mainWindow = null;
let serverProcess = null;
const DEFAULT_PORT = 3001;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function checkServerRunning(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/favicon.png`, (res) => {
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startBackendServer(port) {
  return new Promise((resolve, reject) => {
    const isPackaged = app.isPackaged;
    const serverScript = isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'backend', 'server.js')
      : path.join(__dirname, '..', 'backend', 'server.js');

    const userDataPath = app.getPath('userData');

    console.log('[Electron] Starting backend server:', serverScript);
    console.log('[Electron] User data path:', userDataPath);

    // Prepare environment
    const env = {
      ...process.env,
      PORT: port.toString(),
      USER_DATA_PATH: userDataPath,
      NODE_ENV: isPackaged ? 'production' : 'development',
      ELECTRON_RUN_AS_NODE: '1'
    };

    // Fork server
    serverProcess = fork(serverScript, [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    let resolved = false;

    serverProcess.stdout.on('data', (data) => {
      console.log(`[Backend] ${data.toString().trim()}`);
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`[Backend ERR] ${data.toString().trim()}`);
    });

    serverProcess.on('message', (msg) => {
      if (msg && msg.type === 'SERVER_READY' && !resolved) {
        resolved = true;
        resolve(port);
      }
    });

    serverProcess.on('error', (err) => {
      console.error('[Electron] Failed to start backend:', err);
      if (!resolved) {
        checkServerRunning(port).then(running => {
          if (running) {
            resolved = true;
            resolve(port);
          } else {
            resolved = true;
            reject(err);
          }
        });
      }
    });

    serverProcess.on('exit', (code, signal) => {
      console.log(`[Electron] Backend exited with code ${code}, signal ${signal}`);
      if (!resolved) {
        checkServerRunning(port).then(running => {
          if (running) {
            resolved = true;
            resolve(port);
          } else {
            app.quit();
          }
        });
      } else {
        app.quit();
      }
    });

    // Fallback polling in case IPC message is delayed
    const startTime = Date.now();
    const interval = setInterval(() => {
      if (resolved) {
        clearInterval(interval);
        return;
      }
      if (Date.now() - startTime > 15000) {
        clearInterval(interval);
        if (!resolved) {
          checkServerRunning(port).then(running => {
            if (running) {
              resolved = true;
              resolve(port);
            } else {
              resolved = true;
              reject(new Error('Timeout waiting for backend server to become ready.'));
            }
          });
        }
        return;
      }

      const req = http.get(`http://localhost:${port}/favicon.png`, (res) => {
        if (!resolved) {
          resolved = true;
          clearInterval(interval);
          resolve(port);
        }
      });
      req.on('error', () => {});
    }, 500);
  });
}

async function ensureBackendServer(port) {
  const isRunning = await checkServerRunning(port);
  if (isRunning) {
    console.log(`[Electron] Backend server already running on port ${port}. Reusing.`);
    return port;
  }
  return startBackendServer(port);
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 880,
    minWidth: 1024,
    minHeight: 720,
    title: 'Photo Tag Pro',
    icon: path.join(__dirname, '..', 'AppIcon.icns'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      sandbox: true
    }
  });

  const url = `http://localhost:${port}`;
  console.log('[Electron] Loading application URL:', url);
  mainWindow.loadURL(url);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: 'Informazioni su Photo Tag Pro' },
              { type: 'separator' },
              { role: 'services', label: 'Servizi' },
              { type: 'separator' },
              { role: 'hide', label: 'Nascondi Photo Tag Pro' },
              { role: 'hideOthers', label: 'Nascondi altre' },
              { role: 'unhide', label: 'Mostra tutte' },
              { type: 'separator' },
              { role: 'quit', label: 'Esci da Photo Tag Pro' }
            ]
          }
        ]
      : []),
    {
      label: 'Modifica',
      submenu: [
        { role: 'undo', label: 'Annulla' },
        { role: 'redo', label: 'Ripeti' },
        { type: 'separator' },
        { role: 'cut', label: 'Taglia' },
        { role: 'copy', label: 'Copia' },
        { role: 'paste', label: 'Incolla' },
        { role: 'selectAll', label: 'Seleziona tutto' }
      ]
    },
    {
      label: 'Vista',
      submenu: [
        { role: 'reload', label: 'Ricarica' },
        { role: 'forceReload', label: 'Ricarica forzata' },
        { role: 'toggleDevTools', label: 'Strumenti per sviluppatori' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Dimensioni originali' },
        { role: 'zoomIn', label: 'Ingrandisci' },
        { role: 'zoomOut', label: 'Riduci' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Schermo intero' }
      ]
    },
    {
      label: 'Finestra',
      submenu: [
        { role: 'minimize', label: 'Riduci a icona' },
        { role: 'zoom', label: 'Ridimensiona' },
        ...(isMac
          ? [
              { type: 'separator' },
              { role: 'front', label: 'Porta tutto in primo piano' }
            ]
          : [{ role: 'close', label: 'Chiudi' }])
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(async () => {
  setupMenu();

  try {
    const port = await ensureBackendServer(DEFAULT_PORT);
    createWindow(port);
  } catch (err) {
    console.error('[Electron] Error starting application:', err);
    dialog.showErrorBox(
      'Errore di avvio',
      `Non è stato possibile avviare il server interno di Photo Tag Pro:\n\n${err.message}`
    );
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
      createWindow(DEFAULT_PORT);
    }
  });
});

function stopBackendServer() {
  if (serverProcess) {
    try {
      serverProcess.kill('SIGTERM');
    } catch (e) {}
    serverProcess = null;
  }
}

app.on('before-quit', () => {
  stopBackendServer();
});

app.on('window-all-closed', () => {
  stopBackendServer();
  if (process.platform !== 'darwin') {
    app.quit();
  } else {
    app.quit(); // In desktop utility apps like Photo Tag Pro, quitting on close terminates the backend
  }
});
