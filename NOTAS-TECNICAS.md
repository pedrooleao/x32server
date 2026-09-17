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

### A inclinação dos cortes do EQ é incerta

O README antigo listava "cortes de 12 dB/oitava" como desvio em relação ao X32.
**Isso nunca foi verificado.** A especificação do protocolo não diz a inclinação
do LCut/HCut do EQ de canal — o enum é só `{LCut, LShv, PEQ, VEQ, HShv, HCut}`,
sem escolha de inclinação.

Um indício de que 12 dB/oitava pode estar certo: o EQ de **bus** tem tipos com
inclinação explícita (`BU6, BU12, BU18, BU24, BS12, BS24, LR12, LR24`), e o de
canal não tem nenhum. Se o corte do canal fosse ajustável ou mais íngreme,
provavelmente apareceria ali como aparece no bus.

Enquanto não for medido contra uma X32 de verdade, não afirme nem que bate nem
que difere.

### O enum dos modos de gate não começa no GATE

`{EXP2, EXP3, EXP4, GATE, DUCK}` — **GATE é o índice 3**. A tabela daqui estava
`['GATE', 'EXP2', ...]` e o padrão era `mode: 0`, então a mesa nascia em EXP2
achando que era GATE, e o tablet mostrava um modo enquanto a mesa entendia outro.

O modo também era ignorado no áudio: tudo virava gate duro. Hoje o worklet
recebe um `ratio` — 1 fecha até o range (GATE), 2/3/4 atenuam
`(threshold - nível) × (ratio - 1)`, que é a diferença audível: a cauda some aos
poucos em vez de ser cortada.

**Ao medir, lembre que o detector é de pico.** Uma senoide de -30 dBFS RMS tem
pico em -27, então com threshold em -20 ela está 7 dB abaixo, não 10.

### A dinâmica pode vir antes ou depois do EQ

`/ch/NN/dyn/pos` é `{PRE, POST}` e o padrão é **PRE**. A mesa declarava PRE e o
áudio sempre fazia POST.

Muda bastante o som. Com +15 dB de EQ em 1 kHz e o compressor em -30 dB, 10:1,
medido no mesmo tom:

| | Compressor vê | Redução | Saída |
|---|---|---|---|
| PRE | -30 dBFS | 1 dB | -16,0 |
| POST | -15 dBFS | 13,7 dB | -28,6 |

Reordenar a cadeia exige desconectar e reconectar os nós. **O medidor pré-fader
sai de quem fecha o processamento**, que muda junto: `makeup` em POST, `eq[3]`
em PRE.

### O worklet do gate sai curto quando está desligado

Ele roda em **todos** os canais o tempo todo, e o gate costuma estar desligado
na maioria. Antes o envelope e o `log10` eram calculados por amostra mesmo
assim, e o resultado descartado no fim.

A Web Audio entrega o array do parâmetro com **um elemento** quando ele não muda
dentro do bloco — que é o caso de um botão que ninguém tocou. Dá para detectar
isso e copiar a entrada direto para a saída.

Medido com 32 gates processando 10 s, em render offline (onde o tempo é
proporcional ao custo):

| | Antes | Agora |
|---|---|---|
| 32 gates desligados | 1126 ms | **281 ms** |

O caminho ligado também ficou mais barato: a decisão aberto/fechado é feita em
escala **linear**, comparando o envelope com o threshold convertido uma vez por
bloco. O `log10` só aparece no ramo do expansor, onde é inevitável.

### Abrir os arquivos em paralelo, não em fila

`Promise.all` sobre os arquivos em vez de `for...await`. O `Promise.all`
devolve na ordem em que foi pedido, então a ordem alfabética dos canais não
depende de qual arquivo abriu primeiro.

Medido com 20 arquivos: **52 ms em fila contra 19 ms em paralelo**. Com arquivos
grandes no disco a diferença é maior, porque as esperas de leitura passam a se
sobrepor.

### Medidor de pico, não de RMS

Mesa é medidor de pico: é o pico que estoura o conversor, e o valor que o X32
manda no blob é a amostra mesma, de 0 a 1. Antes ia um RMS multiplicado por 2,2,
que é aproximação — e com ela o medidor nunca chegava ao topo mesmo com o canal
clipando, o que tornava impossível mostrar clipe.

### A pasta lembrada é servida por HTTP, com Range

Guardar o caminho da última pasta poupa escolhê-la a cada aula. Mas os arquivos
**não** podem ser lidos para a memória: são dezenas de MB cada, e isso desfaz o
streaming.

Então a mesa serve a pasta em `/stems/<nome>` **com suporte a Range**. Sem Range
o navegador não consegue buscar posição e a barra de tempo para de funcionar.

