// Tiny touch-input helpers, shared by the player's touch-gesture wiring.
//
// We treat "touch" as a live, per-event signal: every touch-only branch is
// gated behind `pointerType === "touch"` on the event, so a desktop mouse
// never enters the tap/double-tap state machine and the hover/click code path
// stays completely untouched. (matchMedia("(hover: none)") / "(pointer:
// coarse)" would be the device-level equivalent.)

/** Max gap between two taps for them to count as a double-tap (ms). */
export const DOUBLE_TAP_MS = 300;
