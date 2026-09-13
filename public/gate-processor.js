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

    const p = (name, i) => (params[name].length > 1 ? params[name][i] : params[name][0]);
    const dt = 1 / sampleRate;

    for (let i = 0; i < output[0].length; i++) {
      const bypass = p('bypass', i);

      // Nivel de pico entre os canais desta amostra
      let peak = 0;
      for (let c = 0; c < input.length; c++) {
        const v = Math.abs(input[c][i] || 0);
        if (v > peak) peak = v;
      }

      // Detector com ataque rapido e queda lenta, em escala linear
      const detCoef = peak > this.envelope ? 0.002 : 0.05;
      this.envelope += (peak - this.envelope) * (dt / detCoef);

      const db = this.envelope > 1e-7 ? 20 * Math.log10(this.envelope) : -120;
      const open = db > p('threshold', i);

      if (open) this.holdLeft = p('hold', i);
      else if (this.holdLeft > 0) this.holdLeft -= dt;

      const floor = Math.pow(10, -p('range', i) / 20);
      const target = open || this.holdLeft > 0 ? 1 : floor;

      // Sobe no attack, desce no release
      const tau = target > this.gainNow ? Math.max(p('attack', i), 0.0002) : p('release', i);
      this.gainNow += (target - this.gainNow) * Math.min(1, dt / tau);

      const g = bypass >= 0.5 ? 1 : this.gainNow;
      for (let c = 0; c < output.length; c++) {
        output[c][i] = (input[c] ? input[c][i] : 0) * g;
      }
    }

    return true;
  }
}

registerProcessor('gate-processor', GateProcessor);
