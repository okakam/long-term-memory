interface DeltaProps {
  current: number;
  previous: number;
}

export function Delta({ current, previous }: DeltaProps) {
  const difference = current - previous;
  const sign = difference > 0 ? '+' : '';
  const direction = difference === 0 ? 'flat' : difference > 0 ? 'up' : 'down';
  return <small data-delta={direction}>{sign}{difference} 前期間比</small>;
}
