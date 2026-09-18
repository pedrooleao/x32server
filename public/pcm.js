'use strict';

// Toca uma faixa sem compressao aos pedacos, em vez de entregar o arquivo
// inteiro a um <audio>.
//
// POR QUE. Um <audio> guarda tudo o que ja leu, desde o comeco da musica, e o
// Chrome tem um orcamento de memoria de midia para a pagina toda. Com 18 stems
// de 24 bits o orcamento acaba por volta da decima segunda faixa: as primeiras
// ficam com a memoria, as ultimas param de receber dado e tocam MUDAS, com o
// relogio andando e o medidor zerado. Nao ha erro nenhum na tela — parece que a
// mesa travou. (A medicao esta em NOTAS-TECNICAS.md.)
//
// Aqui a mesa corta o arquivo em blocos de poucos segundos e o player so guarda
// os proximos. Sao dezenas de MB no total em vez de centenas, e nao ha mais
// faixa que perca a vez.
//
// DE BRINDE, o sincronismo. Cada bloco e' agendado pelo relogio do
// AudioContext, que e' o relogio do proprio conversor: as faixas nao derivam
// entre si nem um sample. Elementos <audio> derivavam dezenas de ms e havia um
// laco corrigindo isso o tempo todo.

const BLOCO = 3;          // segundos por pedaco pedido a mesa
const ADIANTADO = 6;      // quanto agendar a frente do que esta tocando

// Descobre o formato. Devolve null quando a mesa nao sabe cortar o arquivo
// (MP3, M4A, FLAC, OGG) — esses continuam no <audio>, e por serem comprimidos
// nao chegam perto do orcamento de memoria.
async function abrirPcm(base, nome) {
  const url = `${base}/pcm/${encodeURIComponent(nome)}`;
  let r;
  try {
    r = await fetch(url);
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const info = await r.json();
  if (!info.taxa || !info.quadros) return null;
  return {
    url,
    taxa: info.taxa,
    canais: info.canais,
    duracao: info.duracao,
    quadros: info.quadros,
    blocos: Math.ceil(info.duracao / BLOCO),
    vivos: [],        // fontes ja agendadas, para poder parar
    agendado: -1,     // ultimo bloco agendado
    geracao: 0,       // muda a cada seek: descarta o que estava a caminho
    cache: new Map(), // bloco -> AudioBuffer, so os proximos
    ocupado: false,   // ha um alimentar() em curso
  };
}

// Garante que o bloco de onde a musica vai arrancar ja esteja em memoria.
// Chamado antes da largada, para todas as faixas saírem juntas.
async function primeiroBloco(ctx, p, pos) {
  const k = Math.max(0, Math.floor(pos / BLOCO));
  if (!p.cache.has(k)) await baixarBloco(ctx, p, k);
}

// Agenda o que falta para que a faixa tenha som ate ADIANTADO segundos a frente.
// `inicio` e' o instante do AudioContext que corresponde a `posBase` da musica.
//
// Uma so por vez: o laco chama isto a cada 50 ms e sem a trava as chamadas se
// atropelavam, agendando o mesmo bloco duas vezes — que se ouve como a faixa
// dobrada, 3 dB mais alta.
async function alimentar(ctx, p, destino, inicio, posBase) {
  if (p.ocupado) return;
  p.ocupado = true;
  try {
    const ate = posBase + (ctx.currentTime - inicio) + ADIANTADO;
    const primeiro = Math.max(0, Math.floor(posBase / BLOCO));
    const ultimo = Math.min(p.blocos - 1, Math.floor(ate / BLOCO));
    if (p.agendado < primeiro - 1) p.agendado = primeiro - 1;

    while (p.agendado < ultimo) {
      const k = p.agendado + 1;
      const geracao = p.geracao;

      let buf = p.cache.get(k);
      if (!buf) {
        buf = await baixarBloco(ctx, p, k);
        if (geracao !== p.geracao) return;      // houve seek enquanto baixava
        if (!buf) { p.agendado = k; continue; }
      }
      p.agendado = k;

      // Onde este bloco comeca, no relogio do AudioContext.
      const quando = inicio + k * BLOCO - posBase;
      // O bloco de onde a musica arranca quase sempre comeca no meio.
      let deslocamento = Math.max(0, posBase - k * BLOCO);

      // Se o instante ja passou — porque baixar levou tempo — entramos mais
      // adiante no bloco, na mesma medida. Sem isso a faixa repetiria o trecho
      // que ja deveria ter tocado e ficaria atrasada para sempre.
      const atraso = Math.max(0, ctx.currentTime - quando);
      deslocamento += atraso;
      if (deslocamento >= buf.duration) continue;          // bloco inteiro ja passou

      const fonte = ctx.createBufferSource();
      fonte.buffer = buf;
      fonte.connect(destino);
      fonte.start(quando + atraso, deslocamento);
      fonte.onended = () => {
        const i = p.vivos.indexOf(fonte);
        if (i >= 0) p.vivos.splice(i, 1);
        p.cache.delete(k);
      };
      p.vivos.push(fonte);
    }
  } finally {
    p.ocupado = false;
  }
}

async function baixarBloco(ctx, p, k) {
  const de = Math.round(k * BLOCO * p.taxa);
  const n = Math.min(Math.round(BLOCO * p.taxa), p.quadros - de);
  if (n <= 0) return null;
  try {
    const r = await fetch(`${p.url}?de=${de}&n=${n}`);
    if (!r.ok) return null;
    // decodeAudioData ja entrega na taxa do contexto, reamostrando quando
    // preciso. Como cada bloco e' agendado pelo tempo do ARQUIVO, e nao pela
    // soma dos anteriores, um sample a mais ou a menos na reamostragem nao se
    // acumula ao longo da musica.
    const buf = await ctx.decodeAudioData(await r.arrayBuffer());
    p.cache.set(k, buf);
    return buf;
  } catch {
    return null;
  }
}

// Para tudo o que estava agendado. Usado na pausa, no seek e ao trocar de musica.
function calar(p) {
  p.geracao++;
  for (const fonte of p.vivos.slice()) {
    try { fonte.onended = null; fonte.stop(); } catch (e) { /* ja parou */ }
    try { fonte.disconnect(); } catch (e) { /* ja desligada */ }
  }
  p.vivos.length = 0;
  p.cache.clear();
  p.agendado = -1;
  p.ocupado = false;
}

window.Pcm = { abrirPcm, primeiroBloco, alimentar, calar, BLOCO, ADIANTADO };
