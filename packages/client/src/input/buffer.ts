/**
 * `input/buffer.ts` — turning events into one byte per tick.
 *
 * ## Why this is not just "read the keys each tick"
 *
 * Input arrives as events, at whatever moment the hardware and the browser
 * decide. The sim consumes exactly one byte per tick, 30 times a second. On a
 * 144 Hz display those two rates are not aligned, and on any display a fast tap
 * can begin and end **entirely between two ticks**.
 *
 * Sampling the current key state once per tick loses that tap completely. The
 * player pressed handbrake, the game did not notice, and no log will ever show
 * why. `C-02`'s done-when names this directly: a 10 ms keypress must still
 * register.
 *
 * So the buffer is *latching*. Anything held when a tick is sampled counts, and
 * anything pressed *at all* since the last sample also counts, even if it was
 * released before the sample happened. A tick's byte is the union of "what is
 * down now" and "what happened since you last asked".
 *
 * The cost is that a very fast tap lasts a full tick rather than a fraction of
 * one — which is the right trade. A dropped input is a bug the player feels and
 * cannot explain; an input rounded up to 33 ms is imperceptible.
 *
 * ## One encoding, three devices
 *
 * Keyboard, gamepad and touch all funnel into this, so `C-02`'s "all three
 * produce identical bytes for equivalent actions" is true by construction
 * rather than by three implementations agreeing. Nothing downstream can tell
 * which device a run was played on, which is also what makes an input log
 * portable.
 */
import { INPUT_MASK } from '@deadhead/proto';

/**
 * Accumulates input events and yields one packed byte per tick.
 *
 * Deliberately knows nothing about keys, pads or screens — it takes flags. The
 * device-specific mapping lives in `keyboard.ts` and friends, so this is
 * testable without any of them.
 */
export class InputBuffer {
  /** Flags currently held down. */
  private held = 0;

  /** Flags seen at any point since the last {@link sample}, held or not. */
  private latched = 0;

  /** Mark a control as pressed. Safe to call repeatedly for auto-repeat. */
  press(flags: number): void {
    const masked = flags & INPUT_MASK;
    this.held |= masked;
    this.latched |= masked;
  }

  /** Mark a control as released. The press still counts for the tick in flight. */
  release(flags: number): void {
    this.held &= ~(flags & INPUT_MASK);
  }

  /**
   * Release everything.
   *
   * Called on blur, on pointer cancel, and on gamepad disconnect. Without it a
   * key held while the tab loses focus is held **forever** — the browser never
   * delivers the keyup — and the cab drives into a wall while the player is
   * reading their email. `G-09` pauses on blur for the same reason.
   */
  releaseAll(): void {
    this.held = 0;
  }

  /**
   * The byte for the tick about to be simulated, clearing the latch.
   *
   * Call **exactly once per tick**. Calling it twice would hand the second tick
   * a byte with the latched presses already consumed, which is precisely the
   * dropped-input bug this class exists to prevent.
   */
  sample(): number {
    const byte = (this.held | this.latched) & INPUT_MASK;
    this.latched = 0;
    return byte;
  }

  /** What is held right now, without consuming the latch. For `C-06`'s overlay. */
  peek(): number {
    return (this.held | this.latched) & INPUT_MASK;
  }
}
