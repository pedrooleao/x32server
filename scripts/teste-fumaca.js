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

function pegarHttp(caminho) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: HTTP, path: caminho, timeout: 4000 }, (res) => {
      let corpo = '';
      res.on('data', (c) => (corpo += c));
      res.on('end', () => resolve({ status: res.statusCode, corpo }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
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

  console.log('');
  if (falhas.length) {
    console.log(`${falhas.length} falha(s): ${falhas.join(', ')}\n`);
    process.exit(1);
  }
  console.log('tudo passou\n');
})();
