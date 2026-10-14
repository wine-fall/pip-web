// The AI's experiment switches (`AiProfile.experiment`, measured with
// `pnpm bot-duel`). Two things are asserted exactly.
//
// **With no switch set, the AI is the one that shipped.** The Daily replays its
// opponents off a seed, so every decision and every draw from the rng has to
// come out the same as before the switches existed. The fingerprint below is a
// hash of every action over a fixed set of hands at three rungs, computed on the
// commit before this file existed and typed in, not read back out of the code.
//
// **`fastShowdown` changes nothing but the time it takes.** It settles the same
// sampled showdowns with a different evaluator, so the same rng must give the
// same equity to the last bit and the same decisions all the way through.

import test from 'ava'
import { decideAction, type AiProfile } from '@/lib/poker/ai/policy'
import { createTableMemory, observeAction } from '@/lib/poker/ai/memory'
import { cardFromString, mulberry32 } from '@/lib/poker/cards'
import { applyAction, isHandComplete, startHand } from '@/lib/poker/engine'
import { estimateEquity } from '@/lib/poker/equity'
import { exactStrength, holeStrength, preflopPercentile, preflopTop } from '@/lib/poker/range'
import { levelShare, openShare } from '@/lib/poker/ai/preflopRanges'
import { venueById, type Venue } from '@/config/venues'

const cards = (s: string) => s.split(' ').map(cardFromString)

/** Every action at three rungs over twelve hands, folded into one hash. */
function fingerprint(tweak: (p: AiProfile) => AiProfile = (p) => p): string {
  let h = 2166136261
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  for (const id of ['garage', 'cardroom', 'mainevent']) {
    const venue = venueById(id) as Venue
    const profile = tweak({ ...venue.ai, iterations: 60 })
    const rng = mulberry32(11)
    const memory = createTableMemory()
    for (let hand = 0; hand < 12; hand++) {
      let s = startHand({
        seats: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, name: `s${i}`, stack: 200 })),
        buttonIndex: hand % 6,
        smallBlind: 1,
        bigBlind: 2,
        rng,
      })
      while (!isHandComplete(s)) {
        const a = decideAction(s, profile, rng, memory)
        mix(`${a.type}${a.amount ?? ''};`)
        observeAction(memory, s, a)
        s = applyAction(s, a)
      }
    }
  }
  return (h >>> 0).toString(16)
}

/** Computed at 8dd33e6, before `AiProfile.experiment` existed. */
const SHIPPED = 'b6e55ee'

test('with no experiment set, the AI makes exactly the decisions it shipped with', (t) => {
  t.is(fingerprint(), SHIPPED)
})

test('fastShowdown makes exactly the same decisions', (t) => {
  t.is(
    fingerprint((p) => ({ ...p, experiment: { fastShowdown: true } })),
    SHIPPED,
  )
})

test('fastShowdown gives the same equity to the last bit, ranged or not', (t) => {
  const spots = [
    { hole: 'Ah Kh', community: '', opponents: 5 },
    { hole: '7c 7d', community: 'Kc 7h 2s', opponents: 2 },
    { hole: 'Qs Js', community: 'Ts 9d 2s 4c', opponents: 3 },
    { hole: '5d 4d', community: 'Ac Kd Qs Jh 9c', opponents: 1 },
  ]
  for (const spot of spots) {
    for (const selectivity of [undefined, [0.3, 0.6, 0.1, 0.8, 0.5]]) {
      const base = {
        hole: cards(spot.hole),
        community: spot.community ? cards(spot.community) : [],
        opponents: spot.opponents,
        iterations: 400,
        opponentSelectivity: selectivity?.slice(0, spot.opponents),
      }
      const slow = estimateEquity({ ...base, rng: mulberry32(5) })
      const fast = estimateEquity({ ...base, rng: mulberry32(5), fastShowdown: true })
      t.deepEqual(fast, slow, `${spot.hole} | ${spot.community}`)
    }
  }
})

test('exactStrength tells top pair from bottom pair, where holeStrength cannot', (t) => {
  const board = cards('Kc 8d 3s')
  const top = cards('Kd 4h')
  const bottom = cards('3d 4c')
  t.true(exactStrength(top, board) > exactStrength(bottom, board))
  t.is(holeStrength(top, board), holeStrength(bottom, board))
})

