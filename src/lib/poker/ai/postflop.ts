// Postflop structure for the AI, behind `AiProfile.experiment.postflopShape`.
//
// `decideAction` reads a flop as one number, its Monte-Carlo equity, and that
// number does not know what kind of board it is on. Measured on the shipped AI:
// it c-bets K-9-4 rainbow and J-T-9 two-tone at the same rate and size; it
// counts a pair on the board as its own pair; it folds top pair with a pot's
// worth left behind; a flush draw facing a bet only ever calls; and it never
// bets a river for thin value. This file adds the reads a player would make
// there, as pure functions of the hand, and one move function that plays the
// spots they change. Everything else falls through to the shipped policy.
//
// Nothing here is drawn from the rng unless the switch is on, so the shipped
// AI, which the Daily replays off a seed, is untouched (`tests/aiExperiment`).
//
// The ideas are the textbook ones (board texture, stack-to-pot ratio, the gap
// between what a hand makes and what the board makes for everybody, as in the
// Loki/Poki papers' hand-potential reads); the code is written here.

import { type Card, cardToString, createDeck, type Rank, type Rng } from '../cards'
import { type HandState, type LegalActions, potSize } from '../engine'
import { CATEGORY, categoryOf, rankHoldem } from '../rank7'
import { preflopAggressor, streetIsUnbet } from './line'
import { foldiness, type TableMemory } from './memory'

const RANK_VALUE: Record<Rank, number> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
}

/**
 * Every number the shaped postflop plays on, in one place. A starting point to
 * measure with `pnpm bot-duel --a post --b fast`, not a solved strategy.
 */
export const SHAPE = {
  /** Wetness below this is a dry board, above `wet` a wet one. */
  dry: 0.35,
  wet: 0.55,
  /** The raiser's flop c-bet with a hand short of value, heads-up, by texture. */
  cbetDry: 0.65,
  cbetMid: 0.5,
  cbetWet: 0.25,
  /** C-bet size as a fraction of the pot: small on dry boards, big on wet. */
  cbetSizeDry: 0.33,
  cbetSizeWet: 0.66,
  /** A value bet's size, scaled by texture around the shipped value size. */
  valueScaleDry: 0.85,
  valueScaleWet: 1.15,
  /**
   * Equity kept by a hand whose made hand is the board's (a pair on a paired
   * board with nothing in the hand pairing it), and by one playing the board
   * outright on the river. Opponents' sampled ranges cannot see that the
   * board's pair is everybody's, so the raw equity flatters these.
   */
  boardMadeKeep: 0.8,
  playsBoardKeep: 0.6,
  /** At or under this stack-to-pot ratio, top pair or better is committed. */
  commitSpr: 2.5,
  /** Or once this share of the stack is already in the pot. */
  commitShare: 0.4,
  /** A committed top pair calls with this share of the bare pot odds. */
  commitOdds: 0.8,
  /** Chance a draw raises a bet heads-up, per out, before aggression and skill. */
  semiRaisePerOut: 0.02,
  /** Fewest outs that count as a draw worth raising. */
  semiRaiseOuts: 8,
  /** Semi-bluff raise size as a fraction of the pot after calling. */
  semiRaiseSize: 0.75,
  /** River thin value: the band's floor as a multiple of a fair share. */
  thinFloor: 1.04,
  /** Its frequency, before aggression, skill and position. */
  thinBase: 0.4,
  thinPerAggression: 0.35,
  /** Its size as a fraction of the pot. */
  thinSize: 0.35,
} as const

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

// --- texture -----------------------------------------------------------------

export interface Texture {
  /** Most cards of one suit on the board. */
  suited: number
  /** Most board ranks inside any five-rank window: three makes a straight with two cards. */
  connected: number
  /** The board holds a pair or better. */
  paired: boolean
  /** How much the board helps draws and two-card hands, 0 (dry) to 1 (wet). */
  wetness: number
}

/**
 * How dry or wet a board is: K♠9♥4♣ is about 0.15, J♥T♥9♠ about 0.8. Flush
 * and straight risk combine as independent chances; a pair on the board makes
 * it drier, because fewer two-card hands connect with it.
 */
