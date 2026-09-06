interface BarProps {
  value: number;
  max?: number;
  label?: string;
}

export function Bar({ value, max = 1, label }: BarProps) {
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <span className="dashboard-bar" aria-label={label} style={{ display: 'block', height: 10, background: '#e5e7eb' }}>
      <span style={{ display: 'block', width: String(ratio * 100) + '%', height: '100%', background: 'currentColor' }} />
    </span>
  );
}
