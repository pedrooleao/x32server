'use strict';

// Processo principal do Electron: sobe a mesa e abre a janela do player.
// O server.js e' o mesmo que roda no Terminal, sem nenhuma mudanca de
// comportamento — so avisa por evento quando esta pronto ou quando falha.

const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('path');

let janela = null;

// So uma copia por vez: duas disputariam as portas 10023 e 8080, e a segunda
// morreria com um erro que ninguem entende.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (janela) {
      if (janela.isMinimized()) janela.restore();
      janela.focus();
    }
  });
  iniciar();
}

function iniciar() {
  // O servidor guarda a pasta lembrada junto das preferencias do app, nao na
  // pasta do programa — que no macOS fica dentro do .app, so leitura.
  process.env.MESA_CONFIG_DIR = app.getPath('userData');
  process.env.MESA_ELECTRON = '1';

  const mesa = require('./server.js');

  // A janela pede, aqui abrimos o seletor de pasta do sistema.
  mesa.on('escolherPasta', async () => {
    const r = await dialog.showOpenDialog(janela, {
      title: 'Escolha a pasta com os stems',
      properties: ['openDirectory'],
      buttonLabel: 'Usar esta pasta',
    });
    if (!r.canceled && r.filePaths[0]) mesa.lembrarPasta(r.filePaths[0]);
  });

  mesa.on('falhou', (titulo, detalhe) => {
    app.whenReady().then(() => {
      dialog.showMessageBoxSync({
        type: 'error',
        title: 'Mesa de Playback',
        message: titulo,
        detail: detalhe,
        buttons: ['Fechar'],
      });
      app.exit(1);
    });
  });

  // Espera a mesa subir antes de abrir a janela, para nao mostrar tela de erro
  // de conexao por meio segundo.
  let pronto = null;
  mesa.on('pronto', (info) => {
    pronto = info;
    if (app.isReady()) abrirJanela(info);
  });

  app.whenReady().then(() => {
    if (pronto) abrirJanela(pronto);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && pronto) abrirJanela(pronto);
    });
  });

  app.on('window-all-closed', () => {
    // Sem janela nao ha engine de audio, entao a mesa nao serve para nada:
    // encerra tambem no macOS, em vez de ficar de fundo consumindo a porta.
    app.quit();
  });
}

function abrirJanela(info) {
  if (janela && !janela.isDestroyed()) {
    janela.focus();
    return;
  }

  janela = new BrowserWindow({
    width: 900,
    height: 860,
    minWidth: 620,
    minHeight: 480,
    backgroundColor: '#131519',
    title: 'Mesa de Playback',
    // No macOS o icone vem do .icns dentro do bundle. No Windows o icone do
    // arquivo .exe so muda com ferramenta que roda la; este aqui e' o da janela
    // e da barra de tarefas, que da para definir por codigo.
    icon: process.platform === 'win32' ? path.join(__dirname, 'icone.ico') : undefined,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // O Chromium estrangula temporizadores em janela de fundo. Aqui isso
      // desalinharia as faixas: a correcao de deriva roda por temporizador, e
      // uma exportacao de 12 minutos com a janela atras de outra sairia torta.
      backgroundThrottling: false,
    },
  });

  // Carrega pelo http://localhost, NAO por file://. O AudioWorklet do gate so
  // existe em contexto seguro, e localhost e' contexto seguro. Abrir o arquivo
  // direto derruba o gate — foi exatamente o que aconteceu quando a pagina era
  // aberta pelo IP da rede.
  janela.loadURL(info.url);

  janela.once('ready-to-show', () => janela.show());

  // Onde salvar a mixagem exportada. Sem isto o Electron salva direto na pasta
  // de downloads, sem perguntar — e o aluno nao acha o arquivo depois.
  janela.webContents.session.on('will-download', (evento, item) => {
    const caminho = dialog.showSaveDialogSync(janela, {
      title: 'Salvar a mixagem',
      defaultPath: path.join(app.getPath('music'), item.getFilename()),
      buttonLabel: 'Salvar',
    });
    if (caminho) item.setSavePath(caminho);
    else item.cancel();
  });

  // Links externos vao para o navegador do sistema, nao viram outra janela.
  janela.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  montarMenu(info);
}

function montarMenu(info) {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Mesa',
      submenu: [
        {
          label: 'Como conectar o tablet',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'Conectar o Mixing Station',
              message: 'No tablet, na mesma rede Wi-Fi:',
              detail:
                `Mixing Station → nova conexão → Behringer X32\n\n` +
                `Endereço: ${info.ip}\nPorta: ${info.porta}\n\n` +
                `Se o endereço mudar de um dia para o outro, é o roteador dando ` +
                `outro IP ao computador. Volte aqui para ver o novo.`,
              buttons: ['Fechar'],
            });
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