export function texture(board: readonly Card[]): Texture {
  const suits = new Map<string, number>()
  let mask = 0
  const ranks = new Map<number, number>()
  for (const c of board) {
    suits.set(c.suit, (suits.get(c.suit) ?? 0) + 1)
    const v = RANK_VALUE[c.rank]
    ranks.set(v, (ranks.get(v) ?? 0) + 1)
    mask |= 1 << v
    if (v === 14) mask |= 1 << 1
  }
  const suited = Math.max(0, ...suits.values())
  let connected = 0
  for (let low = 1; low <= 10; low++) {
    let n = 0
    for (let v = low; v < low + 5; v++) if (mask & (1 << v)) n++
    connected = Math.max(connected, n)
  }
  const paired = [...ranks.values()].some((n) => n >= 2)

  const flush = suited >= 3 ? 0.8 : suited === 2 ? 0.35 : 0
  const straight = connected >= 3 ? 0.7 : connected === 2 ? 0.15 : 0
  const wetness = clamp(1 - (1 - flush) * (1 - straight) - (paired ? 0.15 : 0), 0, 1)
  return { suited, connected, paired, wetness }
}

// --- the hand against the board -----------------------------------------------

/**
 * What the hole cards add to the board:
 *
 * - `boardMade`: the made hand is the board's own category (a pair on a paired
 *   board, with no hole card pairing anything), so it is everybody's.
 * - `playsBoard`: on the river, the best five are the board's five.
 * - `edge`: category steps the hole cards add over the board alone, the
 *   "private edge" of seven cards against the board's five.
 * - `topPair`: a private pair at or above the board's top card (an overpair
 *   counts), or anything stronger the hole cards made.
 * - `outs`: cards that complete a private flush or straight draw, flop and
 *   turn only, and only while the hand is short of a straight.
 */
export interface HandRead {
  edge: number
  boardMade: boolean
  playsBoard: boolean
  /** The board is the nuts: every holding plays it, so every showdown splits. */
  splitLocked: boolean
  topPair: boolean
  outs: number
}

export function readHand(hole: readonly Card[], board: readonly Card[]): HandRead {
  const rank7 = rankHoldem(hole, board)
  const rankBoard = rankHoldem([], board)
  const cat7 = categoryOf(rank7)
  const catBoard = categoryOf(rankBoard)
  const edge = cat7 - catBoard

  const boardTop = Math.max(...board.map((c) => RANK_VALUE[c.rank]))
  const boardRanks = new Set(board.map((c) => RANK_VALUE[c.rank]))
  const [a, b] = hole.map((c) => RANK_VALUE[c.rank])
  let privatePair = 0
  if (a === b) privatePair = a
  for (const v of [a, b]) if (boardRanks.has(v)) privatePair = Math.max(privatePair, v)

  // Same category as the board is not enough to call it the board's: pocket
  // aces on K-K-4-4 are aces and kings, two pair like the board's but theirs.
  const boardMade =
    edge === 0 &&
    catBoard >= CATEGORY.pair &&
    !(privatePair > 0 && pairedValues(rank7).includes(privatePair))
  const playsBoard = board.length === 5 && rank7 === rankBoard
  const splitLocked = playsBoard && !beatable(rankBoard, [...hole, ...board])

  // Two pair made with both hole cards is stronger than top pair, whatever
  // the board's top card.
  const twoPrivatePairs =
    cat7 === CATEGORY.twoPair && a !== b && boardRanks.has(a) && boardRanks.has(b)
  const topPair =
    edge > 0 &&
    (cat7 >= CATEGORY.trips || twoPrivatePairs || (privatePair > 0 && privatePair >= boardTop))

  const outs = board.length < 5 && cat7 < CATEGORY.straight ? drawOuts(hole, board) : 0
  return { edge, boardMade, playsBoard, splitLocked, topPair, outs }
}

/** The ranks, as values 2 to 14, that a `rankHoldem` score holds two or more of. */
function pairedValues(rank: number): number[] {
  const k = rank % 0x100000
  const nibble = (i: number) => ((k >> (4 * i)) & 0xf) + 2
  switch (categoryOf(rank)) {
    case CATEGORY.pair:
      return [nibble(3)]
    case CATEGORY.twoPair:
      return [nibble(2), nibble(1)]
    case CATEGORY.trips:
      return [nibble(2)]
    case CATEGORY.fullHouse:
      return [nibble(1), nibble(0)]
    case CATEGORY.quads:
      return [nibble(1)]
    default:
      return []
  }
}

/** Whether any two unseen cards beat a five-card board on the river. */
function beatable(rankBoard: number, seen: readonly Card[]): boolean {
  const gone = new Set(seen.map(cardToString))
  const unseen = createDeck().filter((c) => !gone.has(cardToString(c)))
  const board = seen.slice(2)
  for (let i = 0; i < unseen.length; i++) {
    for (let j = i + 1; j < unseen.length; j++) {
      if (rankHoldem([unseen[i], unseen[j]], board) > rankBoard) return true
    }
  }
  return false
}

/**
 * Unseen cards that complete a straight or a flush the board alone does not
 * make with that card, each counted once: nine for a flush draw, eight for an
 * open-ender, four for a gutshot, fifteen for both a flush draw and an
 * open-ender (two cards make both).
 */
