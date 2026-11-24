import { InputError, text } from './store.js';

export function parseParticipants(value) {
  if (!value) return [];
  if (typeof value !== 'string' || value.length > 6000) throw new InputError('Participant labels must be at most 6,000 characters.');
  let items;
  try { items = JSON.parse(value); } catch { throw new InputError('Participant labels must be a JSON array.'); }
  if (!Array.isArray(items) || items.length > 30) throw new InputError('Use at most 30 participant time ranges per file.');
  const result = items.map(item => {
    if (!item || !['speech', 'screen'].includes(item.kind)) throw new InputError('Participant kind must be speech or screen.');
    const name = text(item.name, 'Participant name', 80);
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) ||
        item.start < 0 || item.end <= item.start) {
      throw new InputError('Participant ranges need numeric seconds with 0 <= start < end.');
    }
    const cue = item.kind === 'screen' ? text(item.cue, 'On-screen location/description', 160) : '';
    return { kind: item.kind, name, start: item.start, end: item.end, cue };
  }).sort((a, b) => a.start - b.start);
  const speech = result.filter(item => item.kind === 'speech');
  for (let index = 1; index < speech.length; index++) {
    if (speech[index].start < speech[index - 1].end) {
      throw new InputError('Speech labels overlap. Use non-overlapping ranges; leave simultaneous speech unlabeled.');
    }
  }
  return result;
}

export function speakerLabel(participants, start, end) {
  const speech = participants.filter(item => item.kind === 'speech');
  const covered = speech.filter(item => item.start <= start && item.end >= end);
  if (covered.length === 1) return `Speaker: ${covered[0].name} (user-labeled)`;
  if (speech.some(item => item.start < end && item.end > start)) {
    return 'Speaker: uncertain (segment crosses a user-label boundary; do not attribute)';
  }
  return 'Speaker: unknown (not identified by user)';
}
