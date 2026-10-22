// Decides when to stop and restart reading the change stream (D-025). Reading pauses once `max` changes are
// waiting inside Driftless, and resumes only when half of them are done. Without that gap (hysteresis), a busy
// system would flip between paused and reading on every single message.
export function nextReadState(pending: number, paused: boolean, max: number): 'pause' | 'resume' | undefined {
  if (!paused && pending >= max) return 'pause';
  if (paused && pending <= max / 2) return 'resume';
  return undefined;
}