function drawOuts(hole: readonly Card[], board: readonly Card[]): number {
  const seen = new Set([...hole, ...board].map(cardToString))
  let outs = 0
  for (const c of createDeck()) {
    if (seen.has(cardToString(c))) continue
    const cat = categoryOf(rankHoldem(hole, [...board, c]))
    if (cat < CATEGORY.straight || cat === CATEGORY.fullHouse || cat === CATEGORY.quads) continue
    const boardAlone = categoryOf(rankHoldem([], [...board, c]))
    if (boardAlone < CATEGORY.straight) outs++
  }
  return outs
}

// --- stack to pot --------------------------------------------------------------

/**
 * Stack-to-pot ratio as the street began: the chips the player could still
 * lose to its deepest live opponent then, over the pot then. Measured from the
 * start of the street on purpose: read after a bet, every big bet would make
 * the ratio small and "commit" whoever faces it, which is the bettor's whole
 * point.
 */
export function stackToPot(state: HandState, playerId: string): number {
  const self = state.players.find((p) => p.id === playerId)
  if (!self) return Number.POSITIVE_INFINITY
  const deepest = Math.max(
    0,
    ...state.players
      .filter((p) => p.id !== playerId && p.status !== 'folded' && p.status !== 'out')
      .map((p) => p.stack + p.committedThisStreet),
  )
  const behind = Math.min(self.stack + self.committedThisStreet, deepest)
  const thisStreet = state.players.reduce((sum, p) => sum + p.committedThisStreet, 0)
  return behind / Math.max(potSize(state) - thisStreet, state.bigBlind, 1)
}

// --- the shaped spots -----------------------------------------------------------

/**
 * The five parts of the shaped postflop, each switchable on its own so a duel
 * can measure them one at a time. `postflopShape: true` is all five.
 */
export interface PostflopParts {
  /** The raiser's flop c-bet by board texture (spot 1 of `shapedMove`). */
  texture?: boolean
  /** The board's own made hand discounted (`equityKeep`). */
  edge?: boolean
  /** Top pair or better committed at a low stack-to-pot ratio (spot 3). */
  spr?: boolean
  /** Draws raise a bet (spot 4). */
  drawRaise?: boolean
  /** Thin value on a checked river (spot 2). */
  thinValue?: boolean
}

const ALL_PARTS: Required<PostflopParts> = {
  texture: true,
  edge: true,
  spr: true,
  drawRaise: true,
  thinValue: true,
}

export interface PostflopRead {
  parts: PostflopParts
  texture: Texture
  hand: HandRead
  spr: number
  /** Multiplier on the AI's equity for a hand the board made for everybody. */
  equityKeep: number
}

/**
 * The shaped reads for the player to act, or null where they do not apply:
 * the switch off, preflop, and any game but Hold'em (the reads assume best
 * five of seven). Draws nothing from the rng.
 */
export function readPostflop(
  state: HandState,
  switched: boolean | PostflopParts | undefined,
): PostflopRead | null {
  if (!switched) return null
  const parts = switched === true ? ALL_PARTS : switched
  if (state.street === 'preflop' || state.variant !== 'holdem') return null
  const player = state.players[state.toActIndex]
  if (player?.hole.length !== 2 || state.community.length < 3) return null
  const hand = readHand(player.hole, state.community)
  const equityKeep = !parts.edge
    ? 1
    : hand.splitLocked
      ? 1
      : hand.playsBoard
        ? SHAPE.playsBoardKeep
        : hand.boardMade
          ? SHAPE.boardMadeKeep
          : 1
  return {
    parts,
    texture: texture(state.community),
    hand,
    spr: stackToPot(state, player.id),
    equityKeep,
  }
}

/**
 * A move the shaped postflop wants, with bets as a fraction of the pot for the
 * caller to size (`decideAction` owns sizing and the legal band).
 */
export type ShapedMove = { type: 'check' | 'call' | 'fold' } | { type: 'bet'; fraction: number }

export interface ShapedSpot {
  state: HandState
  read: PostflopRead
  legal: LegalActions
  /** The AI's equity, already corrected by `equityKeep` and its misread. */
  equity: number
  fairShare: number
  aggression: number
  skill: number
  posPressure: number
  memory?: TableMemory
  rng: Rng
}

/**
 * The spots the shaped postflop plays itself, or null to leave the hand to the
 * shipped policy:
 *
 * 1. The raiser's flop c-bet, by texture: most dry boards small, few wet ones
 *    without a hand or a draw, and value sized up on wet boards.
 * 2. A river checked to it with a hand a little better than a fair share and a
 *    private edge: a small thin value bet.
 * 3. Facing a flop bet committed by the stack-to-pot ratio with top pair or
 *    better: call at a share of the bare price, where the shipped gate adds
 *    taxes.
 * 4. Facing a bet on the flop or turn with a draw: raise it some of the time.
 */
