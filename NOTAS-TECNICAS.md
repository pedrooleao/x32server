# Notas técnicas

O que custou caro descobrir, para não custar de novo. Nada aqui é necessário
para **usar** a mesa — veja o [README](README.md) para isso.

## Arquitetura

```
Mixing Station ──OSC/UDP:10023──▶ server.js ──WebSocket──▶ navegador (Web Audio)
```

- `osc.js` — codec OSC 1.0, sem dependências
- `mixer-state.js` — estado da mesa: 32 canais, 16 buses, LR, curvas do X32
- `server.js` — protocolo do X32 e servidor HTTP/WebSocket
- `public/` — player e engine de áudio
- `main.js` — janela do Electron; roda o `server.js` sem alterá-lo

A janela carrega `http://localhost:8080`, **não** o arquivo por `file://`: o
`AudioWorklet` do gate só existe em contexto seguro.

---

## O que o Mixing Station espera

### Catch-all de endereços

Ele varre o mapa inteiro de um X32 ao conectar e aborta o sync se qualquer
endereço ficar mudo. Modelar os ~4000 parâmetros é inviável, então qualquer
endereço desconhecido é guardado num dicionário e sempre respondido, com o tipo
inferido pelo sufixo (`/name` → string, `/gain` e `/level` → float, resto → int).

### `/showdump` não é o dump da mesa

É o dump de cue, cena e snippet do showfile. Sem cenas gravadas, a resposta
correta é **uma linha só**, o cabeçalho. Despejar os nós dos canais ali quebra o
sync.

### A cor no `/node` vai por nome

```
/ch/01/config "Kick Drum" 3 YE 1
```

Terceiro campo é a cor (`RD`, `GN`, `BL`…), não um número. O campo seguinte é a
entrada física do canal — um valor ilegível na cor derruba a leitura da entrada
junto.

### O ganho vem sempre no preamp 0

Ele escreve o ganho **sempre em `/headamp/000/gain`**, qualquer que seja o
canal. Nunca lê `/ch/NN/config/source` e nunca manda seleção de canal. Corrigir
o patch, o roteamento, a cor e o formato do headamp — tudo conferido contra a
especificação — não mudou isso.

A saída está na inscrição dos medidores: ao abrir a tela de um canal, ele assina
o medidor **daquele** canal, e aí manda o número.

```
<- /meters /meters/6 13      (canal 14, contado do zero)
```

É o único lugar em que ele diz em que canal está mexendo. O servidor guarda esse
foco por cliente e desvia para lá as escritas no `/headamp/000/gain`. Só o
índice 0 é desviado, então um cliente que enderece o preamp corretamente não é
afetado.

**Limitação:** o foco só existe enquanto a tela do canal estiver aberta.

### Medidores

1. **Guarde todas as inscrições, não só a última.** Ele assina um conjunto para
   a tela do mixer e outro ao abrir a tela do canal. Com um slot único, abrir a
   tela do canal fazia os medidores do mixer congelarem.
2. **Nos campos de gate e dinâmica, `0` não é "parado" — é "reduzindo tudo".** A
   convenção é multiplicador de ganho: sem redução é `1.0`. Mandando zero, ele
   desenhava as barrinhas de gate e comp cheias e imóveis.

Implementados: `/meters/1` (96 floats — 32 entradas, 32 reduções de gate, 32 de
dinâmica) e `/meters/6 <canal>` (4 floats — entrada, redução do gate, redução do
comp, pós-fader).

Os medidores saem **antes do fader**. É o que permite ajustar ganho pelo medidor
com o fader em qualquer posição. Saindo do nó do fader, o medidor segue o fader
e o ganho parece não fazer nada.

### Solo

É `/-stat/solosw/NN`, numerado de 01 a 80 (canais, aux, fx, buses); só os 32
primeiros mexem no áudio. A mesa também mantém o `/-stat/solo`, o aviso de "tem
algum solo ligado".

O servidor manda o **quadro inteiro** de solos, não o canal tocado: um solo muda
o que se ouve em todos os outros.

### Descobrir o que um botão manda

```bash
MESA_DEBUG=1 npm start    # tudo
MESA_GANHO=1 npm start    # só o que tem a ver com ganho de entrada
```

Mexa só naquele botão e veja o endereço e o valor. É o jeito de saber se um
controle vai para onde você acha que vai.

---

## Armadilhas da Web Audio

### O `Q` do biquad é em decibéis nos filtros de corte

Só em `highpass` e `lowpass`: `alpha = sin(w0) / (2 * 10^(Q/20))`. Butterworth é
Q linear 0,7071, ou seja **-3,01** nesse parâmetro. Escrever `0.7071` dá um Q
linear de 1,085 e deixa uma corcunda de +1,7 dB logo acima do corte.

