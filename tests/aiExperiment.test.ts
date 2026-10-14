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
import { exactStrength, holeStrength } from '@/lib/poker/range'
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

test('postflopShape switched off makes exactly the shipped decisions', (t) => {
  t.is(
    fingerprint((p) => ({ ...p, experiment: { fastShowdown: true, postflopShape: false } })),
    SHIPPED,
  )
})

test('postflopShape switched on changes the decisions it is meant to', (t) => {
  t.not(
    fingerprint((p) => ({ ...p, experiment: { fastShowdown: true, postflopShape: true } })),
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
