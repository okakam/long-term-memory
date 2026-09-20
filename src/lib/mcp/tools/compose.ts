function alreadyHasSections(body: string): boolean {
  return /\*\*Why:\*\*/.test(body) && /\*\*How to apply:\*\*/.test(body);
}

export function composeWhyHowBody(body: string, why: string, howToApply: string): string {
  if (alreadyHasSections(body)) return body;
  const trimmed = body.replace(/\n+$/, '');
  return `${trimmed}\n\n**Why:** ${why}\n**How to apply:** ${howToApply}`;
}
