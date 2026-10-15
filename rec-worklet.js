// AudioWorklet that hands raw PCM blocks (4096 frames) to the main thread for recording.
class Rec extends AudioWorkletProcessor {
  constructor() {
    super(); this.b = null; this.n = 0;
    this.port.onmessage = () => { this.flush(); this.port.postMessage('done'); };
  }
  flush() { if (this.b && this.n) this.port.postMessage(this.b.map((a) => a.slice(0, this.n))); this.b = null; this.n = 0; }
  process(inputs) {
    const x = inputs[0];
    if (!x || !x.length) return true;
    if (!this.b) this.b = x.map(() => new Float32Array(4096));
    for (let c = 0; c < this.b.length; c++) this.b[c].set(x[c] || x[0], this.n);
    this.n += x[0].length;
    if (this.n >= 4096) { this.port.postMessage(this.b, this.b.map((a) => a.buffer)); this.b = null; this.n = 0; }
    return true;
  }
}
registerProcessor('rec', Rec);
