// Probe-and-grind for the pump.fun bonding-curve replay.
//
// Idea (from the dev data): the coins that run to completion do not spike and dump — they grind
// up steadily over hundreds of slots after a strong launch. Their launches look alike in the
// create slot (5–30 SOL bought, several distinct buyers, 5–50 SOL of real reserve), and they
// keep absorbing net buying afterwards (net flow over the first 50 slots is 13–43 SOL, vs a
// 6.6 SOL median for lookalikes). The rest bleed slowly. So: buy every strong launch with a
// tiny probe, scale into the ones that keep rising (add on each +addStep step while net flow
// stays positive), and let the trailing stop ride the grind — never a tight stop, because even
// the winners dip 10–20% early. Losers are cut by a fade exit once they stop rising.
//
// Entry: on the create-slot batch, a coin qualifies when the create slot bought
// [launchBuyMin, launchBuyMax] SOL, had at least launchBuyers distinct buyers, ended the slot
// with real SOL in [launchRqMin, launchRqMax], and the creator did not sell in it. The probe is
// probeSol; adds of addSol follow while the price steps up, up to stakeSol total.
//
// Exit: trailing stop once armed, fade exit (old and underwater with negative recent flow),
// a probe cut for positions that never scaled (old and underwater), or max hold. The harness
// closes a position when its curve completes.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Create-slot launch filter. */
  launchBuyMin: number;
  launchBuyMax: number;
  launchBuyers: number;
  launchRqMin: number;
  launchRqMax: number;
  /** Skip the probe when the create slot already sold this much SOL. */
  launchSellMax: number;
  /** Buy the probe at most this many slots after creation. */
  probeAge: number;
  /** Probe size and scale-in. */
  probeSol: number;
  stakeSol: number;
  addSol: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while net SOL over the flow window is at least this. */
  addFlowSol: number;
  flowWindow: number;
  /** Exits. */
  trailArm: number;
  trail: number;
  /** Fade exit: after this many slots held, exit when underwater by this much and flow negative. */
  fadeAge: number;
  fadeLoss: number;
  fadeFlowSol: number;
  /** Probe cut: a position that never scaled out exits after this many slots when underwater. */
  cutAge: number;
  cutLoss: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnCreatorSell: boolean;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Most positions open at once. */
  maxOpen: number;
}

export const DEFAULT_PARAMS: Params = {
  launchBuyMin: 5,
  launchBuyMax: 20,
  launchBuyers: 5,
  launchRqMin: 5,
  launchRqMax: 50,
  launchSellMax: 0.5,
  probeAge: 3,
  probeSol: 0.01,
  stakeSol: 0.5,
  addSol: 0.05,
  addStep: 0.4,
  addFlowSol: 0.5,
  flowWindow: 30,
  trailArm: 0.05,
  trail: 0.25,
  fadeAge: 200,
  fadeLoss: 0.15,
  fadeFlowSol: 0,
  cutAge: 50,
  cutLoss: 0.1,
  maxHold: 1000,
  exitOnCreatorSell: false,
  buySlipBps: 5000,
  maxOpen: 5,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  creatorSold: boolean;
  /** Create-slot aggregates (SOL). */
  csBuy: number;
  csSell: number;
  csBuyers: Set<string>;
  csRq: number;
  trades: Trade[];
  probed: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const keep = Math.max(p.flowWindow, 60) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        creator: null,
        creatorSold: false,
        csBuy: 0,
        csSell: 0,
        csBuyers: new Set(),
        csRq: 0,
        trades: [],
        probed: false,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.user;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          if (!e.is_buy && t.creator !== null && e.user === t.creator) t.creatorSold = true;
          if (t.created !== null && e.slot === t.created) {
            if (e.is_buy) {
              t.csBuy += sol;
              t.csBuyers.add(e.user);
            } else t.csSell += sol;
            t.csRq = Number(e.real_quote_reserves) / LAMPORTS;
          }
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.fadeAge && value < cost * (1 - p.fadeLoss) && flow(t, now, p.flowWindow) < p.fadeFlowSol) exit = true;
        if (!exit && h.invested <= p.probeSol + 0.001 && now - h.opened > p.cutAge && value < cost * (1 - p.cutLoss)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnCreatorSell && t.creatorSold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probes and scale-ins.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = Math.min(p.maxOpen, state.hello.caps.max_open_positions) - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          // Probe: only on (or just after) the create slot, and only a qualifying launch.
          if (t.probed || t.created === null || now - t.created > p.probeAge) continue;
          if (slotsLeft <= 0) continue;
          if (t.csBuy < p.launchBuyMin || t.csBuy > p.launchBuyMax) continue;
          if (t.csBuyers.size < p.launchBuyers) continue;
          if (t.csRq < p.launchRqMin || t.csRq > p.launchRqMax) continue;
          if (t.csSell > p.launchSellMax) continue;
          if (t.creatorSold) continue;
          want = p.probeSol;
        } else {
          // Scale in only while the price steps up and net flow stays positive.
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - 0.005) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(t, now, p.flowWindow) < p.addFlowSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, want);
        if (amount > free - tx) amount = free - tx;
        if (amount < 0.01) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        if (h === undefined) {
          t.probed = true;
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastValue: 0 });
          slotsLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }
      return orders;
    },
  };
}
