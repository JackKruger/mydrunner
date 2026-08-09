import { Physics, WINCH, type VehicleBuild, type WinchLinkSnapshot, type WinchMotor } from '@mydrunner/shared';
import type { WinchAttachTarget } from '@mydrunner/shared/net';
import type { LocalSimulation } from './localSimulation.js';
import type { NetClient } from './net.js';
import type { Scene } from './scene.js';

interface Options {
  simulation(): LocalSimulation | null;
  net(): NetClient | null;
  online(): boolean;
  blocked(): boolean;
}

export class WinchController {
  private localId = 'preview';
  private build: VehicleBuild | null = null;
  private links: WinchLinkSnapshot[] = [];
  private targeting = false;
  private commandSeq = 0;
  private pending = new Map<number, 'attach' | 'detach' | 'break'>();
  private reelIn = false;
  private reelOut = false;
  private notice = '';
  private noticeUntil = 0;
  private targetLabel = '';
  private pendingOwnedLink: WinchLinkSnapshot | null = null;
  private breakCue = false;
  private readonly reticle: HTMLElement;

  constructor(private readonly scene: Scene, private readonly options: Options) {
    this.reticle = document.createElement('div');
    this.reticle.id = 'winch-reticle';
    this.reticle.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.reticle);
    window.addEventListener('keydown', (event) => {
      if (this.options.blocked()) return;
      if (event.code === 'KeyG' && !event.repeat) { event.preventDefault(); this.toggle(); }
      if (event.code === 'Escape' && this.targeting) { event.preventDefault(); this.cancelTargeting(); }
      if (event.code === 'BracketRight') { event.preventDefault(); this.reelIn = true; }
      if (event.code === 'BracketLeft') { event.preventDefault(); this.reelOut = true; }
    });
    window.addEventListener('keyup', (event) => {
      if (event.code === 'BracketRight') this.reelIn = false;
      if (event.code === 'BracketLeft') this.reelOut = false;
    });
    window.addEventListener('blur', () => { this.reelIn = false; this.reelOut = false; });
  }

  reset(localId: string, build: VehicleBuild): void {
    this.localId = localId;
    this.build = build;
    this.links = [];
    this.targeting = false;
    this.reticle.classList.remove('visible', 'valid');
    this.pending.clear();
    this.pendingOwnedLink = null;
    this.scene.setWinchTarget(null);
    this.sync();
  }

  setBuild(build: VehicleBuild): void {
    this.build = build;
    if (!this.isEquipped()) this.detach();
  }

  setLinks(links: readonly WinchLinkSnapshot[]): void {
    this.links = links.map(cloneLink);
    if (this.pendingOwnedLink) {
      if (this.links.some((link) => link.id === this.pendingOwnedLink!.id)) this.pendingOwnedLink = null;
      else this.links.push(this.pendingOwnedLink);
    }
    this.sync();
  }

  onAck(message: { seq: number; ok: boolean; link?: WinchLinkSnapshot; reason?: string }): void {
    const action = this.pending.get(message.seq);
    this.pending.delete(message.seq);
    if (!message.ok) {
      this.showNotice(message.reason ?? 'Winch request rejected.');
      return;
    }
    if (message.link) {
      this.links = this.links.filter((link) => link.ownerId !== this.localId);
      const link = cloneLink(message.link);
      this.links.push(link);
      this.pendingOwnedLink = link;
    } else if (action === 'detach' || action === 'break') {
      this.links = this.links.filter((link) => link.ownerId !== this.localId);
      this.pendingOwnedLink = null;
    }
    this.sync();
  }

  onEvent(linkId: string, reason: string): void {
    this.links = this.links.filter((link) => link.id !== linkId);
    this.showNotice(reason === 'broken' ? 'WINCH CABLE BROKEN' : 'WINCH TARGET LOST');
    if (reason === 'broken') this.breakCue = true;
    if (this.pendingOwnedLink?.id === linkId) this.pendingOwnedLink = null;
    this.sync();
  }

  toggle(): void {
    if (this.ownedLink()) { this.detach(); return; }
    if (!this.isEquipped()) { this.showNotice('FIT A STEEL WINCH BAR AND RECOVERY WINCH'); return; }
    if (!this.targeting) {
      this.targeting = true;
      this.reticle.classList.add('visible');
      this.showNotice('AIM AT A RECOVERY POINT · G TO ATTACH');
      return;
    }
    const pick = this.scene.pickWinchTarget();
    if (!pick) { this.showNotice('NO VALID RECOVERY POINT'); return; }
    this.targeting = false;
    this.reticle.classList.remove('visible');
    this.scene.setWinchTarget(null);
    if (this.options.online()) {
      const seq = ++this.commandSeq;
      this.pending.set(seq, 'attach');
      this.options.net()?.sendWinchCommand(seq, 'attach', pick.target);
    } else {
      this.attachOffline(pick.target, pick.point);
    }
  }

  detach(): void {
    this.cancelTargeting();
    const owned = this.ownedLink();
    if (!owned) return;
    if (this.options.online()) {
      const seq = ++this.commandSeq;
      this.pending.set(seq, 'detach');
      this.options.net()?.sendWinchCommand(seq, 'detach');
    }
    this.links = this.links.filter((link) => link.id !== owned.id);
    this.pendingOwnedLink = null;
    this.sync();
  }

  touchHook(): void {
    if (!this.options.blocked()) this.toggle();
  }

  update(touchIn: boolean, touchOut: boolean): void {
    if (this.options.blocked()) {
      if (this.targeting) this.cancelTargeting();
      this.options.simulation()?.setWinchMotor(0);
      return;
    }
    if (this.targeting) {
      const pick = this.scene.pickWinchTarget();
      this.targetLabel = pick?.label ?? '';
      this.reticle.classList.toggle('valid', Boolean(pick));
      this.scene.setWinchTarget(pick?.point ?? null, Boolean(pick));
    }
    const motor: WinchMotor = (this.reelIn || touchIn) && !(this.reelOut || touchOut)
      ? 1 : (this.reelOut || touchOut) && !(this.reelIn || touchIn) ? -1 : 0;
    const simulation = this.options.simulation();
    simulation?.setWinchMotor(motor);
    const runtime = simulation?.winchRuntime();
    const owned = this.ownedLink();
    if (runtime && owned && runtime.linkId === owned.id) {
      owned.cableLength = runtime.cableLength;
      owned.motor = runtime.motor;
      owned.tension = runtime.tension;
      owned.status = runtime.tension >= WINCH.breakForce * 0.99
        ? 'overload'
        : runtime.motor === 1 && runtime.tension >= WINCH.ratedPull * 0.98 ? 'stalled' : 'attached';
      this.scene.setLocalWinchLinks(this.links);
    }
  }

  afterStep(): void {
    const broken = this.options.simulation()?.consumeWinchBreak();
    if (!broken) return;
    this.links = this.links.filter((link) => link.id !== broken);
    this.showNotice('WINCH CABLE BROKEN');
    this.breakCue = true;
    if (this.options.online()) {
      const seq = ++this.commandSeq;
      this.pending.set(seq, 'break');
      this.options.net()?.sendWinchCommand(seq, 'break');
    }
    this.sync();
  }

  statusText(): string {
    if (performance.now() < this.noticeUntil) return this.notice;
    if (this.targeting) return this.targetLabel ? `TARGET ${this.targetLabel.toUpperCase()} · G TO ATTACH` : 'AIM AT A RECOVERY POINT';
    const telemetry = this.options.simulation()?.winchTelemetry();
    if (!telemetry?.attached) return '';
    const load = Math.round(telemetry.tension / WINCH.ratedPull * 100);
    const motor = telemetry.motor === 1 ? 'IN' : telemetry.motor === -1 ? 'OUT' : 'HOLD';
    return `WINCH ${motor} · ${telemetry.cableLength.toFixed(1)} M · ${load}% · ${telemetry.status}`;
  }

  runtime() { return this.options.simulation()?.winchRuntime(); }

  audioState(): { motor: WinchMotor; load: number; status: string } {
    const telemetry = this.options.simulation()?.winchTelemetry();
    return telemetry?.attached
      ? { motor: telemetry.motor, load: Math.min(1.5, telemetry.tension / WINCH.ratedPull), status: telemetry.status }
      : { motor: 0, load: 0, status: '' };
  }

  consumeBreakCue(): boolean { const cue = this.breakCue; this.breakCue = false; return cue; }

  private attachOffline(target: WinchAttachTarget, point: { x: number; y: number; z: number }): void {
    if (target.kind !== 'obstacle') return;
    const state = this.options.simulation()?.vehicleState();
    if (!state || !this.build) return;
    const source = Physics.transformPoint(Physics.geomFor(this.build).recoveryPoints.fairlead, state.position, state.rotation);
    const distance = Math.hypot(point.x - source.x, point.y - source.y, point.z - source.z);
    this.links.push({
      id: `${this.localId}:offline:${++this.commandSeq}`,
      ownerId: this.localId,
      target: { kind: 'obstacle', obstacleId: target.obstacleId, anchor: { ...point } },
      cableLength: Math.min(WINCH.maxCableLength, Math.max(WINCH.minCableLength, distance + WINCH.attachSlack)),
      motor: 0, tension: 0, status: 'attached',
    });
    this.sync();
  }

  private ownedLink(): WinchLinkSnapshot | undefined { return this.links.find((link) => link.ownerId === this.localId); }
  private isEquipped(): boolean { return Boolean(this.build?.winchId.endsWith('.fitted') && this.build.frontBarId.endsWith('.steel-winch')); }
  private cancelTargeting(): void {
    this.targeting = false;
    this.targetLabel = '';
    this.reticle.classList.remove('visible', 'valid');
    this.scene.setWinchTarget(null);
  }
  private showNotice(text: string): void { this.notice = text; this.noticeUntil = performance.now() + 2200; }
  private sync(): void {
    this.options.simulation()?.setWinchLinks(this.links);
    this.scene.setLocalWinchLinks(this.links);
  }
}

function cloneLink(link: WinchLinkSnapshot): WinchLinkSnapshot {
  return {
    ...link,
    target: link.target.kind === 'obstacle'
      ? { ...link.target, anchor: { ...link.target.anchor } }
      : { ...link.target },
  };
}
