import { InputError } from './input.js';

export function recordingSegments(content) {
  const transcript = content.replace(/\r\n/g, '\n').split('\nTIMESTAMPED SPEECH TRANSCRIPT\n')[1]?.split('\nAI-GENERATED SAMPLED VISUAL OBSERVATIONS')[0];
  if (transcript === undefined) throw new InputError('This source has no recording transcript to review.');
  const seconds = value => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  const segments = [];
  let current;
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    if (/^(No audio track\. No speech transcription was performed\.|No speech transcription available\. See analysis warnings\.|\[\d{2}:\d{2}:\d{2}\] No speech detected in this audio segment\.)$/.test(line)) {
      current = undefined;
      continue;
    }
    const match = /^\[(\d{2}:\d{2}:\d{2}) - (\d{2}:\d{2}:\d{2})\] Speaker: .*?: (.+)$/.exec(line);
    if (match) {
      if ([match[1], match[2]].some(time => time.split(':').slice(1).some(part => Number(part) > 59)) ||
          seconds(match[2]) < seconds(match[1])) throw new InputError('The exported transcript contains invalid timestamps.');
      current = { start: seconds(match[1]), end: seconds(match[2]), text: match[3] };
      segments.push(current);
    } else {
      if (!current || line.startsWith('[')) throw new InputError('The exported transcript contains an unrecognized segment. No speech was imported.');
      current.text += `\n${line}`;
    }
  }
  return segments;
}

export function validateAssignments(assignments, segments, requireSpeech = true) {
  if (!Array.isArray(assignments) || assignments.length !== segments.length) {
    throw new InputError('Provide one executive assignment (or null for unknown) per transcript segment.');
  }
  if (assignments.some(id => id !== null && (typeof id !== 'string' || !id.trim()))) {
    throw new InputError('Speaker assignments must be executive IDs or null for unknown.');
  }
  if (requireSpeech && !assignments.some(Boolean)) throw new InputError('Identify at least one speaking segment before publishing.');
  const assigned = segments.map((segment, index) => ({ ...segment, executiveId: assignments[index] }))
    .filter(segment => segment.executiveId).sort((a, b) => a.start - b.start);
  for (let index = 0; index < assigned.length; index++) {
    for (let next = index + 1; next < assigned.length && assigned[next].start < assigned[index].end; next++) {
      if (assigned[index].executiveId !== assigned[next].executiveId) {
        throw new InputError('Overlapping speech cannot be assigned to different executives. Leave mixed or uncertain segments unknown.');
      }
    }
  }
}
