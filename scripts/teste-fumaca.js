'use strict';

// Teste de fumaca: fala com uma mesa que ja esteja no ar e confere o basico.
// Serve para rodar no Windows pelo GitHub Actions, onde ninguem esta olhando a
// tela — se algo especifico da plataforma quebrar (bind de UDP, caminho de
// arquivo), e' aqui que aparece.
//
//   node scripts/teste-fumaca.js

const dgram = require('dgram');
const http = require('http');
const path = require('path');
const fs = require('fs');

const OSC = 10023;
const HTTP = 8080;
const osc = require(path.join(__dirname, '..', 'osc.js'));

const falhas = [];
const ok = (t) => console.log(`  ok    ${t}`);
const falhou = (t, d) => { falhas.push(t); console.log(`  FALHA ${t}${d ? ' — ' + d : ''}`); };

function pedirOsc(endereco, args = []) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const prazo = setTimeout(() => { sock.close(); resolve(null); }, 4000);
    sock.on('message', (m) => {
      clearTimeout(prazo);
      sock.close();
      resolve(osc.decode(m));
    });
    const b = osc.encode(endereco, args);
    sock.send(b, 0, b.length, OSC, '127.0.0.1');
  });
}

function pegarHttp(caminho, porta = HTTP) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: caminho, timeout: 4000 }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const bruto = Buffer.concat(partes);
        resolve({ status: res.statusCode, corpo: bruto.toString('utf8'), bytes: bruto, cabecalhos: res.headers });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Um WAV de 1 s, 48 kHz, 24 bits, mono, com uma rampa: cada quadro guarda o
// proprio numero. Assim da' para conferir se o pedaco veio da posicao certa.
function escreverWavDeTeste(destino) {
  const taxa = 48000;
  const quadros = taxa;
  const dados = Buffer.alloc(quadros * 3);
  for (let i = 0; i < quadros; i++) dados.writeIntLE(i, i * 3, 3);

  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dados.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(taxa, 24);
  h.writeUInt32LE(taxa * 3, 28);
  h.writeUInt16LE(3, 32);
  h.writeUInt16LE(24, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dados.length, 40);
  fs.writeFileSync(destino, Buffer.concat([h, dados]));
  return { taxa, quadros };
}

async function testarPcm() {
  const lista = await pegarHttp('/stems');
  let pasta;
  try {
    pasta = JSON.parse(lista.corpo).pasta;
  } catch {
    pasta = null;
  }
  if (!pasta) {
    // Sem pasta lembrada nao ha o que cortar; nao e' falha da mesa.
    console.log('  --    corte de PCM (nenhuma pasta de stems lembrada)');
    return;
  }

  const nome = 'teste-de-fumaca.wav';
  const arquivo = path.join(pasta, nome);
  let esperado;
  try {
    esperado = escreverWavDeTeste(arquivo);
  } catch (err) {
    console.log(`  --    corte de PCM (nao deu para escrever em ${pasta}: ${err.message})`);
    return;
  }

  try {
    const meta = await pegarHttp(`/pcm/${encodeURIComponent(nome)}`);
    if (!meta || meta.status !== 200) { falhou('/pcm devolveu o formato'); return; }
    const info = JSON.parse(meta.corpo);
    if (info.taxa !== esperado.taxa || info.bits !== 24 || info.canais !== 1 || info.quadros !== esperado.quadros) {
      falhou('/pcm leu o cabecalho', JSON.stringify(info));
      return;
    }
    ok(`/pcm leu o cabecalho: ${info.canais} ch, ${info.taxa} Hz, ${info.bits} bits`);

    // Um pedaco do meio: 1000 quadros a partir do quadro 12345.
    const de = 12345;
    const n = 1000;
    const pedaco = await pegarHttp(`/pcm/${encodeURIComponent(nome)}?de=${de}&n=${n}`, HTTP + 1);
    if (!pedaco || pedaco.status !== 200) { falhou('/pcm cortou um pedaco'); return; }
    // Sem CORS na porta vizinha a Web Audio trata o audio como "sujo" e o canal
    // sai mudo, sem erro nenhum na tela.
    if (pedaco.cabecalhos['access-control-allow-origin'] !== '*') {
      falhou('pedaco veio com CORS', 'sem CORS a Web Audio silencia a faixa');
      return;
    }
    if (pedaco.bytes.length !== 44 + n * 3) {
      falhou('pedaco com o tamanho certo', `${pedaco.bytes.length} bytes, esperava ${44 + n * 3}`);
      return;
    }
    const primeiro = pedaco.bytes.readIntLE(44, 3);
    const ultimo = pedaco.bytes.readIntLE(44 + (n - 1) * 3, 3);
    if (primeiro !== de || ultimo !== de + n - 1) {
      falhou('pedaco veio da posicao certa', `quadros ${primeiro}..${ultimo}, esperava ${de}..${de + n - 1}`);
      return;
    }
    ok(`/pcm cortou os quadros ${primeiro}..${ultimo}, com CORS, pela porta ${HTTP + 1}`);
  } finally {
    try { fs.unlinkSync(arquivo); } catch { /* ja sumiu */ }
  }
}

