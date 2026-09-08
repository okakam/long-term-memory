import { expect, test } from 'vitest';

import { composeWhyHowBody } from '@/lib/mcp/tools/compose';

test('composeWhyHowBody は Why/How セクションを冪等に追加する', () => {
  const body = composeWhyHowBody('body\n\n', 'reason', 'trigger');
  expect(body).toBe('body\n\n**Why:** reason\n**How to apply:** trigger');
  expect(composeWhyHowBody(body, 'other', 'other')).toBe(body);
});
