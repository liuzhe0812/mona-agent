const GAZES = {
  user: [0, 0],
  left: [-1, 0],
  right: [1, 0],
  down: [0, 1],
};
const TONES = new Set(["neutral", "gentle", "cheerful", "serious", "curious"]);
const DURATIONS = { none: 0, nod: 1, shake_head: 1.2, small_wave: 1.4 };
const unitNumber = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

export class PerformanceController {
  constructor() {
    this.state = { headYaw: 0, headPitch: 0, eyeX: 0, eyeY: 0, smile: 0, armWave: 0 };
    this.time = 0;
    this.setDecision(null);
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
    if (!TONES.has(decision?.tone) || !Object.hasOwn(GAZES, decision?.gaze)
        || !unitNumber(decision?.smile) || !Object.hasOwn(DURATIONS, gesture?.type)
        || !unitNumber(gesture?.strength)) {
      throw new TypeError("Invalid performance decision");
    }
    this.tone = decision.tone;
    this.eyeTarget = GAZES[decision.gaze];
    this.smileTarget = decision.smile;
    this.gesture = gesture.type === "none" ? null : {
      type: gesture.type, strength: gesture.strength, elapsed: 0,
    };
  }

  tick(deltaSeconds) {
    const dt = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(deltaSeconds, 0.1)) : 0;
    this.time += dt;
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
    const targets = {
      headYaw, headPitch, eyeX: this.eyeTarget[0], eyeY: this.eyeTarget[1],
      smile: this.smileTarget, armWave,
    };
    const blend = -Math.expm1(-7 * dt);
    for (const key of Object.keys(this.state)) {
      this.state[key] += (targets[key] - this.state[key]) * blend;
    }
    const breath = 0.015 * Math.sin(1.4 * this.time)
      + 0.006 * Math.sin(1.4 * Math.SQRT2 * this.time);
    return { ...this.state, breath };
  }
}
