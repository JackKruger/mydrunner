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
  private winchOsc: OscillatorNode | null = null;
  private winchGain: GainNode | null = null;
  private lastRpm = 800;
  private lastThrottle = 0;
  // Audio disabled by default - the procedural synth doesn't sound great
  // yet. Toggle on with M (or whatever key the main loop binds).
  private muted = true;

  /** Lazy-start - call from any user-gesture handler. Safe to call again;
   *  on re-entry it resumes the context if iOS / Android suspended it
   *  (tab backgrounded, screen sleep, headphones unplugged). */
  start(): void {
    if (this.ctx) {
      // iOS Safari can revoke the running state at any time. Each new
      // gesture is an opportunity to revive it.
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    // Mobile browsers (notably iOS Safari) construct AudioContexts in the
    // 'suspended' state even when `new Ctx()` runs inside a gesture
    // handler. Without this resume() call no audio ever plays on iOS:
    // currentTime never advances, so all the setTargetAtTime writes
    // queue against a frozen clock. Must be called synchronously in the
    // same gesture-handler call stack as the constructor.
    if (ctx.state === 'suspended') void ctx.resume();

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

    const winchOsc = ctx.createOscillator();
    winchOsc.type = 'triangle';
    winchOsc.frequency.value = 95;
    const winchGain = ctx.createGain();
    winchGain.gain.value = 0;
    winchOsc.connect(winchGain).connect(filter);
    winchOsc.start();
    this.winchOsc = winchOsc;
    this.winchGain = winchGain;

    // Fade master in.
    master.gain.setTargetAtTime(this.muted ? 0 : 0.18, ctx.currentTime, 0.5);
  }

  setWinch(motor: -1 | 0 | 1, load: number, status: string): void {
    if (!this.ctx || !this.winchOsc || !this.winchGain) return;
    const t = this.ctx.currentTime;
    const running = motor !== 0;
    const stalled = status === 'STALLED';
    this.winchOsc.frequency.setTargetAtTime(stalled ? 58 : 95 + Math.abs(motor) * 25 - Math.min(1, load) * 30, t, 0.04);
    this.winchGain.gain.setTargetAtTime(running ? (stalled ? 0.22 : 0.09 + Math.min(1, load) * 0.08) : 0, t, 0.035);
  }

  playWinchBreak(): void {
    if (!this.ctx || !this.filter) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(45, this.ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.18, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.2);
    osc.connect(gain).connect(this.filter);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.21);
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
    return this.setMuted(!this.muted);
  }

  setMuted(muted: boolean): boolean {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 0.18, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }
}
