# Mesa de playback

Faz o seu Mac aparecer na rede como um Behringer X32 e toca os stems de uma música.
O Mixing Station conecta nele como se fosse uma mesa de verdade: quem está aprendendo
mexe em fader, mute e pan no tablet e ouve o resultado na hora.

Serve para dar aula de som sem depender de uma mesa física.

## Como funciona

```
Mixing Station  ──OSC/UDP:10023──▶  server.js  ──WebSocket──▶  navegador (Web Audio)
   (tablet)                          (Mac)                        toca os stems
```

- `osc.js` — codec OSC 1.0 (sem dependências)
- `mixer-state.js` — estado da mesa: 32 canais, 16 buses, LR, curva de fader do X32
- `server.js` — responde ao protocolo do X32 e serve o player
- `public/` — player de áudio no navegador

## Rodar

O jeito rapido: clique duas vezes em `instalar.command`. Ele confere o Node,
instala as dependencias na primeira vez e ja sobe o servidor.

Pelo Terminal:

```bash
npm install
npm start
```

Abra **`http://localhost:8080`** no Chrome do próprio Mac, escolha a pasta com os
stems e dê play. O IP que o terminal mostra é para o tablet, não para o player.

Abrir o player por `http://SEU_IP:8080` parece funcionar mas não é contexto
seguro: o navegador não expõe `AudioWorklet` fora de `https` ou `localhost`, e
sem ele o gate não carrega. A página avisa na tela e segue sem gate.

## Conectar o Mixing Station

1. Tablet e Mac na mesma rede Wi-Fi.
2. No Mixing Station: nova conexão → modelo **Behringer X32** → IP do Mac → porta 10023.
3. Os canais já aparecem com o nome de cada arquivo de áudio.

Se não achar sozinho, use "Manual IP" — a descoberta automática por broadcast
não está implementada.

## Preparar os stems

Uma pasta por música, um arquivo por canal, todos do mesmo tamanho e alinhados
no zero (exporte do Logic com "All tracks", mesma região). A ordem dos canais
segue a ordem alfabética dos arquivos, então numere:

```
01 Kick.wav
02 Snare.wav
03 Baixo.wav
04 Teclado.wav
05 Guia.wav
```

WAV, AIFF, MP3, M4A (AAC), FLAC e OGG funcionam. Máximo de 32 canais.

Para trocar de música sem recarregar a página, use **Trocar música** no rodapé.
Ele desconecta os nós de áudio e revoga as URLs dos arquivos — sem isso as faixas
antigas ficariam presas na memória, e são dezenas de MB cada. Também zera o valor
do seletor, senão escolher a *mesma* pasta de novo não dispara o carregamento, e
preenche os nomes até o canal 32 com vazio, para uma música menor não deixar os
nomes da anterior nos canais que sobraram.

As faixas são lidas por streaming, não carregadas inteiras na memória, então
músicas longas com muitos stems funcionam sem estourar a RAM do navegador.

Apple Lossless (ALAC) dentro de `.m4a` é o único formato comum que o navegador
não abre. Se aparecer na lista de "não abriram", converta:

```bash
cd ~/pasta-dos-stems
for f in *.m4a; do afconvert -f WAVE -d LEI16@44100 "$f" "${f%.m4a}.wav"; done
```

`afconvert` já vem no macOS.

## O que já responde

| Recurso | Situação |
|---|---|
| Fader de canal e LR | ok |
| Ganho de preamp | ok — `/headamp/NNN/gain`, -12 a +60 dB, roteado pelo canal em foco |
| Trim de entrada | ok — `/ch/NN/preamp/trim`, -18 a +18 dB, por canal |
| Patch de entrada | canal N ← Local In N |
| Mute (`mix/on`) | ok |
| Pan | ok |
| Nome e cor do canal | ok |
| Medidores em tempo real | ok — pré-fader, como na X32 |
| Medidores da tela de canal | ok — `/meters/6`, 4 valores por canal |
| Sincronização via `/node` | ok para canais, buses e LR |
| Transporte | play, pause, stop, ±10s, seek na barra, atalhos de teclado |
| EQ de 4 bandas | ok — LCut, LShv, PEQ, HShv, HCut |
| Gate | ok — threshold, range, attack, hold, release |
| Compressor | ok — threshold, ratio, knee, attack, release, makeup |
| Solo | ok — `/-stat/solosw/NN`, em *solo in place* |
| Envios para bus / mix de monitor | valor guardado, sem roteamento de áudio |
| Cenas e snapshots | não |
| `/showdump` | ok — devolve o cabeçalho do showfile, sem cues nem cenas |
| Demais endereços do X32 | respondidos com valor neutro, só para o sync passar |

