import test from 'node:test';
import assert from 'node:assert/strict';
import { DuplexSession } from '../mona_interaction/web/duplex-session.js';
import { SpeechTimeline } from '../mona_interaction/web/speech-timeline.js';

function setup() {
  const calls = [];
  let current;
  const player = {
    begin({ utteranceId }) { current = { utteranceId }; return current; },
    enqueue(token) { return { status: token === current ? 'queued' : 'stale' }; },
    finish(token) { return token === current; },
    position(token) { return token === current ? .1 : null; },
    interrupt(token) { if (token !== current) return false; current = null; calls.push('stop'); return true; },
  };
  const session = new DuplexSession({ player, timeline: new SpeechTimeline(), onInput: (item) => calls.push(item) });
  session.wake();
  return { session, calls };
}

test('only confirmed user speech interrupts playback and queues while work continues', () => {
  const { session, calls } = setup();
  session.final({ messageId: 'task', text: '执行任务', confirmed: true });
  const audio = session.beginPlayback({ utteranceId: 'reply', visemes: [{ at: 0, duration: .5, open: .8, form: 0 }] });
  assert.equal(session.sampleMouth(audio).mouthOpen, .8);
  session.partial('嗯');
  assert.equal(session.speechStarted({ confirmed: false }), false);
  assert.equal(session.sampleMouth(audio).mouthOpen, .8);
  assert.equal(session.final({ messageId: 'next', text: '等等', confirmed: true }), true);
  assert.equal(session.sampleMouth(audio).mouthOpen, 0);
  assert.equal(session.enqueueAudio(audio, {} ).status, 'stale');
  assert.equal(session.turn, 'task');
  assert.deepEqual(calls, [{ messageId: 'task', text: '执行任务' }, 'stop']);
  session.turnEnded('task');
  assert.deepEqual(calls.at(-1), { messageId: 'next', text: '等等' });
  assert.equal(session.final({ messageId: 'next', text: '等等', confirmed: true }), false);
});

test('unknown result blocks queued dispatch until explicitly reconciled', () => {
  const { session, calls } = setup();
  session.final({ messageId: 'first', text: '第一条', confirmed: true });
  session.final({ messageId: 'second', text: '第二条', confirmed: true });
  session.turnEnded('first', { unknown: true });
  assert.equal(calls.length, 1);
  assert.equal(session.acknowledgeUnknown('wrong'), false);
  assert.equal(session.acknowledgeUnknown('first'), true);
  assert.deepEqual(calls.at(-1), { messageId: 'second', text: '第二条' });
});

test('a failed dispatch remains unknown and is never automatically replayed', () => {
  let count = 0;
  const { session } = setup();
  session.onInput = () => { count++; throw new Error('delivery unknown'); };
  assert.throws(() => session.final({ messageId: 'one', text: '任务', confirmed: true }));
  assert.equal(session.unknown, true);
  assert.equal(session.final({ messageId: 'one', text: '任务', confirmed: true }), false);
  assert.equal(count, 1);
});
