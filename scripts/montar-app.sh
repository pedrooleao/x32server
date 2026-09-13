#!/bin/bash
# Monta o .app e o .dmg na mao, sem empacotador.
#
# O electron-builder travava sem dar erro nesta maquina. Este e' o caminho que a
# propria documentacao do Electron descreve para distribuir sem bundler: copiar
# o Electron.app, trocar codigo e metadados, assinar e montar a imagem.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
NOME="Mesa de Playback"
VERSAO="$(node -p "require('$RAIZ/package.json').version")"
ID="br.pedro.mesaplayback"

# Montar FORA do projeto. A pasta fica no Desktop, que o iCloud sincroniza, e o
# file provider gruda com.apple.FinderInfo no bundle a cada mexida — inclusive
# entre remover o atributo e chamar o codesign, que entao recusa o bundle.
# Numa pasta temporaria isso nao acontece. O .dmg pronto volta para o projeto.
OFICINA="$(mktemp -d)"
trap 'rm -rf "$OFICINA"' EXIT

SAIDA="$RAIZ/dist"
MONTAGEM="$OFICINA/montagem/$NOME.app"
APP="$OFICINA/$NOME.app"

# ditto em vez de cp -R: o cp carrega tralha de atributo estendido que faz o
# codesign recusar o bundle com "resource fork, Finder information, or similar
# detritus not allowed".
COPIAR="ditto --norsrc --noextattr --noacl"

rm -rf "$SAIDA"
mkdir -p "$SAIDA" "$OFICINA/montagem"

echo "1/7  copiando o Electron"
$COPIAR "$RAIZ/node_modules/electron/dist/Electron.app" "$MONTAGEM"

echo "2/7  colocando o codigo da mesa"
REC="$MONTAGEM/Contents/Resources"
mkdir -p "$REC/app"
for f in main.js server.js osc.js mixer-state.js package.json; do
  $COPIAR "$RAIZ/$f" "$REC/app/$f"
done
$COPIAR "$RAIZ/public" "$REC/app/public"
# So a dependencia de producao: o ws. O resto e' ferramenta de build.
$COPIAR "$RAIZ/node_modules/ws" "$REC/app/node_modules/ws"

echo "3/7  ícone e nome do executavel"
$COPIAR "$RAIZ/build/icon.icns" "$REC/electron.icns"
mv "$MONTAGEM/Contents/MacOS/Electron" "$MONTAGEM/Contents/MacOS/$NOME"

echo "4/7  ajustando o Info.plist"
PLIST="$MONTAGEM/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $NOME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $NOME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $NOME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $ID" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSAO" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSAO" "$PLIST"

echo "5/7  passando o ditto de limpeza"
# Mexer no bundle (renomear, PlistBuddy, copiar arquivo) gruda com.apple.FinderInfo
# na raiz e nas pastas dos frameworks, e o codesign recusa por causa disso. Um
# ditto do bundle ja pronto entrega uma copia limpa. Nao adianta fazer xattr -cr
# em vez disto: ele apagaria tambem os com.apple.cs.*, onde ficam as assinaturas
# dos helpers do Electron.
find "$MONTAGEM" -name ".DS_Store" -delete
$COPIAR "$MONTAGEM" "$APP"
rm -rf "$OFICINA/montagem"

echo "6/7  assinando em modo ad-hoc"
# Sem conta da Apple nao da para assinar de verdade, mas binario arm64 sem
# assinatura nenhuma nem abre: o macOS diz que o aplicativo esta danificado.
# Nada de --deep, que a Apple desaconselha: de dentro para fora, na ordem.
assinar() {
  # O com.apple.FinderInfo gruda de novo a cada mexida no bundle — a pasta esta
  # no Desktop, que o iCloud sincroniza, e isso recria o atributo. Tirar so ele,
  # item a item, logo antes de assinar. Um xattr -cr geral apagaria tambem os
  # com.apple.cs.*, onde ficam as assinaturas dos helpers do Electron.
  xattr -d com.apple.FinderInfo "$1" 2>/dev/null || true
  codesign --force --sign - "$1" 2>&1 | grep -v "replacing existing signature" || true
}

while IFS= read -r -d '' lib; do assinar "$lib"; done < <(
  find "$APP/Contents/Frameworks" -type f \( -name "*.dylib" -o -name "*.node" \) -print0
)
for h in "$APP/Contents/Frameworks/"*.app; do [ -e "$h" ] && assinar "$h"; done
for f in "$APP/Contents/Frameworks/"*.framework; do [ -e "$f" ] && assinar "$f/Versions/A"; done
assinar "$APP"

codesign --verify --strict "$APP"
echo "     assinatura ok"

echo "7/7  montando o .dmg"
STAGE="$(mktemp -d)"
$COPIAR "$APP" "$STAGE/$NOME.app"
ln -s /Applications "$STAGE/Applications"
DMG="$SAIDA/Mesa de Playback $VERSAO.dmg"
hdiutil create -volname "$NOME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

echo
echo "pronto: $DMG  ($(du -h "$DMG" | cut -f1))"