(async () => {
  console.log(`\nTestando a mesa em ${process.platform}/${process.arch}\n`);

  // 1. A mesa se identifica como X32?
  const xinfo = await pedirOsc('/xinfo');
  if (!xinfo) falhou('/xinfo respondeu', 'sem resposta na porta 10023');
  else if (xinfo.args[2] !== 'X32') falhou('/xinfo diz X32', `veio "${xinfo.args[2]}"`);
  else ok(`/xinfo: ${xinfo.args.join(' ')}`);

  // 2. Escrever e reler um fader — prova que o estado funciona.
  await pedirOsc('/ch/05/mix/fader', [{ type: 'f', value: 0.5 }]);
  const fader = await pedirOsc('/ch/05/mix/fader');
  if (!fader) falhou('fader respondeu');
  else if (Math.abs(fader.args[0] - 0.5) > 0.001) falhou('fader guardou o valor', `veio ${fader.args[0]}`);
  else ok('escrita e leitura de fader');

  // 3. O catch-all responde? E' o que segura o sync do Mixing Station.
  const extra = await pedirOsc('/ch/07/insert/sel');
  if (!extra) falhou('catch-all respondeu endereco desconhecido');
  else ok('catch-all de enderecos');

  // 4. O /node devolve a linha de configuracao no formato do X32.
  const node = await pedirOsc('/node', [{ type: 's', value: 'ch/01/config' }]);
  if (!node) falhou('/node respondeu');
  else if (!/^\/ch\/01\/config ".*" \d+ \w+ \d+$/.test(node.args[0])) {
    falhou('/node no formato do X32', node.args[0]);
  } else ok(`/node: ${node.args[0]}`);

  // 5. O player e' servido? Sem isto a janela abre em branco.
  const pagina = await pegarHttp('/');
  if (!pagina) falhou('player respondeu', 'sem resposta na porta 8080');
  else if (pagina.status !== 200) falhou('player respondeu 200', `veio ${pagina.status}`);
  else if (!pagina.corpo.includes('id="trocar"')) falhou('player esta completo', 'faltou o botao de trocar musica');
  else ok('player servido e completo');

  // 6. O worklet do gate precisa ser servivel, senao o gate nao carrega.
  const worklet = await pegarHttp('/gate-processor.js');
  if (!worklet || worklet.status !== 200) falhou('gate-processor.js servido');
  else ok('gate-processor.js servido');

  // 7. As portas vizinhas de stems subiram? Sao elas que tiram o limite de 6
  // conexoes por origem do navegador, que deixava metade das faixas muda.
  // Aqui so interessa que a porta esteja atendendo; o CORS e' conferido no
  // teste seguinte, num pedido que de fato devolve audio.
  const vizinha = await pegarHttp('/pcm/', HTTP + 1);
  if (!vizinha) falhou('porta vizinha de stems respondeu', `sem resposta na ${HTTP + 1}`);
  else ok(`porta vizinha de stems no ar (${HTTP + 1})`);

  // 8. O corte de PCM. E' o caminho que faz 18 stems de 24 bits caberem na
  // memoria, e e' cheio de conta de byte — justo o que muda de sistema para
  // sistema. Geramos um WAV conhecido e conferimos o pedaco que volta.
  await testarPcm();

  console.log('');
  if (falhas.length) {
    console.log(`${falhas.length} falha(s): ${falhas.join(', ')}\n`);
    process.exit(1);
  }
  console.log('tudo passou\n');
})();
