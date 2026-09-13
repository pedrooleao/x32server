#!/bin/bash
# Clique duas vezes neste arquivo para instalar e iniciar a mesa.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node nao encontrado."
  echo "Instale em https://nodejs.org (versao LTS) e rode este arquivo de novo."
  read -n 1 -s -r -p "Pressione qualquer tecla para fechar."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Instalando dependencias..."
  npm install || { echo "Falhou o npm install."; read -n 1 -s -r; exit 1; }
fi

echo "Iniciando. Para parar, feche esta janela ou pressione Ctrl+C."
echo
npm start