test('exactStrength counts a draw only when a hole card is in it', (t) => {
  // Four hearts on the turn: a heart in the hand is a made flush, not a draw,
  // so read the flop instead, where three on board plus one is the draw.
  const flop = cards('Kh 8h 3h')
  t.true(exactStrength(cards('Ah 2c'), flop) > exactStrength(cards('Ac 2c'), flop))
  // Four to a straight on the board belongs to everybody and adds to nobody.
  const run = cards('9c Td Jh Qs')
  const a = exactStrength(cards('2c 3d'), run)
  const b = exactStrength(cards('2h 4d'), run)
  t.true(Math.abs(a - b) < 0.01)
})

test('exactStrength is holeStrength before the flop', (t) => {
  for (const hole of ['Ah Kh', '7c 2d', 'Qs Qd']) {
    t.is(exactStrength(cards(hole), []), holeStrength(cards(hole), []))
  }
})

test('openingByBehind is read by the number of players behind', (t) => {
  // A table where only the first-in opener's share decides anything: a skill-1
  // seat first in with a middling hand. Opening every hand from seven behind
  // must raise; opening none must fold.
  const venue = venueById('mainevent') as Venue
  const state = startHand({
    seats: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `s${i}`, stack: 200 })),
    buttonIndex: 0,
    smallBlind: 1,
    bigBlind: 2,
    rng: mulberry32(3),
  })
  const opener = (share: number) =>
    decideAction(
      state,
      {
        ...venue.ai,
        // Loosest tightness, so the share is used as written.
        tightness: 0,
        iterations: 30,
        experiment: { openingByBehind: [0, 0, 0, 0, 0, 0, 0, share] },
      },
      mulberry32(1),
    ).type
  t.is(opener(0), 'fold')
  t.is(opener(1), 'raise')
})

test('preflopRanges off leaves the shipped decisions alone', (t) => {
  t.is(
    fingerprint((p) => ({ ...p, experiment: { fastShowdown: true, preflopRanges: false } })),
    SHIPPED,
  )
})

test('preflopRanges changes the decisions it is meant to', (t) => {
  t.not(
    fingerprint((p) => ({ ...p, experiment: { fastShowdown: true, preflopRanges: true } })),
    SHIPPED,
  )
})

/**
 * Six-handed, button on seat 0: under the gun (seat 3) opens to 3bb, the
 * cutoff 3-bets to 9bb, everybody else folds, and the opener is to act with
 * `hole`.
 */
function facingThreeBet(hole: string) {
  let s = startHand({
    seats: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, name: `s${i}`, stack: 200 })),
    buttonIndex: 0,
    smallBlind: 1,
    bigBlind: 2,
    rng: mulberry32(1),
  })
  const mine = cards(hole)
  const taken = new Set(mine.map((c) => c.rank + c.suit))
  for (const p of s.players) for (const c of p.hole) taken.add(c.rank + c.suit)
  const spare = ['2c', '2d', '3c', '3d', '4c', '4d', '5c', '5d', '6c', '6d', '7c', '7d']
    .filter((c) => !taken.has(c))
    .map(cardFromString)
  // Hand any card the opener now holds to somebody else's spare.
  for (const p of s.players) {
    if (p !== s.players[3])
      p.hole = p.hole.map((c) =>
        mine.some((m) => m.rank === c.rank && m.suit === c.suit) ? (spare.pop() as typeof c) : c,
      )
  }
  s.players[3].hole = mine
  s = applyAction(s, { type: 'raise', amount: 6 })
  s = applyAction(s, { type: 'fold' })
  s = applyAction(s, { type: 'raise', amount: 18 })
  for (let i = 0; i < 3; i++) s = applyAction(s, { type: 'fold' })
  if (s.toActIndex !== 3) throw new Error('the opener should be to act')
  return s
}

function tally(hole: string, preflopRanges: boolean) {
  const venue = venueById('mainevent') as Venue
  const profile = {
    ...venue.ai,
    iterations: 300,
    experiment: { fastShowdown: true, preflopRanges },
  }
  const state = facingThreeBet(hole)
  const out = { fold: 0, call: 0, raise: 0 } as Record<string, number>
  for (let r = 0; r < 60; r++) out[decideAction(state, profile, mulberry32(100 + r)).type]++
  return out
}

test('the shipped opener never folds a middling open to a 3-bet; preflopRanges mostly does', (t) => {
  // The leak `pnpm bot-duel` found: 0.1% folds to a 3-bet at The Main Event.
  t.is(tally('Kh Js', false).fold, 0)
  t.true(tally('Kh Js', true).fold >= 50)
})

test('preflopRanges still 4-bets aces and calls with big ace-king', (t) => {
  const aces = tally('Ah Ad', true)
  t.is(aces.fold, 0)
  t.true(aces.raise > aces.call)
  t.is(tally('Ah Ks', true).fold, 0)
})