## O solo é "solo in place"

Numa X32 de verdade o solo vai para o **barramento de monitoração**, não para o
LR: soloar um canal não muda o som que a casa ouve, só o que o operador ouve no
fone. Aqui existe uma saída estéreo só, então o solo cala os outros canais na
saída principal — o que a X32 chama de *solo in place* e oferece como opção no
menu de monitoração.

É também o que o aluno espera ao apertar solo: ouvir só aquele canal.

O endereço é `/-stat/solosw/NN`, numerado de 01 a 80 (canais, aux, fx, buses…);
só os 32 primeiros mexem no áudio. A mesa também mantém o `/-stat/solo`, o
aviso de "tem algum solo ligado", que ela acende sozinha.

Duas decisões que valem saber:

- **O mute manda mais que o solo.** Soloar um canal mudo não o traz de volta.
  É a regra mais simples de explicar em aula: mute silencia, solo isola.
- **O servidor manda o quadro inteiro de solos**, não só o canal tocado. Ligar
  o solo do canal 3 muda o que se ouve nos outros 31, então o navegador precisa
  recalcular todos — não dá para tratar como mais um parâmetro de canal.

## O ganho e o canal em foco

O Mixing Station escreve o ganho **sempre em `/headamp/000/gain`**, qualquer que
seja o canal. Ele nunca lê `/ch/NN/config/source` e nunca manda seleção de canal,
e não muda de ideia mesmo com o patch, o roteamento, a cor e o formato do headamp
todos corrigidos e conferidos contra a especificação. Sem tratamento, mexer no
ganho de qualquer canal mexia no canal 1.

A saída apareceu no rastro completo da conversa: ao abrir a tela de um canal, ele
assina o medidor daquele canal, e **aí sim manda o número**:

```
<- /meters /meters/6 13      (canal 14, contado do zero)
<- /meters /meters/6 1       (canal 2)
```

É o único lugar em que ele diz em que canal está mexendo. O servidor guarda esse
foco por cliente e desvia para lá as escritas em `/headamp/000/gain`. Só o índice
0 é desviado, então um cliente que enderece o preamp corretamente não é afetado.

**Limitação:** o foco só existe enquanto a tela de canal estiver aberta no app.
Mexer no ganho por uma tela que não seja a do canal cai no último canal em foco.

O nível de entrada soma dois parâmetros distintos da X32, ambos na frente do
gate: **ganho de preamp** (`/headamp/NNN/gain`, -12 a +60 dB, 1/6 no zero) e
**trim digital** (`/ch/NN/preamp/trim`, -18 a +18 dB, 0.5 no zero). Estavam
caindo no mesmo campo e agora são separados.

O navegador pede um snapshot **depois** de montar as faixas, não só ao conectar.
O snapshot da conexão chega quando ainda não existe faixa nenhuma para receber os
valores: sem o segundo pedido, uma mesa já ajustada não chegava ao áudio, e o
Mixing Station mostrava uma coisa enquanto se ouvia outra.

Sobre os medidores, duas coisas que o Mixing Station não perdoa:

1. **Guarde todas as inscrições, não só a última.** Ele assina um conjunto para a
   tela do mixer e outro ao abrir a tela do canal. Com um slot único por cliente,
   abrir a tela de ganho fazia os medidores do mixer congelarem.
2. **Nos campos de gate e dinâmica, `0` não é "parado" — é "reduzindo tudo".** A
   convenção é multiplicador de ganho, então sem redução é `1.0`. Mandando zero,
   o Mixing Station desenhava as barrinhas de gate e comp cheias e imóveis.

