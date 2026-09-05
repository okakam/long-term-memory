export function json<T>(value: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}