test('preflopTop is the strongest share of hands, by the same order as preflopPercentile', (t) => {
  const top = preflopTop(0.05)
  // The share, rounded up to the end of the strength tie it lands in.
  t.true(top.length >= Math.round(0.05 * 1326) && top.length < Math.round(0.06 * 1326))
  for (const hole of top) t.true(preflopPercentile(hole) >= 0.94)
  // Never empty: the narrowest range is the hands tied for the top, aces and kings.
  t.is(preflopTop(0).length, 12)
})

test('opponentTopShare deals from the range it names', (t) => {
  const hole = cards('Kh Qs')
  const base = { hole, opponents: 1, iterations: 3000, fastShowdown: true }
  const random = estimateEquity({ ...base, rng: mulberry32(2) }).equity
  const wide = estimateEquity({ ...base, rng: mulberry32(2), opponentTopShare: [0.3] }).equity
  const narrow = estimateEquity({ ...base, rng: mulberry32(2), opponentTopShare: [0.03] }).equity
  t.true(random > wide && wide > narrow, `${random} ${wide} ${narrow}`)
  // After the flop it is ignored, and the answer is the plain one, draw for draw.
  const flop = { ...base, community: cards('2c 7d 9h') }
  t.deepEqual(
    estimateEquity({ ...flop, rng: mulberry32(4), opponentTopShare: [0.03] }),
    estimateEquity({ ...flop, rng: mulberry32(4) }),
  )
})

test('each raise level is a narrower range than the one it answers', (t) => {
  for (const open of [0.15, 0.26, 0.42]) {
    t.true(levelShare(1, open) > levelShare(2, open))
    t.true(levelShare(2, open) > levelShare(3, open))
    t.true(levelShare(3, open) >= levelShare(4, open))
    t.true(levelShare(4, open) >= 0.02)
  }
  // A 3-bet range sits where a regular's does: a few percent, more against a steal.
  t.true(levelShare(2, 0.15) >= 0.05 && levelShare(2, 0.15) <= 0.08)
  t.true(levelShare(2, 0.42) > levelShare(2, 0.15))
})

test('openShare reads where the open came from', (t) => {
  const s = facingThreeBet('Ah Ad')
  // Under the gun six-handed: five behind.
  t.is(openShare(s), 0.15)
})

test('preflopTop never splits hands of equal strength by suit', (t) => {
  for (const share of [0.02, 0.05, 0.1, 0.2]) {
    const counts = new Map<string, number>()
    for (const [a, b] of preflopTop(share)) {
      if (a.rank === b.rank) counts.set(a.rank, (counts.get(a.rank) ?? 0) + 1)
    }
    for (const [rank, n] of counts) t.is(n, 6, `${rank}${rank} at ${share}`)
  }
})

test('openShare does not count a blind that is all in from posting', (t) => {
  let s = startHand({
    seats: Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      name: `s${i}`,
      stack: i === 1 ? 1 : 200,
    })),
    buttonIndex: 0,
    smallBlind: 1,
    bigBlind: 2,
    rng: mulberry32(1),
  })
  t.is(s.players[1].status, 'allin')
  s = applyAction(s, { type: 'raise', amount: 6 })
  // Under the gun with the small blind all in: four players still to act.
  t.is(openShare(s), 0.19)
})

test('preflopRanges pays the bare price for a call that ends the betting', (t) => {
  // Under the gun opens, the cutoff 3-bets queens, under the gun moves all in.
  let s = startHand({
    seats: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, name: `s${i}`, stack: 200 })),
    buttonIndex: 0,
    smallBlind: 1,
    bigBlind: 2,
    rng: mulberry32(1),
  })
  const queens = cards('Qh Qd')
  const spare = cards('2c 3d')
  for (const p of s.players) {
    p.hole = p.hole.map((c, i) =>
      queens.some((q) => q.rank === c.rank && q.suit === c.suit) ? spare[i] : c,
    )
  }
  s.players[5].hole = queens
  s = applyAction(s, { type: 'raise', amount: 6 })
  s = applyAction(s, { type: 'fold' })
  s = applyAction(s, { type: 'raise', amount: 18 })
  for (let i = 0; i < 3; i++) s = applyAction(s, { type: 'fold' })
  s = applyAction(s, { type: 'raise', amount: 200 })
  t.is(s.toActIndex, 5)
  const venue = venueById('mainevent') as Venue
  const profile = {
    ...venue.ai,
    iterations: 300,
    experiment: { fastShowdown: true, preflopRanges: true },
  }
  let calls = 0
  for (let r = 0; r < 40; r++) if (decideAction(s, profile, mulberry32(r)).type === 'call') calls++
  t.true(calls >= 30, `${calls}/40`)
})
