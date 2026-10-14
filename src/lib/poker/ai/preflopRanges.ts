// Ranges for re-raises before the flop, under the `preflopRanges` experiment.
//
// The shipped AI reads a raiser through `aiSelectivity`: the best of a handful
// of random holdings, at most five extra, which is about the top fifth of hands
// however many raises came before. A real 3-bet range is a few percent of
// hands, so an opener's hand always had the equity to call one, and at The
// Main Event the opener folded to a 3-bet 4 times in 3,450 (`pnpm bot-duel`).
// Here a raise is read as a percentile range instead: the opener's by where it
// opened from, each re-raise a slice of the range it answers (Loki/Poki's
// "re-weight by the action" idea, reduced to one number per level).

import { OPENING, PREFLOP_RANGES } from '@/config/aiGates'
import type { HandState } from '../engine'
import { lineOf } from './line'
import { credibility, type TableMemory } from './memory'

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/** The preflop raises so far, in order: who made each and what it was to. */
export function preflopRaises(state: HandState): { playerId: string; to: number }[] {
  return lineOf(state)
    .filter((a) => a.street === 'preflop' && a.type === 'raise')
    .map((a) => ({ playerId: a.playerId, to: a.to }))
}

/**
 * The share of hands a regular opens from where this hand was opened, read
 * off how many players were still to act behind the open. `OPENING`'s base
 * shares, not the AI's own tightened ones: an opener can be anybody.
 */
export function openShare(state: HandState): number {
  const preflop = lineOf(state).filter((a) => a.street === 'preflop')
  const open = preflop.findIndex((a) => a.type === 'raise')
  if (open < 0) return OPENING.shareByBehind[0]
  const dealt = state.players.filter((p) => p.status !== 'out').length
  const behind = Math.max(1, dealt - (open + 1))
  const shares = OPENING.shareByBehind
  return shares[Math.min(behind, shares.length - 1)]
}

/**
 * The range a raise at `level` represents (1 the open, 2 the 3-bet, 3 the
 * 4-bet...), as a share of all starting hands.
 */
export function levelShare(level: number, open: number): number {
  if (level <= 1) return open
  const threeBet = clamp(
    open * PREFLOP_RANGES.threeBetOfOpen + PREFLOP_RANGES.threeBetFloor,
    PREFLOP_RANGES.floor,
    PREFLOP_RANGES.threeBetMax,
  )
  let share = threeBet
  for (let l = 3; l <= level; l++) share *= PREFLOP_RANGES.fourBetOf3Bet
  return Math.max(share, PREFLOP_RANGES.floor)
}

/**
 * Each opponent's range as a top share of hands, by the highest raise they
 * made or called. Undefined for one who has only posted a blind or limped: the
 * selectivity read stands for them. A raise from somebody the table has seen
 * raise everything is read wider, by as much as their raises have meant less
 * (`credibility`), and that read moves with skill as `aiSelectivity`'s does.
 */
export function opponentShares(
  state: HandState,
  opponents: HandState['players'],
  memory: TableMemory | undefined,
  skill: number,
): (number | undefined)[] {
  const raises = preflopRaises(state)
  const open = openShare(state)
  return opponents.map((opp) => {
    let level = 0
    for (let i = 0; i < raises.length; i++) {
      if (opp.committedThisStreet >= raises[i].to) level = i + 1
    }
    if (level === 0) return undefined
    const read = 1 + (credibility(memory, opp.id, true) - 1) * skill
    return clamp(levelShare(level, open) / read, PREFLOP_RANGES.floor, PREFLOP_RANGES.widest)
  })
}
