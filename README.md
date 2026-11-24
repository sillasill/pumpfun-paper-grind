# pumpfun-paper-grind

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/sillasill/pumpfun-paper-grind/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/sillasill/pumpfun-paper-grind/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Probe-and-grind paper trading bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty ($2 in USDC). It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity.

## Strategy

Most new pump.fun coins bleed slowly after launch; a few grind up steadily for hundreds of slots and run to completion (~5–14x). The bot buys every strong launch with a tiny 0.02 SOL probe, then scales into the ones that keep rising and lets a trailing stop ride the grind:

- **Probe:** on a coin's create slot, buy 0.02 SOL when the slot bought 5–20 SOL, had at least 5 distinct buyers, ended with 5–50 SOL of real reserve, sold at most 0.5 SOL, and the creator did not sell.
- **Scale-in:** add 0.05 SOL each time the price steps up 40% from the last buy while net flow stays positive, up to 0.5 SOL per coin.
- **Exit:** trailing stop (arms at +5%, 25% give-back), a probe cut (unscaled positions exit after 50 slots when down 10%), a fade exit (old, underwater, negative flow), or a 1000-slot max hold. The harness closes positions when a curve completes.

Deterministic: no clock, no randomness, no network, standard library only (Node 22 TypeScript, run through the kit's vendored `agentfun-bot.ts` shim).

## Dev backtest

On the kit's frozen 24h dev window (grade-local, process driver): **net PnL +0.275 SOL** (+2.7% on 10 SOL), 143 round trips over 143 coins, win rate 9.1%, max drawdown 4.5%, 0 rejected orders, guardrails met. Still positive at 2x fees (+0.131 SOL). For comparison the house pilot bots on the same window: sniper −0.475 SOL, reversion −4.0 SOL, momentum −9.4 SOL.

The profit is concentrated: 3 coins made 91% of the gains, so the final 24h window — a different day of launches — can land either side of zero. The bot is built to lose little on the other ~140 probes and to be fully sized when a runner appears.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=bfyeqrq3&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>

---
