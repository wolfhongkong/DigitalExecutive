import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractGeneralKnowledge } from '../lib/general-knowledge.js';

const executive = { name: 'Alex', role: 'CEO' };
const reply = knowledge => Response.json({ choices: [{ message: { content: JSON.stringify({ knowledge }) } }] });

test('general knowledge extraction combines batches, skips empty batches and rejects invalid output', async () => {
  const document = { title: 'Notes', content: `${'a'.repeat(16000)}${'b'.repeat(10)}` };
  const replies = ['- Reliability builds trust.', ''];
  const excerpts = [];
  const knowledge = await extractGeneralKnowledge({ executive, document, apiKey: 'key', model: 'model', fetcher: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.messages[0].content, /must not appear in your output/);
    excerpts.push(JSON.parse(body.messages[1].content).excerpt);
    return reply(replies.shift());
  } });
  assert.equal(knowledge, '- Reliability builds trust.');
  assert.deepEqual(excerpts.map(excerpt => excerpt.length), [16000, 10]);
  await assert.rejects(extractGeneralKnowledge({ executive, document, apiKey: 'key',
    fetcher: async () => Response.json({ choices: [{ message: { content: '{"findings":[]}' } }] }) }), /knowledge string/);
  await assert.rejects(extractGeneralKnowledge({ executive, document }), /configured AI provider/);
});
