// The shaped postflop (`AiProfile.experiment.postflopShape`, `ai/postflop.ts`):
// its reads as pure functions, then each spot it plays against the shipped AI
// on the same hand, over enough seeds that the difference is not noise.

import test from 'ava'
import { type AiProfile, decideAction } from '@/lib/poker/ai/policy'
import { readHand, stackToPot, texture } from '@/lib/poker/ai/postflop'
import { cardFromString, mulberry32 } from '@/lib/poker/cards'
import { type Action, applyAction, type HandState, startHand } from '@/lib/poker/engine'

const cards = (s: string) => s.split(' ').map(cardFromString)

const BASE: AiProfile = { tightness: 0.4, aggression: 0.5, bluff: 0.1, iterations: 200, skill: 1 }
const SHIPPED: AiProfile = { ...BASE, experiment: { fastShowdown: true } }
const SHAPED: AiProfile = { ...BASE, experiment: { fastShowdown: true, postflopShape: true } }

/**
 * A heads-up hand on the flop: the button ("b") raised to 6 and the big blind
 * ("o") called, with these hole cards and this board. `stack` is each player's
 * chips at the start, so it sets the stack-to-pot ratio.
 */
function flopSpot(hero: string, villain: string, board: string, stack = 200): HandState {
  let s = startHand({
    seats: [
      { id: 'b', name: 'b', stack },
      { id: 'o', name: 'o', stack },
    ],
    buttonIndex: 0,
    smallBlind: 1,
    bigBlind: 2,
    rng: mulberry32(1),
  })
  s = applyAction(s, { type: 'raise', amount: 6 })
  s = applyAction(s, { type: 'call' })
  const community = cards(board)
  return {
    ...s,
    community,
    players: s.players.map((p) => ({ ...p, hole: cards(p.id === 'b' ? hero : villain) })),
  }
}

/** Play `actions` in order from `state`. */
const play = (state: HandState, ...actions: Action[]) => actions.reduce(applyAction, state)

/** How often `profile` makes a move of `type` in `state`, over `n` seeds. */
function rateOf(state: HandState, profile: AiProfile, types: string[], n = 300): number {
  let hits = 0
  for (let i = 0; i < n; i++) {
    if (types.includes(decideAction(state, profile, mulberry32(i + 1)).type)) hits++
  }
  return hits / n
}

test('texture: K94 rainbow is dry, JT9 two-tone is wet, a monotone flop is wet', (t) => {
  const dry = texture(cards('Ks 9h 4c'))
  const wet = texture(cards('Jh Th 9s'))
  const mono = texture(cards('Kh 7h 2h'))
  t.true(dry.wetness < 0.35, `dry ${dry.wetness}`)
  t.true(wet.wetness > 0.55, `wet ${wet.wetness}`)
  t.true(mono.wetness > 0.55, `mono ${mono.wetness}`)
  t.is(wet.connected, 3)
  t.is(mono.suited, 3)
  t.true(texture(cards('Ks Kh 4c')).paired)
  t.true(texture(cards('Ks Kh 4c')).wetness <= dry.wetness)
})

test('readHand: a pair on the board is the board’s, not the hand’s', (t) => {
  const boardPair = readHand(cards('Ac 7d'), cards('Ks Kh 4c'))
  t.true(boardPair.boardMade)
  t.is(boardPair.edge, 0)
  t.false(boardPair.topPair)
  const trips = readHand(cards('Kd 7c'), cards('Ks Kh 4c'))
  t.false(trips.boardMade)
  t.true(trips.topPair)
})

test('readHand: top pair and overpairs count, second pair does not', (t) => {
  const board = cards('Ks 9h 4c')
  t.true(readHand(cards('Kd 2c'), board).topPair)
  t.true(readHand(cards('Ad Ac'), board).topPair)
  t.false(readHand(cards('9d 2c'), board).topPair)
  t.false(readHand(cards('Qd Jc'), board).topPair)
})

test('readHand: the river can play the board', (t) => {
  const board = cards('As Ks Qd Jh Tc')
  t.true(readHand(cards('2c 3d'), board).playsBoard)
  t.false(readHand(cards('Tc 3d'), cards('As Ks Qd Jh 9c')).playsBoard)
})

test('readHand: outs for flush draws, open-enders and gutshots, private only', (t) => {
  t.is(readHand(cards('Ah 2h'), cards('Kh 8h 3c')).outs, 9)
  t.is(readHand(cards('8c 7d'), cards('6s 5h Kc')).outs, 8)
  t.is(readHand(cards('9c 7d'), cards('6s 5h Kc')).outs, 4)
  // Two cards make both the flush and the straight; each card counts once.
  t.is(readHand(cards('9h 8h'), cards('7h 6c 2h')).outs, 15)
  // A draw that is all board belongs to everybody.
  t.is(readHand(cards('2c 2d'), cards('9s Td Jh Qc')).outs, 0)
  t.is(readHand(cards('Ah 2h'), cards('Kh 8h 3c 4d 9s')).outs, 0)
})

test('stackToPot: the chips left to lose to the deepest live opponent, over the pot, as the street began', (t) => {
  const deep = flopSpot('Ah Kd', 'Qc Qd', 'Ks 9h 4c', 200)
  t.is(stackToPot(deep, 'o'), 194 / 12)
  const shallow = flopSpot('Ah Kd', 'Qc Qd', 'Ks 9h 4c', 20)
  t.is(stackToPot(shallow, 'o'), 14 / 12)
  // A bet does not move it: facing a pot-size bet is not by itself a commitment.
  const bet = play(deep, { type: 'check' }, { type: 'bet', amount: 12 })
  t.is(stackToPot(bet, 'o'), 194 / 12)
})

