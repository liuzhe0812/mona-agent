const GAZES = {
  user: [0, 0],
  left: [-1, 0],
  right: [1, 0],
  down: [0, 1],
};
const TONES = {
  neutral: { browRaise: 0, headRoll: 0 },
  gentle: { browRaise: 0.035, headRoll: 0.04 },
  cheerful: { browRaise: 0.075, headRoll: -0.03 },
  serious: { browRaise: -0.1, headRoll: 0 },
  curious: { browRaise: 0.13, headRoll: 0.08 },
};
const DURATIONS = { none: 0, nod: 1, shake_head: 1.2, small_wave: 1.4 };
const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const smooth = (value) => value * value * (3 - 2 * value);

// From this seated view both the laptop and the window are to Mona's right.
// A brief look at the nearby keyboard only moves the eyes. Looking farther
// across the room can involve a small rotation around the base of the neck.
const REST_FOCUS = {
  front: { x: 0, y: 0, neck: 0 },
  desk: { x: .48, y: .55, neck: 0 },
  window: { x: .83, y: -.24, neck: .4 },
};

export class OfficeAttention {
  constructor(random = Math.random) {
    this.random = random;
    this.pose = null;
    this.look = 0;
    this.lean = 0;
    this.lookTarget = 0;
    this.away = false;
  }

  quietInterval() { return 12 + this.random() * 20; }

  orientTo(pose) {
    if (pose === this.pose) return;
    const previous = this.pose;
    this.pose = pose;
    this.age = 0;
    this.away = false;
    this.lookTarget = 0;
    if (pose === "rest") {
      this.afterWork = previous === "work";
      this.focus = this.afterWork ? REST_FOCUS.desk : REST_FOCUS.front;
      this.look = this.focus.x;
      this.lookY = this.focus.y;
      this.lean = 0;
      this.nextLook = this.afterWork ? .85 + this.random() * .75 : this.quietInterval();
    } else {
      this.nextLook = 3 + this.random() * 2;
    }
  }

  sampleRest(dt, base) {
    if (this.age >= this.nextLook) {
      this.focus = this.focus === REST_FOCUS.front
        ? (this.random() < .55 ? REST_FOCUS.desk : REST_FOCUS.window)
        : REST_FOCUS.front;
      this.nextLook = this.age + (this.focus === REST_FOCUS.front
        ? this.quietInterval() : 1 + this.random() * 2.4);
    }
    const follow = -Math.expm1(-19 * dt);
    this.look += (this.focus.x - this.look) * follow;
    this.lookY += (this.focus.y - this.lookY) * follow;
    if (Math.abs(this.look - this.focus.x) < .10) {
      this.lean += (this.focus.neck - this.lean) * -Math.expm1(-3 * dt);
    }
    // The working shoulder is already carrying the forearm. Release that
    // small residual angle once rather than inserting a new shoulder lift.
    const settle = this.afterWork ? .018 * (1 - smooth(Math.min(1, this.age / 1.4))) : 0;
    // The chest joint breathes independently. Keep the neck still between
    // changes of focus; adding procedural pitch here made every breath a nod.
    return { ...base, headYaw: this.lean, headPitch: 0, headRoll: 0, bodyYaw: 0,
      eyeX: this.look, eyeY: this.lookY, breath: (base.breath || 0) + settle };
  }

  sample(pose, delta, base, speaking) {
    const dt = Math.max(0, Math.min(delta, .1));
    // While a sprite is loading an earlier pose can be visible for a few
    // frames. It is not a new activity or a reason to change attention.
    if (pose !== this.pose || pose === "work") return base;
    this.age += dt;
    if (pose === "rest") return this.sampleRest(dt, base);
    if (this.age >= this.nextLook) {
      this.away = !this.away;
      this.lookTarget = this.away ? (this.random() - .5) * .55 : 0;
      this.nextLook = this.age + (this.away ? .45 + this.random() * 1.2 : 2.5 + this.random() * 4.5);
    }
    this.look += (this.lookTarget - this.look) * -Math.expm1(-19 * dt);
    const seat = .44 + this.look * .18;
    this.lean += (seat - this.lean) * -Math.expm1(-3 * dt);
    const breath = base.breath || 0;
    const settle = Math.max(0, Math.min(1, (this.age - .18) / .9));
    const nod = Math.sin(Math.PI * settle) ** 2;
    return { ...base, eyeX: this.look, headYaw: this.lean + 3 * (base.headYaw || 0),
      headPitch: .04 - nod * (speaking ? .2 : .46)
        + 3.6 * (base.headPitch || 0) + 5 * breath,
      breath: breath * 1.25 };
  }
}

export class PerformanceController {
  constructor({ random = Math.random } = {}) {
    if (typeof random !== "function") throw new TypeError("Invalid random source");
    this.random = random;
    this.time = 0;
    this.attention = null;
    this.driftYaw = this.createDrift(0.05);
    this.driftPitch = this.createDrift(0.04);
    this.driftBody = this.createDrift(0.035);
    this.nextBlink = this.randomBetween(2.7, 6.5);
    this.blinkDuration = this.randomBetween(0.16, 0.23);
    this.state = {
      headYaw: 0, headPitch: 0, headRoll: 0, bodyYaw: 0, eyeX: 0, eyeY: 0, eyeOpen: 1, browRaise: 0,
      smile: 0, armWave: 0, mouthOpen: 0, mouthForm: 0,
    };
    this.setDecision(null);
  }