Conjuntos implementados: `/meters/1` (96 floats — 32 entradas, 32 reduções de
gate, 32 de dinâmica) e `/meters/6 <canal>` (4 floats — entrada, redução do gate,
redução do comp, pós-fader), que é o que a tela de canal desenha.

Os medidores saem **antes do fader**, depois do ganho, gate, EQ e compressor —
como na X32. É isso que permite ajustar ganho pelo medidor com o fader em
qualquer posição. Se a sonda sair do nó do fader, o medidor passa a seguir o
fader e o ganho parece não fazer nada.

A curva de fader é a do X32, em quatro trechos que se encontram sem degrau:
`1.0 = +10 dB`, `0.75 = 0 dB`, `0.5 = -10 dB`, `0.25 = -30 dB`, `0.0625 = -60 dB`,
`0 = -∞`. Ela vive em dois lugares — `mixer-state.js` e `public/app.js` — e as
duas cópias têm que bater.

Cada canal roda a cadeia na mesma ordem da mesa real:

```
stem → ganho → gate → EQ 1 → EQ 2 → EQ 3 → EQ 4 → comp → makeup → fader → pan → LR
```

O gate é um `AudioWorklet` próprio (`public/gate-processor.js`), porque a Web Audio
não tem gate nativo. EQ usa `BiquadFilterNode` e o compressor usa
`DynamicsCompressorNode`.

O `DynamicsCompressorNode` do navegador aplica um makeup automático que a X32 não
tem — comprimir deixava o canal mais **alto**, o oposto de uma mesa. A fórmula é
interna do Chrome, então ela é medida, não adivinhada: a cada mudança de
threshold, knee ou ratio o app roda o mesmo compressor num `OfflineAudioContext`
com um tom 30 dB abaixo do menor threshold possível, vê quanto de ganho sobra e
desconta isso no nó de makeup. O resultado fica em cache por combinação.

Diferenças em relação a um X32 de verdade, que valem dizer em aula:

- O modo EXP da seção de dinâmica não é emulado; com ele ligado o canal passa limpo.
- A banda VEQ vira um PEQ comum.
- O ratio 100:1 é limitado a 20:1, que é o teto do compressor da Web Audio.
- Filtros de corte (LCut/HCut) são de 12 dB/oitava.

Duas armadilhas do `BiquadFilterNode` que já custaram caro:

1. Em `highpass` e `lowpass` o `Q` é lido em **decibéis**, não linearmente
   (`alpha = sin(w0) / (2 * 10^(Q/20))`). Butterworth é Q linear 0,7071, ou seja
   **-3,01** nesse parâmetro. Escrever `0.7071` ali deixa uma corcunda de +1,7 dB
   logo acima do corte.
2. O botão de Q da banda **não** se aplica a LCut/HCut. Passar o valor da banda
   para um filtro de corte vira ressonância: com o Q no mínimo, um low cut em
   100 Hz ganhava um pico de +10 dB em cima de 100 Hz e levantava o grave em vez
   de tirar.

## Se der "Sync failed"

O Mixing Station varre o mapa inteiro de um X32 ao conectar e desiste se algum
endereço ficar sem resposta. Note que `/showdump` pede os dados de cue, cena e
snippet do show — não o estado da mesa. Sem nenhuma cena gravada, a resposta
correta é uma linha só, o cabeçalho do showfile. A mesa emulada tem um catch-all: qualquer endereço
fora do modelo é guardado num dicionário e devolvido com valor neutro. Se mesmo
assim falhar, o log do servidor mostra o que chegou — rode com:

```bash
MESA_DEBUG=1 npm start
```

O mesmo log serve para descobrir o que um botão do Mixing Station manda de fato.
Rode com `MESA_DEBUG=1`, mexa só naquele botão e veja o endereço e o valor que
aparecem — é o jeito de saber se um controle está indo para onde você acha.

## Limitações honestas

- O áudio sai pela saída padrão do Mac em estéreo. Para mandar cada bus para uma
  saída física seria preciso trocar a Web Audio por um host CoreAudio nativo.
