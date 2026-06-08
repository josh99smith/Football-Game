/**
 * All sound is synthesized with the Web Audio API — no audio files. Keeps the game
 * dependency-free and tiny. Sounds are short oscillator/noise blips shaped by gain
 * envelopes. A low crowd-noise bed can be toggled during live play.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowd: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  /** The crowd's ambient floor (0..) that swells/ebbs with game tension; cheers ride above it. */
  private crowdBase = 0.12;
  private fireAmb: { src: AudioBufferSourceNode; gain: GainNode; lfo: OscillatorNode } | null = null;
  muted = false;

  /** Must be called from a user gesture (tap/click) to satisfy autoplay policies. */
  resume(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.6;
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private blip(
    type: OscillatorType,
    freq: number,
    dur: number,
    gain = 0.4,
    freqEnd?: number,
  ): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain = 0.5, hp = 200): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.now();
    const frames = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = hp;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // --- game sound effects ---------------------------------------------------

  uiTap(): void {
    this.blip("square", 520, 0.06, 0.18);
  }

  uiConfirm(): void {
    this.blip("square", 440, 0.08, 0.25);
    this.blip("square", 660, 0.1, 0.22);
  }

  whistle(): void {
    this.blip("triangle", 2300, 0.18, 0.22, 2500);
  }

  snap(): void {
    // The hike: a sharp center-snap thwack, then a QB "hut!" bark a beat later.
    this.blip("square", 180, 0.06, 0.25, 120);
    this.noise(0.04, 0.18, 500); // ball-into-hands slap
    window.setTimeout(() => { this.blip("sawtooth", 170, 0.09, 0.2, 110); this.noise(0.05, 0.14, 700); }, 40);
  }

  /** Pre-snap QB cadence bark ("hut… hut!"). */
  cadence(): void {
    this.blip("sawtooth", 165, 0.08, 0.16, 120);
    this.noise(0.05, 0.12, 700);
  }

  hit(power: number): void {
    // Layered pad impact: low body thump + a noisy crack + a short pad click.
    this.blip("sine", 95 - power * 35, 0.16, 0.34 + power * 0.34, 45);
    this.noise(0.1 + power * 0.12, 0.3 + power * 0.45, 160);
    this.blip("square", 210, 0.04, 0.1 + power * 0.12, 110);
  }

  /** A bone-rattling big hit: deep boom + sharp crack + sub thud (for hit-sticks / gang tackles). */
  bigHit(): void {
    this.blip("sine", 66, 0.24, 0.62, 34);
    this.noise(0.16, 0.6, 130);
    this.blip("square", 150, 0.05, 0.2, 70);
  }

  /** Booting a kick (FG / punt / kickoff): a foot whoosh + a solid leg thump. */
  kick(power = 0.7): void {
    this.blip("sine", 120 - power * 30, 0.14, 0.32 + power * 0.2, 48);
    this.noise(0.08, 0.22, 320);
  }

  /** Stadium air horn for touchdowns. */
  airHorn(): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.now();
    const dur = 1.1;
    for (const f of [185, 246]) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      const lfo = this.ctx.createOscillator();
      const lg = this.ctx.createGain();
      lfo.frequency.value = 5.5;
      lg.gain.value = 3.5;
      lfo.connect(lg).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.04);
      g.gain.setValueAtTime(0.3, t + dur - 0.18);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  }

  /** Classic stadium organ "Charge!" riff. */
  organCharge(): void {
    const seq: [number, number][] = [
      [392, 0], [523, 150], [659, 300], [784, 450], [659, 660], [784, 800],
    ];
    for (const [f, d] of seq) window.setTimeout(() => this.blip("square", f, 0.16, 0.2, f), d);
  }

  /** Pleasant two-note chime for first downs. */
  firstDownChime(): void {
    [659, 988].forEach((f, i) => window.setTimeout(() => this.blip("triangle", f, 0.16, 0.26), i * 110));
  }

  juke(): void {
    this.blip("triangle", 700, 0.12, 0.2, 1200);
  }

  catchBall(): void {
    this.blip("sine", 320, 0.07, 0.25);
  }

  throwBall(): void {
    this.blip("triangle", 300, 0.12, 0.22, 520);
  }

  score(): void {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      window.setTimeout(() => this.blip("square", f, 0.18, 0.3), i * 90);
    });
  }

  turnover(): void {
    this.blip("sawtooth", 300, 0.3, 0.3, 80);
  }

  fire(): void {
    const notes = [392, 523, 659, 880, 1047];
    notes.forEach((f, i) => {
      window.setTimeout(() => this.blip("sawtooth", f, 0.12, 0.28), i * 60);
    });
  }

  /** A dramatic announcer stinger under a marquee call-out: deep boom + a bright metallic ring. */
  stinger(): void {
    this.blip("sine", 140, 0.45, 0.42, 60); // body boom
    this.blip("triangle", 1180, 0.5, 0.16, 760); // shimmer tail
    this.noise(0.16, 0.22, 300); // impact crack
  }

  /** Start a quiet looping crowd-noise bed. Safe to call repeatedly. */
  startCrowd(): void {
    if (!this.ctx || !this.master || this.crowd) return;
    const seconds = 2;
    const frames = this.ctx.sampleRate * seconds;
    const buf = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let prev = 0;
    for (let i = 0; i < frames; i++) {
      // Low-pass-ish brown noise for a soft murmur.
      prev = (prev + (Math.random() * 2 - 1) * 0.04) * 0.98;
      data[i] = prev;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.0;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    gain.gain.linearRampToValueAtTime(0.14, this.now() + 1.5);
    this.crowd = { src, gain };
  }

  /** Briefly swell the crowd into a roar (after a big play). `intensity` 1 = cheer, 2 = TD roar. */
  crowdCheer(intensity = 1): void {
    if (!this.crowd || !this.ctx) return;
    const t = this.now();
    const c = this.crowd.gain.gain;
    const peak = Math.min(0.55, 0.34 + intensity * 0.12);
    const hold = 1.2 + intensity * 0.8;
    c.cancelScheduledValues(t);
    c.setValueAtTime(c.value, t);
    c.linearRampToValueAtTime(Math.max(peak, this.crowdBase + 0.2), t + 0.12);
    c.linearRampToValueAtTime(this.crowdBase, t + hold);
    this.noise(0.4 + intensity * 0.4, 0.16 + intensity * 0.08, 420); // airy roar on top of the bed
  }

  /**
   * Smoothly steer the ambient crowd toward a tension level (0..1): a quiet murmur when nothing's
   * at stake, a building rumble in the red zone / close-and-late / while a team is on fire. Called
   * each tick during live play; cheers and groans ride transiently above/below this floor.
   */
  setCrowdIntensity(level: number): void {
    const lv = level < 0 ? 0 : level > 1 ? 1 : level;
    this.crowdBase = 0.08 + lv * 0.24;
    if (!this.crowd || !this.ctx) return;
    const c = this.crowd.gain.gain;
    const t = this.now();
    // Glide the floor toward the new tension without stomping an in-flight cheer/groan transient.
    c.cancelScheduledValues(t);
    c.setValueAtTime(c.value, t);
    c.linearRampToValueAtTime(this.crowdBase, t + 1.1);
  }

  /**
   * Start a looping fire-crackle ambience while a team is ON FIRE — band-passed noise with a slow
   * flickering tremolo so it breathes like a flame. Safe to call repeatedly; `stopFire` fades out.
   */
  startFire(): void {
    if (!this.ctx || !this.master || this.fireAmb) return;
    const frames = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (Math.random() < 0.04 ? 1 : 0.18);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1100;
    bp.Q.value = 0.7;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.0001;
    const lfo = this.ctx.createOscillator();
    const lg = this.ctx.createGain();
    lfo.type = "sine";
    lfo.frequency.value = 7;
    lg.gain.value = 0.03;
    lfo.connect(lg).connect(gain.gain);
    src.connect(bp).connect(gain).connect(this.master);
    src.start();
    lfo.start();
    gain.gain.linearRampToValueAtTime(0.08, this.now() + 0.5);
    this.fireAmb = { src, gain, lfo };
  }

  stopFire(): void {
    if (!this.fireAmb || !this.ctx) return;
    const { src, gain, lfo } = this.fireAmb;
    const t = this.now();
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), t);
    gain.gain.linearRampToValueAtTime(0.0001, t + 0.6);
    try { src.stop(t + 0.7); lfo.stop(t + 0.7); } catch { /* already stopped */ }
    this.fireAmb = null;
  }

  /** Two short tweets — the whistle blowing a play dead (distinct from the single ready-whistle). */
  whistleDead(): void {
    this.blip("triangle", 2300, 0.12, 0.22, 2500);
    window.setTimeout(() => this.blip("triangle", 2300, 0.14, 0.22, 2500), 150);
  }

  /** Home-crowd disappointment: a descending "ohhh" + a dip in the bed. */
  crowdGroan(): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.now();
    for (const f of [320, 244]) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 0.62, t + 0.8);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.92);
    }
    if (this.crowd) {
      const c = this.crowd.gain.gain;
      c.cancelScheduledValues(t);
      c.setValueAtTime(c.value, t);
      c.linearRampToValueAtTime(Math.max(0.03, this.crowdBase - 0.08), t + 0.2);
      c.linearRampToValueAtTime(this.crowdBase, t + 1.3);
    }
  }

  stopCrowd(): void {
    if (this.fireAmb) this.stopFire();
    if (!this.crowd) return;
    try {
      this.crowd.src.stop();
    } catch {
      /* already stopped */
    }
    this.crowd = null;
  }
}