  randomBetween(min, max) {
    const value = this.random();
    if (!inRange(value, 0, 1)) throw new TypeError("Invalid random source value");
    return min + (max - min) * value;
  }

  createDrift(amplitude) {
    return {
      amplitude, from: 0, to: this.randomBetween(-amplitude, amplitude),
      start: 0, duration: this.randomBetween(3, 7),
    };
  }

  advanceIdle() {
    const tracks = [this.driftYaw, this.driftPitch, this.driftBody];
    while (true) {
      let nextTime = this.nextBlink + this.blinkDuration;
      let nextTrack = null;
      for (const track of tracks) {
        const end = track.start + track.duration;
        if (end < nextTime) {
          nextTime = end;
          nextTrack = track;
        }
      }
      if (nextTime > this.time) break;
      if (nextTrack) {
        nextTrack.start = nextTime;
        nextTrack.from = nextTrack.to;
        nextTrack.to = this.randomBetween(-nextTrack.amplitude, nextTrack.amplitude);
        nextTrack.duration = this.randomBetween(3, 7);
      } else {
        this.nextBlink = nextTime + this.randomBetween(2.7, 6.5);
        this.blinkDuration = this.randomBetween(0.16, 0.23);
      }
    }
  }

  driftValue(track) {
    const phase = (this.time - track.start) / track.duration;
    return track.from + (track.to - track.from) * smooth(phase);
  }

  eyeOpen() {
    if (this.time < this.nextBlink) return 1;
    const phase = (this.time - this.nextBlink) / this.blinkDuration;
    return phase < 0.45
      ? 1 - smooth(phase / 0.45)
      : smooth((phase - 0.45) / 0.55);
  }

  setAttention(point) {
    if (point === null) {
      this.attention = null;
      return;
    }
    if (!inRange(point?.x, -1, 1) || !inRange(point?.y, -1, 1)) {
      throw new TypeError("Invalid attention point");
    }
    this.attention = { x: point.x, y: point.y };
  }

  setDecision(decision) {
    if (decision === null) {
      this.tone = "neutral";
      this.eyeTarget = GAZES.user;
      this.smileTarget = 0;
      this.gesture = null;
      return;
    }
    const gesture = decision?.gesture;
    if (!Object.hasOwn(TONES, decision?.tone) || !Object.hasOwn(GAZES, decision?.gaze)
        || !inRange(decision?.smile, 0, 1) || !Object.hasOwn(DURATIONS, gesture?.type)
        || !inRange(gesture?.strength, 0, 1)) {
      throw new TypeError("Invalid performance decision");
    }
    this.tone = decision.tone;
    this.eyeTarget = GAZES[decision.gaze];
    this.smileTarget = decision.smile;
    this.gesture = gesture.type === "none" ? null : {
      type: gesture.type, strength: gesture.strength, elapsed: 0,
    };
  }

  tick(deltaSeconds, speech = {}) {
    const mouthOpen = speech?.mouthOpen ?? 0;
    const mouthForm = speech?.mouthForm ?? 0;
    if (!inRange(mouthOpen, 0, 1) || !inRange(mouthForm, -1, 1)) {
      throw new TypeError("Invalid speech parameters");
    }
    const dt = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(deltaSeconds, 0.1)) : 0;
    this.time += dt;
    this.advanceIdle();
    let headYaw = 0;
    let headPitch = 0;
    let armWave = 0;
    if (this.gesture) {
      const gesture = this.gesture;
      gesture.elapsed += dt;
      const phase = gesture.elapsed / DURATIONS[gesture.type];
      if (phase >= 1) {
        this.gesture = null;
      } else {
        const motion = Math.sin(2 * Math.PI * phase) * Math.sin(Math.PI * phase) * gesture.strength;
        if (gesture.type === "nod") headPitch = motion * 0.2;
        if (gesture.type === "shake_head") headYaw = motion * 0.25;
        if (gesture.type === "small_wave") armWave = motion * 0.8;
      }
    }
    const eyeX = this.attention?.x ?? this.eyeTarget[0];
    const eyeY = this.attention?.y ?? this.eyeTarget[1];
    const targets = {
      headYaw: headYaw + this.driftValue(this.driftYaw) + eyeX * 0.09,
      headPitch: headPitch + this.driftValue(this.driftPitch) + eyeY * 0.06,
      headRoll: TONES[this.tone].headRoll,
      bodyYaw: this.driftValue(this.driftBody) + eyeX * 0.03,
      eyeX, eyeY, browRaise: TONES[this.tone].browRaise, smile: this.smileTarget, armWave,
    };
    const blend = -Math.expm1(-7 * dt);
    for (const [key, target] of Object.entries(targets)) {
      this.state[key] += (target - this.state[key]) * blend;
    }
    const mouthBlend = -Math.expm1(-36 * dt);
    this.state.mouthOpen += (mouthOpen - this.state.mouthOpen) * mouthBlend;
    this.state.mouthForm += (mouthForm - this.state.mouthForm) * mouthBlend;
    this.state.eyeOpen = this.eyeOpen();
    const breath = 0.015 * Math.sin(1.4 * this.time)
      + 0.006 * Math.sin(1.4 * Math.SQRT2 * this.time);
    return { ...this.state, breath };
  }
}
