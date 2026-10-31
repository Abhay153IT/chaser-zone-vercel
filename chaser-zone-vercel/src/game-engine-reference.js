import { bearingDegrees, haversineMeters, parseTelemetry } from './geo.js';

export const DEFAULTS = Object.freeze({
  catchMeters: 15,
  maxAccuracyMeters: 40,
  headStartSeconds: 30,
  roundSeconds: 600,
  staleFixMs: 20_000,
  reconnectGraceMs: 12_000,
  minPacketIntervalMs: 100,
  maxPlayers: 40,
});

export const Role = Object.freeze({ RUNNER: 'runner', HUNTER: 'hunter', SPECTATOR: 'spectator' });

const cleanName = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);

/**
 * Authoritative state for one arena: 1 runner, 1 hunter, n spectators.
 * Every method takes `now` explicitly, so behavior is deterministic and testable.
 */
export class Game {
  constructor(config = {}, hooks = {}) {
    this.cfg = { ...DEFAULTS, ...config };
    this.hooks = { onUrgent() {}, onNotice() {}, ...hooks };
    this.players = new Map();
    this.joinCounter = 0;
    this.dirty = false;
    this.proximityKey = '';
    this.resetRound();
  }

  resetRound() {
    this.phase = 'waiting';
    this.winner = null;
    this.reason = null;
    this.startedAt = null;
    this.headStartEndsAt = null;
    this.endsAt = null;
    this.proximity = null;
  }

  /** Mark state as changed. Urgent changes (roles, phases) flush immediately. */
  changed(urgent) {
    this.dirty = true;
    if (urgent) this.hooks.onUrgent();
  }

  holders() {
    let runner = null;
    let hunter = null;
    for (const p of this.players.values()) {
      if (p.role === Role.RUNNER) runner = p;
      else if (p.role === Role.HUNTER) hunter = p;
    }
    return { runner, hunter };
  }

  /** Register a socket for a player id. A returning id inside the grace window keeps its role. */
  connect(id, socketId, name, now) {
    let p = this.players.get(id);
    if (!p) {
      if (this.players.size >= this.cfg.maxPlayers) return null;
      p = { id, joinOrder: ++this.joinCounter, role: Role.SPECTATOR, fix: null, lastPacketAt: 0, name: '' };
      this.players.set(id, p);
    }
    p.name = cleanName(name) || p.name || `Agent-${id.slice(0, 4)}`;
    p.socketId = socketId;
    p.connected = true;
    p.dropAt = null;
    this.rebalance();
    this.evaluate(now);
    this.changed(true);
    return p;
  }

  /** Mark a socket as dropped. The role stays reserved until the grace window closes. */
  disconnect(id, socketId, now) {
    const p = this.players.get(id);
    if (!p || p.socketId !== socketId) return; // a newer socket already replaced this one
    p.connected = false;
    p.dropAt = now;
    this.changed(true);
  }

  removePlayer(id, now) {
    const p = this.players.get(id);
    if (!p) return;
    const heldRole = p.role !== Role.SPECTATOR;
    this.players.delete(id);
    this.rebalance();
    if (heldRole && this.phase !== 'waiting') {
      this.resetRound();
      this.hooks.onNotice(null, 'A player left. The round has reset.');
    }
    this.evaluate(now);
    this.changed(true);
  }

  /** Fill vacant runner/hunter slots from the longest-waiting connected spectators. */
  rebalance() {
    const { runner, hunter } = this.holders();
    const waiting = [...this.players.values()]
      .filter((p) => p.role === Role.SPECTATOR && p.connected)
      .sort((a, b) => a.joinOrder - b.joinOrder);
    const promote = (p, role) => {
      if (!p) return;
      p.role = role;
      this.hooks.onNotice(p.id, `You are now the ${role}.`);
    };
    if (!runner) promote(waiting.shift(), Role.RUNNER);
    if (!hunter) promote(waiting.shift(), Role.HUNTER);
  }

  /** Accept one telemetry packet. Returns true when the fix was stored. */
  updatePosition(id, raw, now) {
    const p = this.players.get(id);
    if (!p || p.role === Role.SPECTATOR) return false; // spectator positions are never shared
    if (now - p.lastPacketAt < this.cfg.minPacketIntervalMs) return false;
    const fix = parseTelemetry(raw);
    if (!fix) return false;
    p.lastPacketAt = now;
    p.fix = { point: fix.point, accuracy: fix.accuracy, fixTime: now - fix.ageMs };
    this.evaluate(now); // win conditions run on every packet
    this.changed(false);
    return true;
  }

