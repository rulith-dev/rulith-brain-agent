import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_FILES } from '../tools/pack.mjs';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("the agent's own front: memory, forgetting, no context limit, read capped output to the end", () => {
  const front = fs.readFileSync(path.join(here, 'brain-front.md'), 'utf8');
  assert.match(front, /no length limit/);
  assert.match(front, /forgets/);
  assert.match(front, /come into view by themselves/);
  assert.match(front, /name the file, the function or the\s+topic/);
  assert.match(front, /used least goes first/);
  assert.match(front, /never refuse, shorten or skip a task because of context size/);
  assert.match(front, /offset/);
  assert.ok(front.length < 2000, 'the front stays short: it is read at the start of every conversation');
});

test('the front ships and is the default persona', () => {
  assert.ok(APP_FILES.includes('brain-front.md'));
  const start = fs.readFileSync(path.join(here, 'start.mjs'), 'utf8');
  assert.match(start, /path\.join\(here, 'brain-front\.md'\)/);
  assert.match(start, /personaFile !== 'none'/);
});
