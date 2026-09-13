#!/bin/bash
# Monta a versao portatil para Windows, a partir do Mac.
#
# Nao e' instalador: e' uma pasta que roda de onde estiver. Descompactar e
# clicar no .exe. Fazemos aqui o mesmo que no Mac — pegar o Electron pronto,
# trocar o codigo e os metadados — so que sem assinatura, porque o Windows nao
# exige assinatura para executar (so mostra o aviso do SmartScreen).
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
NOME="Mesa de Playback"
VERSAO="$(node -p "require('$RAIZ/package.json').version")"
ELECTRON="$(cat "$RAIZ/node_modules/electron/dist/version")"
ZIP_ELECTRON="${1:-/tmp/electron-win.zip}"

SAIDA="$RAIZ/dist"
# Montar fora do projeto: o Desktop e' sincronizado pelo iCloud e isso ja deu
# dor de cabeca no build do Mac.
OFICINA="$(mktemp -d)"
trap 'rm -rf "$OFICINA"' EXIT
PASTA="$OFICINA/$NOME"

[ -f "$ZIP_ELECTRON" ] || { echo "Falta o zip do Electron para Windows em $ZIP_ELECTRON"; exit 1; }

mkdir -p "$SAIDA"

echo "1/5  descompactando o Electron $ELECTRON (win32-x64)"
mkdir -p "$PASTA"
unzip -q "$ZIP_ELECTRON" -d "$PASTA"

echo "2/5  colocando o codigo da mesa"
APP="$PASTA/resources/app"
mkdir -p "$APP/node_modules"
for f in main.js server.js osc.js mixer-state.js package.json; do
  cp "$RAIZ/$f" "$APP/$f"
done
cp -R "$RAIZ/public" "$APP/public"
# So a dependencia de producao: o ws. O resto e' ferramenta de build.
cp -R "$RAIZ/node_modules/ws" "$APP/node_modules/ws"
# Icone da janela e da barra de tarefas (o do .exe exige ferramenta do Windows).
cp "$RAIZ/build/icon.ico" "$APP/icone.ico"
find "$APP" -name ".DS_Store" -delete

echo "3/5  renomeando o executavel"
mv "$PASTA/electron.exe" "$PASTA/$NOME.exe"

echo "4/5  escrevendo o LEIA-ME"
cat > "$PASTA/LEIA-ME.txt" <<'TXT'
Mesa de Playback
================

Para abrir: clique duas vezes em "Mesa de Playback.exe".

Na primeira vez o Windows vai mostrar uma tela azul do SmartScreen dizendo que
o aplicativo nao e' reconhecido. Isso acontece porque ele nao tem assinatura
digital paga. Clique em "Mais informacoes" e depois em "Executar assim mesmo".

O Windows tambem vai perguntar se libera o acesso a rede. E' preciso ACEITAR,
senao o tablet nao consegue conectar na mesa.

Como usar
---------
1. Abra o aplicativo. Ele mostra o endereco da mesa na propria janela
   (menu Mesa > Como conectar o tablet).
2. Clique em "Escolher pasta" e aponte para a pasta com os stems da musica.
3. No tablet, na mesma rede Wi-Fi: Mixing Station > nova conexao >
   Behringer X32 > o endereco mostrado > porta 10023.

Os arquivos viram canais na ordem alfabetica, entao numere: 01 Kick.wav,
02 Snare.wav, e assim por diante.

Para trocar de musica, use o botao "Trocar musica" no rodape.

Nao mova esta pasta pela metade: o .exe precisa dos arquivos que estao junto
dele. Mova a pasta inteira.
TXT

echo "5/5  compactando"
ZIP="$SAIDA/Mesa de Playback $VERSAO - Windows x64.zip"
rm -f "$ZIP"
( cd "$OFICINA" && zip -qr "$ZIP" "$NOME" -x '*.DS_Store' )

echo
echo "pronto: $ZIP  ($(du -h "$ZIP" | cut -f1))"
