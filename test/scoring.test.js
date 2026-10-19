const test = require('node:test');
const assert = require('node:assert');
const S = require('../js/scoring.js');

// Build events from a compact string: "AABAB..." with one rally per second.
function rallies(seq, start = 1) {
  return seq.split('').map((c, i) => ({ t: start + i, w: c === 'A' ? 0 : 1 }));
}

test('simple 21-0 game ends and the winner serves the next game', () => {
  const tl = S.buildTimeline({ firstServer: 1 }, rallies('A'.repeat(21)));
  const last = tl.steps[20].state;
  assert.deepStrictEqual(last.games, [{ score: [21, 0], winner: 0 }]);
  assert.deepStrictEqual(last.score, [0, 0]);
  assert.strictEqual(last.server, 0);
  assert.strictEqual(last.matchWinner, null);
});

test('deuce: 20-20 needs a two-point lead', () => {
  const ev = rallies('AB'.repeat(20) + 'A');
  const tl = S.buildTimeline({}, ev);
  const s = S.stateAt(tl, 1000);
  assert.deepStrictEqual(s.score, [21, 20]);
  assert.strictEqual(s.status, 'GAME POINT');
  assert.strictEqual(s.statusSide, 0);
  assert.strictEqual(s.games.length, 0);
});

test('cap at 30: 29-29 then next rally wins', () => {
  const ev = rallies('AB'.repeat(29) + 'B');
  const tl = S.buildTimeline({}, ev);
  const last = tl.steps[tl.steps.length - 1].state;
  assert.deepStrictEqual(last.games[0].score, [29, 30]);
  assert.strictEqual(last.games[0].winner, 1);
});

test('15-point format caps at 21', () => {
  const cfg = S.PRESETS['15'];
  const ev = rallies('AB'.repeat(20) + 'A');
  const tl = S.buildTimeline(cfg, ev);
  const last = tl.steps[tl.steps.length - 1].state;
  assert.deepStrictEqual(last.games[0].score, [21, 20]);
});

test('no-deuce option: first to 21 wins at 21-20', () => {
  const ev = rallies('AB'.repeat(20) + 'A');
  const tl = S.buildTimeline({ winBy: 1 }, ev);
  assert.deepStrictEqual(tl.steps[tl.steps.length - 1].state.games[0].score, [21, 20]);
});

test('best of 3 match ends 2-0 and later events are ignored', () => {
  const ev = rallies('A'.repeat(42) + 'BBB');
  const tl = S.buildTimeline({}, ev);
  const last = tl.steps[41].state;
  assert.strictEqual(last.matchWinner, 0);
  assert.ok(tl.steps[42].ignored);
  const s = S.stateAt(tl, 9999);
  assert.strictEqual(s.status, 'MATCH');
  assert.deepStrictEqual(s.score, [21, 0]);
  assert.strictEqual(s.games.length, 1);
  assert.strictEqual(s.server, null);
});

test('match point status in the deciding game', () => {
  const ev = rallies('A'.repeat(21) + 'B'.repeat(21) + 'A'.repeat(20));
  const tl = S.buildTimeline({}, ev);
  const s = S.stateAt(tl, 1000);
  assert.deepStrictEqual(s.score, [20, 0]);
  assert.strictEqual(s.status, 'MATCH POINT');
  assert.strictEqual(s.gameNo, 3);
});

test('final game score is held during the interval, then board resets', () => {
  const ev = rallies('A'.repeat(21)); // last rally at t=21
  const tl = S.buildTimeline({ gameEndHold: 20 }, ev);
  const during = S.stateAt(tl, 30);
  assert.deepStrictEqual(during.score, [21, 0]);
  assert.strictEqual(during.status, 'GAME');
  assert.strictEqual(during.games.length, 0);
  const after = S.stateAt(tl, 42);
  assert.deepStrictEqual(after.score, [0, 0]);
  assert.strictEqual(after.games.length, 1);
  assert.strictEqual(after.server, 0);
  assert.strictEqual(after.gameNo, 2);
});

