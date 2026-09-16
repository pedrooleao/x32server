// Gate por canal. A Web Audio nao tem gate nativo, entao fazemos o
// envelope follower na mao: abre acima do threshold, segura pelo hold,
// fecha ate o range (atenuacao maxima) na velocidade do release.

class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bypass', defaultValue: 1, minValue: 0, maxValue: 1 },
      { name: 'threshold', defaultValue: -40, minValue: -80, maxValue: 0 },   // dB
      { name: 'range', defaultValue: 46, minValue: 3, maxValue: 60 },         // dB de atenuacao
      { name: 'attack', defaultValue: 0.001, minValue: 0, maxValue: 0.12 },   // s
      { name: 'hold', defaultValue: 0.2, minValue: 0, maxValue: 2 },          // s
      { name: 'release', defaultValue: 0.25, minValue: 0.005, maxValue: 4 },  // s
      // 1 = GATE (fecha ate o range). 2, 3, 4 = EXP2/EXP3/EXP4, que nao fecham:
      // atenuam proporcionalmente a quanto o sinal esta abaixo do threshold.
      { name: 'ratio', defaultValue: 1, minValue: 1, maxValue: 4 },
    ];
  }

  constructor() {
    super();
    this.envelope = 0;     // seguidor de nivel do sinal
    this.gainNow = 1;      // ganho aplicado no momento
    this.holdLeft = 0;     // segundos restantes de hold
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const quadro = output[0].length;
    const canais = output.length;

    // SAIDA CURTA COM O GATE DESLIGADO.
    //
    // Este processador roda em TODOS os canais o tempo todo, e o gate costuma
    // estar desligado na maioria deles. Antes o envelope e o log10 eram
    // calculados por amostra mesmo assim, e o resultado jogado fora no fim —
    // com 20 faixas, milhoes de operacoes por segundo desperdicadas. Era o
    // primeiro suspeito de estalo em maquina modesta.
    //
    // A Web Audio entrega o array com UM elemento quando o parametro nao muda
    // dentro do bloco, que e' o caso de um botao que ninguem tocou.
    const bypass = params.bypass;
    if (bypass.length === 1 && bypass[0] >= 0.5) {
      for (let c = 0; c < canais; c++) {
        if (input[c]) output[c].set(input[c]);
        else output[c].fill(0);
      }
      // Zera o estado para o gate religar limpo, sem arrastar um envelope velho.
      this.envelope = 0;
      this.gainNow = 1;
      this.holdLeft = 0;
      return true;
    }

    const p = (name, i) => (params[name].length > 1 ? params[name][i] : params[name][0]);
    const dt = 1 / sampleRate;

    // O threshold em escala linear, para decidir aberto/fechado sem log. So no
    // ramo do expansor o log e' necessario, e la ele e' inevitavel.
    const thrConst = params.threshold.length === 1 ? params.threshold[0] : null;
    let thrLin = thrConst !== null ? Math.pow(10, thrConst / 20) : 0;

    for (let i = 0; i < quadro; i++) {
      if (thrConst === null) thrLin = Math.pow(10, p('threshold', i) / 20);

      // Nivel de pico entre os canais desta amostra
      let peak = 0;
      for (let c = 0; c < input.length; c++) {
        const v = Math.abs(input[c][i] || 0);
        if (v > peak) peak = v;
      }

      // Detector com ataque rapido e queda lenta, em escala linear
      const detCoef = peak > this.envelope ? 0.002 : 0.05;
      this.envelope += (peak - this.envelope) * (dt / detCoef);

      const open = this.envelope > thrLin;

      if (open) this.holdLeft = p('hold', i);
      else if (this.holdLeft > 0) this.holdLeft -= dt;

      const range = p('range', i);
      let target;
      if (open || this.holdLeft > 0) {
        target = 1;
      } else {
        const ratio = p('ratio', i);
        if (ratio <= 1) {
          target = Math.pow(10, -range / 20);          // GATE: corta no range
        } else {
          // Expansor: cada dB abaixo do threshold vira (ratio-1) dB de
          // atenuacao, ate o limite do range. E' a diferenca audivel para o
          // gate — a cauda some aos poucos em vez de ser cortada.
          const db = this.envelope > 1e-7 ? 20 * Math.log10(this.envelope) : -120;
          const abaixo = p('threshold', i) - db;
          const atenua = Math.min(range, Math.max(0, abaixo * (ratio - 1)));
          target = Math.pow(10, -atenua / 20);
        }
      }

      // Sobe no attack, desce no release
      const tau = target > this.gainNow ? Math.max(p('attack', i), 0.0002) : p('release', i);
      this.gainNow += (target - this.gainNow) * Math.min(1, dt / tau);

      const g = p('bypass', i) >= 0.5 ? 1 : this.gainNow;
      for (let c = 0; c < canais; c++) {
        output[c][i] = (input[c] ? input[c][i] : 0) * g;
      }
    }

    return true;
  }
}

registerProcessor('gate-processor', GateProcessor);
