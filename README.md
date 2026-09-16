# Mesa de playback

Faz o seu computador aparecer na rede como uma **Behringer X32** e tocar as
multipistas de uma música. O Mixing Station conecta nele como se fosse uma mesa
de verdade: o aluno mexe em fader, ganho, EQ, gate, compressor e solo no tablet
e ouve o resultado na hora.

Serve para dar aula de som sem depender de uma mesa física.

```
Mixing Station  ──OSC/UDP:10023──▶  computador  ──▶  caixas de som
   (tablet)                          (o app)         toca os stems
```

## Instalar

Baixe em **[Releases](https://github.com/pedrooleao/x32server/releases/latest)**.

**Mac** (Apple Silicon, M1 em diante) — abra o `.dmg` e arraste para Aplicativos.
Na primeira vez: **botão direito no app → Abrir → Abrir**. O clique duplo comum
é recusado porque o app não tem assinatura de conta paga da Apple.

**Windows** (64 bits) — descompacte o `.zip` e clique em `Mesa de Playback.exe`.
Na primeira vez o SmartScreen barra: **Mais informações → Executar assim mesmo**.
Mova a pasta inteira, nunca só o `.exe`.

Nos dois, o sistema vai pedir **autorização de firewall**. É preciso aceitar,
senão o tablet não conecta.

## Usar

1. Abra o app e clique em **Escolher pasta**. Aponte para a pasta com os stems.
2. No tablet, na mesma rede Wi-Fi: **Mixing Station → nova conexão →
   Behringer X32 → o endereço que o app mostra → porta 10023**.
   O endereço está no menu **Mesa → Como conectar o tablet**.
3. Dê play. Os canais já aparecem no tablet com o nome de cada arquivo.

Para trocar de música, use **Trocar música** no rodapé.

Se o Mixing Station não achar a mesa sozinho, use "Manual IP" — a descoberta
automática por broadcast não está implementada.

## Preparar os stems

Uma pasta por música, um arquivo por canal, todos do mesmo tamanho e alinhados
no zero (exporte do Logic com "All tracks", mesma região).

**A ordem dos canais segue a ordem alfabética dos arquivos**, então numere:

```
01 Kick.wav
02 Snare.wav
03 Baixo.wav
04 Teclado.wav
05 Guia.wav
```

WAV, AIFF, MP3, M4A (AAC), FLAC e OGG funcionam. Até 32 canais.

As faixas são lidas aos poucos, não carregadas inteiras na memória: uma música
de 12 minutos com 17 stems funciona sem estourar a RAM.

## O que a mesa responde

| Recurso | Situação |
|---|---|
| Fader de canal e LR | ok |
| Mute | ok |
| Solo | ok — *solo in place*, veja abaixo |
| Pan | ok |
| Ganho de preamp | ok — -12 a +60 dB |
| Trim de entrada | ok — -18 a +18 dB |
| EQ de 4 bandas | ok — LCut, LShv, PEQ, HShv, HCut |
| Gate | ok — threshold, range, attack, hold, release |
| Compressor | ok — threshold, ratio, knee, attack, release, makeup |
| Medidores | ok — pré-fader, como na X32 |
| Nome e cor do canal | ok |
| Transporte | play, pause, stop, ±10s, seek na barra, teclado |
| Envios para bus / mix de monitor | guarda o valor, não roteia áudio |
| Cenas e snapshots | não |

Cada canal roda a cadeia na mesma ordem da mesa real:

```
stem → ganho → gate → EQ → compressor → fader → pan → LR
```

## Quatro coisas que surpreendem

**O solo é "solo in place".** Numa X32 o solo vai para o barramento de
monitoração: soloar não muda o som da casa, só o que o operador ouve no fone.
Aqui existe uma saída estéreo só, então soloar cala os outros na saída
principal. A própria X32 chama isso de *solo in place* e oferece como opção.

**Mute manda mais que solo.** Soloar um canal mudo não o traz de volta.

**O ganho segue o canal aberto no tablet.** O Mixing Station manda o ganho sem
dizer de que canal é; a mesa descobre pelo canal cuja tela está aberta. Se você
mexer no ganho por uma tela que não seja a do canal, ele cai no último canal que
esteve aberto.

**Uma janela só.** Duas janelas com a música carregada tocam o dobro. As duas
recebem o controle, mas cada uma toca por conta própria.

## Se der problema

**O tablet não conecta** — confira que os dois estão na mesma rede Wi-Fi e que o
firewall foi autorizado. O endereço está no menu Mesa → Como conectar o tablet;
ele muda quando o roteador dá outro IP ao computador.

**"Sync failed" no Mixing Station** — ele varre o mapa inteiro de um X32 ao
conectar e desiste se algum endereço ficar mudo. Rode pelo Terminal com
`MESA_DEBUG=1 npm start` para ver o que chegou.

**Um arquivo não abre** — Apple Lossless (ALAC) dentro de `.m4a` é o único
formato comum que o navegador não lê. Converta:

```bash
cd ~/pasta-dos-stems
for f in *.m4a; do afconvert -f WAVE -d LEI16@44100 "$f" "${f%.m4a}.wav"; done
```

**"Porta ocupada"** — outro programa está usando a porta da mesa. Feche o
X32-Edit, outro emulador, ou outra cópia deste app.

**O som some quando a janela fica atrás de outra** — mantenha a janela visível.
O navegador estrangula temporizadores em janelas de fundo.

## Rodar a partir do código

```bash
npm install
npm start
```

Abra **`http://localhost:8080`** no Chrome do próprio computador. O IP que o
terminal mostra é para o tablet, não para o player — abrir o player pelo IP da
rede desliga o gate, porque o navegador só expõe o `AudioWorklet` em `https` ou
`localhost`. A página avisa na tela quando isso acontece.

Para empacotar:

```bash
npm run dmg       # Mac: sai um .dmg em dist/
npm run windows   # Windows: sai um .zip portátil em dist/
```

A versão de Windows também é montada e testada a cada `git push`, numa máquina
Windows de verdade, pelo GitHub Actions — é de lá que saem os pacotes das
releases.

As decisões de implementação que custaram caro para descobrir estão em
**[NOTAS-TECNICAS.md](NOTAS-TECNICAS.md)**: o que o Mixing Station espera do
protocolo do X32, as armadilhas da Web Audio e as do `codesign`.

## Limitações

Estas são falhas **desta emulação**, não comportamento do X32. Numa mesa de
verdade tudo abaixo funciona.

**Controles que não mexem no áudio:**

- **Low Cut do preamp** (o botão "Lowcut" na tela do canal) — guarda o valor,
  não filtra nada. Para cortar grave, use uma banda do EQ como LCut.
- **Modo EXP da dinâmica** — a X32 tem COMP e EXP; com EXP ligado, aqui o canal
  passa limpo. Só COMP processa.
- **Envios para bus e mix de monitor** — guardam o valor, não roteiam áudio.
- **Cenas e snapshots.**

**Controles que funcionam, mas diferente da mesa real:**

- **Banda VEQ** vira um PEQ comum. Na X32 a VEQ é uma curva de EQ analógico,
  com resposta diferente de um PEQ limpo.
- **Ratio 100:1** é limitado a 20:1 — é o teto do compressor da Web Audio. Na
  X32 o 100:1 é praticamente um limiter.

**Do sistema:**

- O áudio sai pela saída padrão do computador, em estéreo. Mandar cada bus para
  uma saída física exigiria trocar a Web Audio por um host CoreAudio nativo.
- O `.dmg` é **arm64**: só Mac com Apple Silicon. O `.zip` é **x64**: não roda em
  Windows ARM.
- O ganho vai até +60 dB, como na mesa real. Passar do ponto distorce mesmo — é
  fidelidade, não defeito.