O seletor de pasta com caminho só existe no processo principal do Electron. A
janela pede por WebSocket (`escolherPasta`), o `main.js` abre o diálogo do
sistema e devolve o caminho. Assim não é preciso script de preload nem afrouxar
o isolamento da janela.

A preferência é guardada em `app.getPath('userData')`, não junto do programa: no
macOS a pasta do app fica dentro do `.app`, que é só leitura.

O carregamento automático acontece **uma vez**, quando a página abre. Recarregar
por baixo de alguém que está no meio de uma aula seria pior que não lembrar.

### Os efeitos, e por que cada canal leva a própria cópia na exportação

Bus 1 = delay, bus 2 = reverb. No modelo do X32: `/fx/1/type` = 10 (DLY) com
`source` = MIX1, `/fx/2/type` = 0 (HALL) com `source` = MIX2. Os índices vêm da
lista de tipos da especificação, não de chute.

O delay é uma linha com realimentação e um corte de agudo no laço — sem esse
corte a cauda soa metálica. A realimentação é limitada a 0,85: acima disso ela
cresce sozinha e não para mais.

O reverb é convolução com uma resposta impulsiva gerada na hora: ruído decaindo
com expoente 2,2. Não é uma sala medida, mas soa como sala e não custa arquivo.

**Na exportação, cada canal leva a própria cópia dos dois efeitos** em vez de um
par compartilhado. Parece desperdício, mas é o que permite renderizar um canal
de cada vez — e dá exatamente no mesmo resultado, porque delay e convolução são
lineares: somar depois de processar é igual a processar a soma.

### Escolher pasta: o aviso precisa dizer se foi pedido

A janela carrega a pasta lembrada sozinha **uma vez**, na abertura — recarregar
por baixo de quem está no meio de uma aula seria pior que não lembrar. A trava
que garante isso (`jaAutocarregou`) estava barrando também **a escolha explícita
do usuário**: escolher outra pasta não trocava nada.

E a mensagem enviada ao escolher omitia o campo `nativo`, então a janela
concluía que não havia seletor do sistema e trocava o botão pelo seletor de
arquivos comum.

Os dois juntos davam o sintoma de "tem que escolher duas vezes": a primeira não
carregava e trocava o botão; a segunda funcionava por outro caminho, o seletor
do navegador.

A mensagem agora leva `escolhida: true` quando vem de um pedido do usuário, e o
`nativo` vai sempre.

### A exportação é acelerada, canal por canal

O gargalo nunca foi o processamento: era o **codificador**, que grava em tempo
real. Com `AudioEncoder` (WebCodecs) a codificação deixa de ser o limite.

E o processamento vai para `OfflineAudioContext`, que roda cerca de **200× mais
rápido** que tempo real. Não dá para renderizar tudo de uma vez — 17 stems de 12
minutos decodificados juntos são ~4,3 GB. Mas **cada canal é independente até a
soma**, então renderiza-se um de cada vez, acumulando. O pico de memória cai para
uns 750 MB.

Somar depois dá o mesmo resultado que somar durante: as cadeias de canal não
interagem, e o fader do LR é só um ganho no fim. Canal mudo ou calado pelo solo
nem é renderizado.

Medido: 90 s de música com 6 canais em **3,3 s** — 27× mais rápido.

### O recipiente precisa ser .m4a, não ADTS

O codificador entrega quadros AAC. Concatenar quadros ADTS dá um arquivo que
toca, e é muito mais simples — mas **ADTS não guarda a duração**, e o player
estima pela taxa de bits. Uma música de 90 s aparecia como 224 s no macOS, com a
barra de tempo toda errada.

Então `public/m4a.js` monta o recipiente: `ftyp`, `moov` e `mdat`. O
`AudioSpecificConfig` que vai no `esds` vem do próprio codificador, no campo
`decoderConfig.description` do primeiro quadro — não se inventa.

Conferido com as ferramentas do macOS: `File type ID: m4af`, duração 90,03 s, e
o `afconvert` converte o arquivo inteiro sem reclamar, o que só acontece se a
estrutura estiver correta.

### A reserva em tempo real

Sem `AudioEncoder`, o app grava a saída ao vivo:
`createMediaStreamDestination()` pendurado no master e um `MediaRecorder`. Aí a
música toca inteira e a exportação demora o que ela dura.

**O estrangulamento de janela em segundo plano é um risco real aqui.** A correção
de deriva entre as faixas roda por temporizador; se o sistema reduzir a
prioridade da janela no meio de uma gravação de 12 minutos, as faixas
desalinham. No Electron isso é desligado com `backgroundThrottling: false`.

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