### O botão de Q da banda não vale para LCut/HCut

Passar o valor da banda para um filtro de corte vira ressonância: com o Q no
mínimo, um low cut em 100 Hz ganhava um pico de **+10 dB** em cima de 100 Hz e
levantava o grave em vez de tirar.

### O compressor tem makeup automático escondido

O `DynamicsCompressorNode` aplica um makeup próprio que a X32 não tem:
comprimir deixava o canal mais **alto**, o oposto de uma mesa. A fórmula é
interna do navegador, então ela é **medida, não adivinhada** — a cada mudança de
threshold, knee ou ratio o app roda o mesmo compressor num `OfflineAudioContext`
com um tom 30 dB abaixo do menor threshold possível, vê quanto de ganho sobra e
desconta no nó de makeup. O resultado fica em cache por combinação.

### Streaming, não `decodeAudioData`

17 stems de 12 minutos descompactados dão ~4,5 GB de RAM e matam a aba. Cada
faixa é um `<audio>` lido aos poucos.

Ao trocar de música é preciso **revogar as URLs** e desconectar os nós, senão as
faixas antigas ficam presas na memória.

### A curva de fader do X32

Quatro trechos que se encontram **sem degrau**:

| fader | dB |
|---|---|
| 1.0 | +10 |
| 0.75 | 0 |
| 0.5 | -10 |
| 0.25 | -30 |
| 0.0625 | -60 |
| 0 | -∞ |

Os multiplicadores dobram a cada trecho para baixo: **480, 160, 80, 40**. Com
`160/80/40/40` abriam saltos nas fronteiras — no meio do curso o volume caía
20 dB de uma vez.

Ela vive em dois lugares, `mixer-state.js` e `public/app.js`, e as duas cópias
têm que bater.

### O snapshot chega antes das faixas

O navegador pede um snapshot **depois** de montar as faixas, não só ao conectar.
O da conexão chega quando ainda não existe faixa para receber os valores: sem o
segundo pedido, uma mesa já ajustada não chegava ao áudio, e o Mixing Station
mostrava uma coisa enquanto se ouvia outra.

---

## Empacotamento

O empacotamento é um script (`scripts/montar-app.sh`), não o electron-builder —
ele travava sem dar erro. O script faz o caminho que a documentação do Electron
descreve: copia o `Electron.app`, troca código, metadados e ícone, assina e
monta a imagem.

### Três armadilhas do `codesign`

1. **Monte fora de pasta sincronizada.** O iCloud gruda `com.apple.FinderInfo`
   no bundle a cada mexida — inclusive **entre** remover o atributo e chamar o
   `codesign`, que então recusa com *"resource fork, Finder information, or
   similar detritus not allowed"*. Era por isso que falhava de forma
   intermitente. O script monta numa pasta temporária.
2. **`ditto --norsrc --noextattr --noacl`, nunca `cp -R`.** O `cp` carrega
   atributos que derrubam a assinatura.
3. **Nada de `xattr -cr` nem de `codesign --deep`.** O `xattr -cr` apaga também
   os `com.apple.cs.*`, onde ficam as assinaturas dos helpers do Electron. O
   `--deep` é desaconselhado pela Apple e falhava dentro de `Frameworks`. Assine
   de dentro para fora, na ordem.

### Assinatura ad-hoc

Sem conta de desenvolvedor não dá para assinar de verdade, mas um binário arm64
**sem assinatura nenhuma nem abre** — o macOS diz que está danificado. A
assinatura ad-hoc resolve: o app abre mostrando só o aviso de desenvolvedor não
identificado.

### Windows

O pacote é portátil — uma pasta que roda de onde estiver. O Windows não exige
assinatura para executar, então não há a etapa de `codesign`.

Montar a partir do Mac funciona, mas **não dá para testar** de lá. Por isso o
GitHub Actions monta e testa num runner `windows-latest` a cada push
(`.github/workflows/windows.yml`), e é de lá que saem os pacotes das releases.

Trocar o ícone do `.exe` no Explorer exige `rcedit`, que só roda no Windows. O
ícone da janela e da barra de tarefas é definido por código em `main.js`.

### O `.gitignore` é ao contrário

Ignora tudo e libera só o código, um arquivo por vez. A pasta do projeto é
também onde ficam as multipistas — conteúdo licenciado, centenas de MB por
música. Uma lista normal teria que adivinhar o nome de cada música futura.

**Ao criar um arquivo de código novo na raiz, libere-o lá.**