export function shapedMove(spot: ShapedSpot): ShapedMove | null {
  const { state, read, legal, equity, fairShare, aggression, skill, posPressure, rng } = spot
  const player = state.players[state.toActIndex]
  const opponents = state.players.filter(
    (p) => p.id !== player.id && p.status !== 'folded' && p.status !== 'out',
  )
  const headsUp = opponents.length === 1
  const folds =
    1 +
    (opponents.reduce((sum, o) => sum + foldiness(spot.memory, o.id), 0) / opponents.length - 1) *
      skill
  const canBet = legal.canBet || legal.canRaise
  const valueSize = 0.55 + aggression * 0.25
  const { wetness } = read.texture
  const value = equity > fairShare * 1.24
  const { parts } = read

  if (legal.callAmount === 0) {
    // 1. The raiser's c-bet.
    if (
      parts.texture &&
      state.street === 'flop' &&
      canBet &&
      preflopAggressor(state) === player.id &&
      streetIsUnbet(state)
    ) {
      const scale =
        wetness < SHAPE.dry ? SHAPE.valueScaleDry : wetness > SHAPE.wet ? SHAPE.valueScaleWet : 1
      if (value) {
        return rng() < 0.35 + aggression * 0.55
          ? { type: 'bet', fraction: valueSize * scale }
          : null
      }
      const base =
        read.hand.outs >= SHAPE.semiRaiseOuts
          ? Math.max(SHAPE.cbetMid, 0.4 + aggression * 0.4)
          : wetness < SHAPE.dry
            ? SHAPE.cbetDry
            : wetness > SHAPE.wet
              ? SHAPE.cbetWet
              : SHAPE.cbetMid
      // The soft end of the ladder reads boards less, as with every line.
      const chance =
        base *
        (0.5 + 0.5 * skill) *
        (headsUp ? 1 : 0.5) *
        (1 - posPressure * 0.5) *
        Math.min(folds, 1.3)
      if (rng() < chance) {
        const size =
          wetness < SHAPE.dry ? SHAPE.cbetSizeDry : wetness > SHAPE.wet ? SHAPE.cbetSizeWet : 0.5
        return { type: 'bet', fraction: size }
      }
      return { type: 'check' }
    }

    // 2. River thin value.
    if (
      parts.thinValue &&
      state.street === 'river' &&
      canBet &&
      headsUp &&
      read.hand.edge > 0 &&
      !read.hand.playsBoard &&
      equity > fairShare * SHAPE.thinFloor &&
      !value &&
      rng() <
        (SHAPE.thinBase + aggression * SHAPE.thinPerAggression) * skill * (1 - posPressure * 0.4)
    ) {
      return { type: 'bet', fraction: SHAPE.thinSize }
    }
    return null
  }

  // 3. Committed by the stack-to-pot ratio.
  const self = player
  const share = self.committedThisHand / Math.max(self.committedThisHand + self.stack, 1)
  const committed = read.spr <= SHAPE.commitSpr || share >= SHAPE.commitShare
  // Committed means the price, not a premium on it: the shipped gate asks for
  // the pot odds plus taxes for tightness and position, which folds top pair
  // with most of a stack in. Here it asks for a share of the bare price.
  //
  // **Flop only.** The commitment is made by the stacks going into the flop.
  // A low ratio on the turn or river was made by the betting itself, and
  // against bets that honest a top pair calling down lost: measured over 2,000
  // Main Event deals, committing on every street cost 2.2 ± 2.1 bb/100.
  const potOdds = legal.callAmount / (potSize(state) + legal.callAmount)
  if (
    parts.spr &&
    state.street === 'flop' &&
    committed &&
    read.hand.topPair &&
    legal.canCall &&
    equity >= potOdds * SHAPE.commitOdds
  ) {
    return { type: 'call' }
  }

  // 4. A draw raises a bet.
  if (
    parts.drawRaise &&
    headsUp &&
    (state.street === 'flop' || state.street === 'turn') &&
    legal.canRaise &&
    read.hand.outs >= SHAPE.semiRaiseOuts &&
    !committed &&
    rng() <
      read.hand.outs *
        SHAPE.semiRaisePerOut *
        (0.5 + aggression) *
        skill *
        Math.min(folds, 1.3) *
        (state.street === 'turn' ? 0.6 : 1)
  ) {
    return { type: 'bet', fraction: SHAPE.semiRaiseSize }
  }
  return null
}
