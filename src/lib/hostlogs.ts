// Shared helpers for the Host Logs page components.

// Badge class for a systemd unit's active/sub state.
export function unitBadge(s: { active: string; sub: string }): string {
  if (s.active === 'failed') return 'error';
  if (s.active === 'activating' || s.sub === 'auto-restart') return 'warning';
  if (s.active === 'active') return 'success';
  return 'neutral';
}