test('the raiser c-bets a dry flop more often than a wet one, with the same air', (t) => {
  // Big blind checks; the raiser holds two overcards to neither board and no draw.
  const dry = play(flopSpot('Ad 2c', '5s 5d', 'Ks 9h 4c'), { type: 'check' })
  const wet = play(flopSpot('Ad 2c', '5s 5d', 'Jh Th 9s'), { type: 'check' })
  const bets = ['bet', 'raise']
  const shapedDry = rateOf(dry, SHAPED, bets)
  const shapedWet = rateOf(wet, SHAPED, bets)
  t.true(shapedDry > shapedWet + 0.25, `dry ${shapedDry} wet ${shapedWet}`)
  // And the gap is new: the shipped AI plays the two boards alike.
  const shippedGap = Math.abs(rateOf(dry, SHIPPED, bets) - rateOf(wet, SHIPPED, bets))
  t.true(shapedDry - shapedWet > shippedGap + 0.15)
})

test('the c-bet is smaller on a dry flop than on a wet one', (t) => {
  const size = (board: string, hero: string) => {
    const s = play(flopSpot(hero, '5s 5d', board), { type: 'check' })
    const amounts: number[] = []
    for (let i = 0; i < 200; i++) {
      const a = decideAction(s, SHAPED, mulberry32(i + 1))
      if (a.type === 'bet' && a.amount !== undefined) amounts.push(a.amount)
    }
    return amounts.reduce((x, y) => x + y, 0) / Math.max(amounts.length, 1)
  }
  t.true(size('Ks 9h 4c', 'Ad 2c') < size('Jh Th 9s', 'Ah 2h'))
})

test('a low stack-to-pot ratio never folds top pair to a bet', (t) => {
  // Big blind holds top pair, weak kicker, 20 chips deep: facing a pot bet with
  // 8 behind it is committed.
  const s = play(
    flopSpot('Qc Qd', 'Kd 3c', 'Ks 9h 4c', 20),
    { type: 'check' },
    { type: 'bet', amount: 12 },
  )
  const shaky: AiProfile = { ...BASE, tightness: 0.9, skill: 1 }
  const shapedFolds = rateOf(s, { ...shaky, experiment: SHAPED.experiment }, ['fold'], 200)
  t.is(shapedFolds, 0)
})

test('a draw facing a bet raises some of the time, where the shipped AI only calls', (t) => {
  const s = play(
    flopSpot('Qc Qd', 'Ah 5h', 'Kh 8h 3c'),
    { type: 'check' },
    { type: 'bet', amount: 8 },
  )
  const shippedRaises = rateOf(s, SHIPPED, ['raise'])
  const shapedRaises = rateOf(s, SHAPED, ['raise'])
  t.true(shapedRaises > shippedRaises + 0.1, `shaped ${shapedRaises} shipped ${shippedRaises}`)
})

test('a river checked to it is bet thin with a modest hand of its own', (t) => {
  // Top pair, weak kicker, on a dry runout, heads-up and last to act.
  let s = play(flopSpot('Kd 3c', 'Qc Jd', 'Ks 9h 4c'), { type: 'check' }, { type: 'check' })
  s = play({ ...s, community: cards('Ks 9h 4c 2d') }, { type: 'check' }, { type: 'check' })
  s = play({ ...s, community: cards('Ks 9h 4c 2d 7s') }, { type: 'check' })
  const shippedBets = rateOf(s, SHIPPED, ['bet'], 200)
  const shapedBets = rateOf(s, SHAPED, ['bet'], 200)
  t.true(shapedBets >= shippedBets, `shaped ${shapedBets} shipped ${shippedBets}`)
  t.true(shapedBets > 0.2, `shaped ${shapedBets}`)
})

test('a pair the board made is played for less than the raw equity says', (t) => {
  // Facing a pot-size bet with only the board's pair and a middling kicker.
  const s = play(
    flopSpot('Qc Qd', '8d 6c', 'Ks Kh 4c'),
    { type: 'check' },
    { type: 'bet', amount: 12 },
  )
  const shippedFolds = rateOf(s, SHIPPED, ['fold'], 200)
  const shapedFolds = rateOf(s, SHAPED, ['fold'], 200)
  t.true(shapedFolds >= shippedFolds, `shaped ${shapedFolds} shipped ${shippedFolds}`)
})

test('readHand: a pocket pair that plays above the board’s pairs is its own hand', (t) => {
  const aces = readHand(cards('Ad Ac'), cards('Ks Kh 4c 4d 2s'))
  t.false(aces.boardMade)
  // Deuces under the board's two pair do not play: that hand is the board's.
  t.true(readHand(cards('2d 2c'), cards('Ks Kh 4c 4d 9s')).boardMade)
})

test('readHand: two pair from both hole cards counts as top pair or better', (t) => {
  t.true(readHand(cards('Jd Tc'), cards('Qh Jh Th')).topPair)
})

test('readHand: a board that is the nuts locks the split, and keeps its equity', (t) => {
  const royal = readHand(cards('2c 3d'), cards('As Ks Qs Js Ts'))
  t.true(royal.playsBoard)
  t.true(royal.splitLocked)
  t.false(readHand(cards('2c 3d'), cards('As Ks Qd Jh 9c')).splitLocked)
})

test('a split the board guarantees is never folded to a bet', (t) => {
  let s = play(flopSpot('Qc Qd', '2c 3d', 'As Ks Qs'), { type: 'check' }, { type: 'check' })
  s = play({ ...s, community: cards('As Ks Qs Js') }, { type: 'check' }, { type: 'check' })
  s = play(
    { ...s, community: cards('As Ks Qs Js Ts') },
    { type: 'check' },
    { type: 'bet', amount: 12 },
  )
  t.is(rateOf(s, SHAPED, ['fold'], 100), 0)
})
