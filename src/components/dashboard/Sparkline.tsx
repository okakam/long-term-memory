interface SparklineProps {
  values: number[];
  label?: string;
}

export function Sparkline({ values, label = '日次推移' }: SparklineProps) {
  const max = Math.max(1, ...values);
  return (
    <span className="dashboard-sparkline" role="img" aria-label={label} style={{ display: 'inline-flex', alignItems: 'end', gap: 2, height: 24 }}>
      {values.map((value, index) => (
        <i key={String(index) + '-' + String(value)} style={{ display: 'block', width: 5, background: 'currentColor', height: String(Math.max(4, (value / max) * 100)) + '%' }} />
      ))}
    </span>
  );
}