test('before the first event the board shows the starting state', () => {
  const tl = S.buildTimeline({ priorGames: [[18, 21]], startScore: [5, 3], firstServer: 1 }, rallies('A', 10));
  const s = S.stateAt(tl, 2);
  assert.deepStrictEqual(s.score, [5, 3]);
  assert.strictEqual(s.games.length, 1);
  assert.strictEqual(s.server, 1);
  assert.strictEqual(s.gameNo, 2);
  assert.deepStrictEqual(S.stateAt(tl, 10).score, [6, 3]);
});

test('events are replayed in time order regardless of insertion order', () => {
  const tl = S.buildTimeline({}, [{ t: 5, w: 1 }, { t: 2, w: 0 }, { t: 3, w: 0 }]);
  assert.deepStrictEqual(S.stateAt(tl, 3.5).score, [2, 0]);
  assert.deepStrictEqual(S.stateAt(tl, 5).score, [2, 1]);
  assert.strictEqual(S.stateAt(tl, 5).server, 1);
});

test('youtube summary has result and chapters', () => {
  const ev = rallies('A'.repeat(21) + 'B'.repeat(21) + 'A'.repeat(21));
  const tl = S.buildTimeline({ teams: [{ players: ['Ravi'] }, { players: ['Arjun'] }] }, ev);
  const text = S.youtubeSummary(tl, 70);
  assert.match(text, /Ravi vs Arjun/);
  assert.match(text, /Result: Ravi won 2-1 \(21-0, 0-21, 21-0\)/);
  assert.match(text, /0:00 Game 1 \(21-0\)/);
  assert.match(text, /0:21 Game 2 \(0-21\)/);
  assert.match(text, /0:42 Game 3 \(21-0\)/);
});

test('changeTimes includes interval resets', () => {
  const tl = S.buildTimeline({ gameEndHold: 10 }, rallies('A'.repeat(21)));
  const times = S.changeTimes(tl);
  assert.ok(times.includes(21));
  assert.ok(times.includes(31));
  assert.strictEqual(times[0], 0);
});

test('near/far: ends change after each game and at 11 in the deciding game', () => {
  const cfg = { startNear: 1 };
  // Game 1 to side A 21-0 (t=1..21), game 2 to B 21-0 (t=22..42), then 10 points to A, then 1 more.
  const ev = rallies('A'.repeat(21) + 'B'.repeat(21) + 'A'.repeat(11));
  const tl = S.buildTimeline(cfg, ev);
  assert.strictEqual(S.nearSideAt(tl, 0), 1); // start
  assert.strictEqual(S.nearSideAt(tl, 20.5), 1); // still game 1
  assert.strictEqual(S.nearSideAt(tl, 21), 0); // game 1 over -> change ends
  assert.strictEqual(S.nearSideAt(tl, 42), 1); // game 2 over -> change again
  assert.strictEqual(S.nearSideAt(tl, 52), 1); // game 3 at 10-0
  assert.strictEqual(S.nearSideAt(tl, 53), 0); // 11-0 in the decider -> change ends
});

test('near/far: no change in a non-deciding game at 11, and option to never change', () => {
  const tl = S.buildTimeline({ startNear: 0 }, rallies('A'.repeat(11)));
  assert.strictEqual(S.nearSideAt(tl, 100), 0);
  const fixed = S.buildTimeline({ startNear: 0, changeEnds: false }, rallies('A'.repeat(21)));
  assert.strictEqual(S.nearSideAt(fixed, 100), 0);
});

test('near/far: video starting mid-way counts changes from the start of the video', () => {
  // Video starts in game 3 at 12-9 (players already changed at 11) with side 0 near.
  const tl = S.buildTimeline({ startNear: 0, priorGames: [[21, 18], [15, 21]], startScore: [12, 9] }, rallies('A'));
  assert.strictEqual(S.nearSideAt(tl, 0), 0);
  assert.strictEqual(S.nearSideAt(tl, 5), 0);
  // 15-point games change at 8 in the decider; one-game match is the decider.
  const one = S.buildTimeline(Object.assign({ bestOf: 1, startNear: 0 }, S.PRESETS['15']), rallies('B'.repeat(8)));
  assert.strictEqual(S.nearSideAt(one, 7.5), 0);
  assert.strictEqual(S.nearSideAt(one, 8), 1);
});