- Mantenha a aba do navegador visível; o Chrome estrangula timers em abas de fundo.
- Firewall do macOS pode pedir autorização para o Node receber conexões. Aceite.
- Abas abertas recebem todas o mesmo controle, mas cada uma toca os stems por
  conta própria: duas abas com a música carregada tocam o dobro. Use uma só.
- O ganho de entrada vai de -12 a +60 dB, como na mesa de verdade. Passar do
  ponto distorce mesmo — é a mesa sendo fiel, não defeito.

## Empacotar como app do Mac

Quando quiser um `.app` para clicar e abrir, envolva isso em Electron: a janela
carrega `public/index.html` e o processo principal roda o `server.js` como está.
Nenhuma linha do código de áudio ou de OSC precisa mudar.

## Empacotar como app do Mac

```bash
npm run icone   # só quando mudar o desenho do ícone
npm run dmg
```

Sai um `.dmg` em `dist/`, com o app assinado em modo ad-hoc.

O empacotamento é um script (`scripts/montar-app.sh`), não o electron-builder —
ele travava nesta máquina sem dar erro. O script faz o caminho que a própria
documentação do Electron descreve: copia o `Electron.app`, troca código,
metadados e ícone, assina e monta a imagem.

Três armadilhas que custaram caro, todas em volta do `codesign`:

1. **Monte fora de pasta sincronizada.** O projeto vive no Desktop, que o iCloud
   sincroniza, e o file provider gruda `com.apple.FinderInfo` no bundle a cada
   mexida — inclusive entre remover o atributo e chamar o `codesign`, que então
   recusa o bundle com *"resource fork, Finder information, or similar detritus
   not allowed"*. O script monta numa pasta temporária e só traz o `.dmg` pronto.
2. **`ditto --norsrc --noextattr --noacl`, nunca `cp -R`.** O `cp` carrega
   atributos que derrubam a assinatura.
3. **Nada de `xattr -cr` nem de `codesign --deep`.** O `xattr -cr` apaga também
   os `com.apple.cs.*`, onde ficam as assinaturas dos helpers do Electron. O
   `--deep` é desaconselhado pela Apple e aqui falhava de forma intermitente
   dentro de `Frameworks`. Assine de dentro para fora, na ordem.

A janela carrega `http://localhost:8080`, **não** o arquivo por `file://`: o
AudioWorklet do gate só existe em contexto seguro.

### Sobre a assinatura

O app é assinado em modo ad-hoc, não por conta de desenvolvedor. Sem assinatura
nenhuma, um binário arm64 nem abre — o macOS diz que está danificado. Com ad-hoc
ele abre, mostrando na primeira vez o aviso de desenvolvedor não identificado:
**botão direito no app → Abrir → Abrir**. Depois disso abre normal.

### Limitação

O `.dmg` é **arm64**, só Mac com Apple Silicon (M1 em diante). Para rodar em Mac
Intel é preciso baixar o Electron x64 e montar um binário universal.

## Empacotar para Windows

A versão de Windows é **portátil**: uma pasta que roda de onde estiver, sem
instalador. É montada a partir do Mac mesmo — o Windows não exige assinatura
para executar, então não há a etapa de `codesign` que complica o build do Mac.

```bash
curl -sL -o /tmp/electron-win.zip \
  "https://github.com/electron/electron/releases/download/v$(cat node_modules/electron/dist/version)/electron-v$(cat node_modules/electron/dist/version)-win32-x64.zip"
npm run windows
```

Sai um `.zip` em `dist/`. O `LEIA-ME.txt` dentro dele explica ao usuário final o
SmartScreen e a autorização de firewall.

O que **não** dá para fazer a partir do Mac:

- **Testar.** O pacote é montado às cegas; quem roda descobre se funciona.
- **Trocar o ícone do `.exe`** no Explorer. Isso exige `rcedit`, que só roda no
  Windows. O ícone da janela e da barra de tarefas é definido por código em
  `main.js` (`build/icon.ico`, copiado para `resources/app/icone.ico`).

Para um instalador de verdade, compilado numa máquina Windows real, o caminho é
GitHub Actions com um runner `windows-latest`.
