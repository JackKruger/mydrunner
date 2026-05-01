// Procedural engine sound: a small Web Audio synth driven by RPM and
// throttle. No samples - everything is generated. Two oscillators give
// a layered "rumble + intake whine" that pitches up with RPM and gets
// louder on throttle.
//
// Browsers block AudioContext until a user gesture, so the first
// keyboard / mouse event has to call start().

export class EngineAudio {
  private ctx: AudioContext | null = null;
  private rumbleOsc: OscillatorNode | null = null;
  private intakeOsc: OscillatorNode | null = null;
  private rumbleGain: GainNode | null = null;
  private intakeGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private lastRpm = 800;
  private lastThrottle = 0;
  // Audio disabled by default - the procedural synth doesn't sound great
  // yet. Toggle on with M (or whatever key the main loop binds).
  private muted = true;

  /** Lazy-start - call from any user-gesture handler. Safe to call again. */
  start(): void {
    if (this.ctx) return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    // Master volume + final lowpass for warmth.
    const master = ctx.createGain();
    master.gain.value = 0.0;
    master.connect(ctx.destination);
    this.masterGain = master;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    filter.Q.value = 0.7;
    filter.connect(master);
    this.filter = filter;

    // Rumble: square at ~1/4 the engine firing frequency.
    const rumbleOsc = ctx.createOscillator();
    rumbleOsc.type = 'square';
    rumbleOsc.frequency.value = 40;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;
    rumbleOsc.connect(rumbleGain).connect(filter);
    rumbleOsc.start();
    this.rumbleOsc = rumbleOsc;
    this.rumbleGain = rumbleGain;

    // Intake/turbo whine: sawtooth, higher frequency, only audible under load.
    const intakeOsc = ctx.createOscillator();
    intakeOsc.type = 'sawtooth';
    intakeOsc.frequency.value = 80;
    const intakeGain = ctx.createGain();
    intakeGain.gain.value = 0;
    intakeOsc.connect(intakeGain).connect(filter);
    intakeOsc.start();
    this.intakeOsc = intakeOsc;
    this.intakeGain = intakeGain;

    // Fade master in.
    master.gain.setTargetAtTime(this.muted ? 0 : 0.18, ctx.currentTime, 0.5);
  }

  /** Update from current vehicle telemetry. */
  set(rpm: number, throttle: number): void {
    this.lastRpm = rpm;
    this.lastThrottle = throttle;
    if (!this.ctx || !this.rumbleOsc || !this.intakeOsc || !this.rumbleGain || !this.intakeGain) return;

    const t = this.ctx.currentTime;
    // Rumble pitch: scale linearly with RPM. ~25Hz at idle, ~120Hz at redline.
    const rumbleHz = 25 + (rpm / 6000) * 95;
    this.rumbleOsc.frequency.setTargetAtTime(rumbleHz, t, 0.05);
    // Intake an octave up.
    this.intakeOsc.frequency.setTargetAtTime(rumbleHz * 2.2, t, 0.05);

    // Volume: rumble is always there (idle hum); intake fades in with throttle.
    const throttleMag = Math.abs(throttle);
    const rumbleVol = 0.25 + throttleMag * 0.45;
    const intakeVol = throttleMag * 0.25;
    this.rumbleGain.gain.setTargetAtTime(rumbleVol, t, 0.06);
    this.intakeGain.gain.setTargetAtTime(intakeVol, t, 0.06);

    // Open the filter as RPM rises so high revs sound brighter.
    if (this.filter) {
      const cutoff = 600 + (rpm / 6000) * 2200;
      this.filter.frequency.setTargetAtTime(cutoff, t, 0.06);
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 0.18, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }
}