  /** Housekeeping between packets: expire dropped players, stale fixes, and the round clock. */
  tick(now) {
    for (const p of [...this.players.values()]) {
      if (!p.connected && now - p.dropAt >= this.cfg.reconnectGraceMs) this.removePlayer(p.id, now);
    }
    this.evaluate(now);
  }

  freshFix(p, now) {
    return p?.fix && now - p.fix.fixTime <= this.cfg.staleFixMs ? p.fix : null;
  }

  /** Recompute proximity and apply start, catch, and timeout rules. */
  evaluate(now) {
    const { runner, hunter } = this.holders();
    const runnerFix = this.freshFix(runner, now);
    const hunterFix = this.freshFix(hunter, now);
    let proximity = null;
    if (runnerFix && hunterFix) {
      const distanceM = haversineMeters(runnerFix.point, hunterFix.point);
      proximity = {
        distanceM,
        bearingDeg: bearingDegrees(hunterFix.point, runnerFix.point),
        reliable: runnerFix.accuracy <= this.cfg.maxAccuracyMeters && hunterFix.accuracy <= this.cfg.maxAccuracyMeters,
        withinRange: distanceM <= this.cfg.catchMeters,
      };
    }
    this.proximity = proximity;
    const key = proximity ? `${Math.round(proximity.distanceM)}|${proximity.reliable}|${proximity.withinRange}` : '';
    if (key !== this.proximityKey) {
      this.proximityKey = key;
      this.changed(false);
    }

    if (this.phase === 'waiting') {
      if (proximity?.reliable && runner.connected && hunter.connected) this.startRound(now);
    } else if (this.phase === 'live') {
      if (now >= this.headStartEndsAt && proximity?.reliable && proximity.withinRange) this.finish('hunter', 'caught');
      else if (now >= this.endsAt) this.finish('runner', 'time');
    }
  }

  startRound(now) {
    this.phase = 'live';
    this.startedAt = now;
    this.headStartEndsAt = now + this.cfg.headStartSeconds * 1000;
    this.endsAt = now + this.cfg.roundSeconds * 1000;
    this.hooks.onNotice(null, `Round started. The runner has a ${this.cfg.headStartSeconds} s head start.`);
    this.changed(true);
  }

  finish(winner, reason) {
    this.phase = 'ended';
    this.winner = winner;
    this.reason = reason;
    this.hooks.onNotice(null, winner === 'hunter' ? 'The hunter caught the runner.' : 'Time is up. The runner escaped.');
    this.changed(true);
  }

  /** Swap roles and start over. Only the runner or hunter can ask, and only after a round ends. */
  rematch(id, now) {
    if (this.phase !== 'ended') return false;
    const { runner, hunter } = this.holders();
    if (!runner || !hunter || (id !== runner.id && id !== hunter.id)) return false;
    runner.role = Role.HUNTER;
    hunter.role = Role.RUNNER;
    this.resetRound();
    this.proximityKey = '';
    this.hooks.onNotice(null, 'Rematch. Roles swapped.');
    this.evaluate(now);
    this.changed(true);
    return true;
  }

  publicConfig() {
    const { catchMeters, maxAccuracyMeters, headStartSeconds, roundSeconds, staleFixMs } = this.cfg;
    return { catchMeters, maxAccuracyMeters, headStartSeconds, roundSeconds, staleFixMs };
  }

  /** One snapshot, identical for every client. Only runner and hunter positions are included. */
  snapshot(now) {
    const players = [...this.players.values()]
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map((p) => {
        const shared = p.role !== Role.SPECTATOR && p.fix;
        return {
          id: p.id,
          name: p.name,
          role: p.role,
          connected: p.connected,
          hasFix: Boolean(shared),
          lat: shared ? p.fix.point.lat : null,
          lng: shared ? p.fix.point.lng : null,
          accuracy: shared ? p.fix.accuracy : null,
          fixAgeMs: shared ? now - p.fix.fixTime : null,
        };
      });
    return {
      serverNow: now,
      phase: this.phase,
      winner: this.winner,
      reason: this.reason,
      startedAt: this.startedAt,
      headStartEndsAt: this.headStartEndsAt,
      endsAt: this.endsAt,
      config: this.publicConfig(),
      players,
      proximity: this.proximity,
    };
  }
}
