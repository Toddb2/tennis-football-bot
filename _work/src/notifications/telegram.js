'use strict';

/**
 * telegram.js
 *
 * Telegram notifications for the tennis bot.
 *
 * Sends alerts on: bet placed, trade out, stop loss, system qualification, errors, startup.
 * Handles inbound commands: /status, /matches [system], /systems, /debug [name], /stop, /help
 *
 * All notification types and match-card fields are configurable via
 * strategies.json → telegramSettings (hot-reloaded without restart).
 *
 * Requires env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

const TelegramBot      = require('node-telegram-bot-api');
const logger           = require('../utils/logger');
const signalEngine     = require('../algorithm/signalEngine');
const systemEvaluator  = require('../algorithm/systemEvaluator');
const betRepo          = require('../database/betRepo');

// Default telegram settings — merged with strategies.json at runtime
const DEFAULT_SETTINGS = {
  notifyBetPlaced:    true,
  notifyTradeOut:     true,
  notifyStopLoss:     true,
  notifySystemMatch:  true,
  notifyLowLiquidity: false,
  notifyError:        true,
};

class TelegramNotifier {
  /**
   * @param {object} [opts]
   * @param {object} [opts.stateStore]    — StateStore instance
   * @param {object} [opts.orderManager] — OrderManager instance
   * @param {object} [opts.strategies]   — strategies.json config (hot-reloaded)
   */
  constructor(opts = {}) {
    this._stateStore   = opts.stateStore   || null;
    this._orderManager = opts.orderManager || null;
    this._strategies   = opts.strategies   || null;
    this._onStop       = opts.onStop       || null;

    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      logger.warn('TelegramNotifier: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — notifications disabled');
      this._enabled = false;
      this._bot     = null;
      this._chatId  = null;
      return;
    }

    this._enabled   = true;
    this._chatId    = chatId;
    this._bot       = new TelegramBot(token, { polling: false });
    this._msgQueue  = [];   // outbound message queue
    this._sending   = false; // drain lock
    logger.info('TelegramNotifier: initialised');
  }

  // ---------------------------------------------------------------------------
  // Settings helper
  // ---------------------------------------------------------------------------

  /** Resolve effective telegram settings, merging defaults with strategies.json. */
  _tgSettings() {
    const cfg = this._strategies?.telegramSettings || {};
    return { ...DEFAULT_SETTINGS, ...cfg };
  }

  // ---------------------------------------------------------------------------
  // Command listener
  // ---------------------------------------------------------------------------

  startCommandListener() {
    if (!this._enabled) return;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    this._bot   = new TelegramBot(token, { polling: true });

    this._bot.onText(/\/status/,      (msg)        => this._handleStatus(msg));
    this._bot.onText(/\/matches(.*)/, (msg, match) => this._handleMatches(msg, match[1]));
    this._bot.onText(/\/systems/,     (msg)        => this._handleSystems(msg));
    this._bot.onText(/\/debug (.+)/,  (msg, match) => this._handleDebug(msg, match[1]));
    this._bot.onText(/\/stop/,        (msg)        => this._handleStop(msg));
    this._bot.onText(/\/help/,        (msg)        => this._handleHelp(msg));

    this._bot.on('polling_error', (err) => {
      logger.error('TelegramNotifier: polling error', { message: err.message });
    });

    logger.info('TelegramNotifier: command listener started');
  }

  // ---------------------------------------------------------------------------
  // Internal send helper
  // ---------------------------------------------------------------------------

  /** Queue a message — drains at ≤2 msg/s to avoid Telegram 429 rate limits. */
  _send(text) {
    if (!this._enabled) return Promise.resolve();
    return new Promise(resolve => {
      this._msgQueue.push({ text, resolve });
      if (!this._sending) this._drainQueue();
    });
  }

  async _drainQueue() {
    this._sending = true;
    while (this._msgQueue.length) {
      const { text, resolve } = this._msgQueue.shift();
      try {
        await this._bot.sendMessage(this._chatId, text, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.error('TelegramNotifier: failed to send message', { message: err.message });
      }
      resolve();
      if (this._msgQueue.length) await new Promise(r => setTimeout(r, 500));
    }
    this._sending = false;
  }

  // ---------------------------------------------------------------------------
  // Outbound notifications
  // ---------------------------------------------------------------------------

  async notifyStartup() {
    const dryRun = process.env.DRY_RUN === 'true';
    await this._send(
      `🎾 *Bot online*${dryRun ? ' \\[DRY RUN\\]' : ''}\nStream connecting to Betfair…`
    );
  }

  async notifyShutdown(reason = 'SIGTERM') {
    if (!this._enabled) return;
    // On shutdown, drop any queued messages and send this one immediately so we
    // don't sit behind a long queue (500 ms/msg) and blow past PM2's kill_timeout.
    this._msgQueue.length = 0;
    try {
      await this._bot.sendMessage(
        this._chatId,
        `⏹ Tennis bot shutting down. Reason: ${reason}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error('TelegramNotifier: failed to send shutdown message', { message: err.message });
    }
  }

  async notifySystemMatch(matchState, system) {
    if (!this._tgSettings().notifySystemMatch) return;

    const { matchName, sets, currentServer, playerABack, playerBBack, edgeA, edgeB, matchedVolume } = matchState;
    const [nameA, nameB] = matchName.split(' v ').map(x => x.trim());
    const setStr  = (sets || []).map(x => `${x.playerA}-${x.playerB}`).join(' ') || '—';
    const server  = currentServer === 'playerA' ? nameA : currentServer === 'playerB' ? nameB : null;
    const fmtEdge = v => v != null ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : '—';
    const vol     = (matchedVolume == null || matchedVolume === 0) ? '—' : (matchedVolume / 1000).toFixed(matchedVolume < 1000 ? 1 : 0) + 'k';

    const msg =
      `🎯 *${system.systemName}* qualified\n` +
      `${matchName}\n` +
      `Score: ${setStr}${server ? `  ·  ${server} serving` : ''}\n` +
      `Odds: ${playerABack?.toFixed(2) ?? '—'} / ${playerBBack?.toFixed(2) ?? '—'}  ·  Vol: ${vol}\n` +
      `Edge: ${fmtEdge(edgeA)} / ${fmtEdge(edgeB)}  ·  Stake: £${system.staking?.stakeGBP ?? '—'}`;

    await this._send(msg);
  }

  async notifyBetPlaced({ matchName, player, playerKey, side, odds, stake, liability, sizeMatched, averagePriceMatched, edgePercent, momentumIndex, system, betId, dryRun }) {
    if (!this._tgSettings().notifyBetPlaced) return;
    const sideLabel   = side === 'LAY' ? 'LAY' : 'BACK';
    const matchedAt   = averagePriceMatched != null && Math.abs(averagePriceMatched - odds) > 0.01
      ? ` \\(avg ${averagePriceMatched.toFixed(2)}\\)` : '';
    const partialNote = sizeMatched != null && Math.abs(sizeMatched - stake) > 0.01
      ? `  ⚠️ £${sizeMatched.toFixed(2)} matched` : '';

    // Sub-strategy tag — if the system name already encodes side (Strat7_P1)
    // use it; else append -P1/-P2 derived from playerKey.
    const subTag = system && playerKey
      ? (/_P[12]$/.test(system) ? system : `${system}-${playerKey === 'A' ? 'P1' : 'P2'}`)
      : (system || '');

    // Momentum at bet, signed for the bet player (positive = bet player has momentum).
    // matchState.momentumIndex is A-perspective, so flip for P2 bets.
    const momForBet = (typeof momentumIndex === 'number')
      ? (playerKey === 'B' ? -momentumIndex : momentumIndex)
      : null;
    const momStr = (momForBet != null) ? `  |  Mom: ${momForBet >= 0 ? '+' : ''}${momForBet.toFixed(0)}` : '';

    // Liability — show alongside stake for lay bets where they differ
    const liabStr = (liability != null && Math.abs(liability - stake) > 0.01)
      ? `  |  Liab £${liability.toFixed(2)}` : '';

    // Edge in pp to match dashboard convention
    const edgeStr = edgePercent != null
      ? (edgePercent >= 0 ? '+' : '') + edgePercent.toFixed(1) + ' pp' : '—';

    await this._send(
      `✅ *BET${dryRun ? ' \\[DRY\\]' : ''} — ${sideLabel} ${player} @ ${odds}${matchedAt}*\n` +
      `${matchName}\n` +
      `${subTag ? subTag + '  |  ' : ''}£${stake.toFixed(2)}${liabStr}${partialNote}\n` +
      `Edge: ${edgeStr}${momStr}`
    );
  }

  async notifyTradeOut({ matchName, profit, reason, system, playerKey, hedgeOdds, entryOdds }) {
    if (!this._tgSettings().notifyTradeOut) return;
    const sign = profit >= 0 ? '+' : '';
    const subTag = system && playerKey
      ? (/_P[12]$/.test(system) ? system : `${system}-${playerKey === 'A' ? 'P1' : 'P2'}`)
      : (system || '');
    const hedgeLine = (entryOdds != null && hedgeOdds != null)
      ? `\nHedge: ${entryOdds.toFixed(2)} → ${hedgeOdds.toFixed(2)}` : '';
    await this._send(
      `📤 *TRADE OUT — ${matchName}*\n` +
      (subTag ? `${subTag}  |  ` : '') +
      `${sign}£${profit.toFixed(2)}  |  ${reason}` +
      hedgeLine
    );
  }

  async notifyStopLoss({ matchName, loss }) {
    if (!this._tgSettings().notifyStopLoss) return;
    await this._send(
      `🛑 *STOP LOSS — ${matchName}*\n` +
      `-£${loss.toFixed(2)}`
    );
  }

  async notifyLowLiquidity({ matchName, volume }) {
    if (!this._tgSettings().notifyLowLiquidity) return;
    await this._send(
      `⚠️ *${matchName}* — vol too low (${volume.toLocaleString()})`
    );
  }

  _esc(text) {
    return String(text ?? '').replace(/[*_`[\]]/g, '\\$&');
  }

  async notifyError(err) {
    if (!this._tgSettings().notifyError) return;
    const message = err instanceof Error ? err.message : String(err);
    await this._send(`❌ *ERROR:* ${this._esc(message)}`);
  }

  // ---------------------------------------------------------------------------
  // Inbound command handlers
  // ---------------------------------------------------------------------------

  async _handleStatus(msg) {
    logger.info('TelegramNotifier: /status requested', { from: msg.from?.username });
    let text;
    try {
      const summary    = this._stateStore?.summary()            ?? null;
      // PnL today from the DB (settled bets where DATE(settled_at)=today UTC).
      // Survives pm2 restarts — orderManager's in-memory settledOrders resets on restart.
      const today      = betRepo.getPnlToday();
      const pnlToday   = today?.pnl   ?? null;
      const betsToday  = today?.bets  ?? 0;
      const exposure   = this._orderManager?.getTotalExposure()  ?? null;
      const matched    = this._orderManager?.getMatchedToday()  ?? null;
      const openPos    = this._orderManager?.openOrders.size    ?? '?';

      text =
        `🎾 *Tennis Bot Status*\n` +
        `Open positions: ${openPos}\n` +
        `Total exposure: £${exposure != null ? exposure.toFixed(2) : '?'}\n` +
        `Matched today: £${matched   != null ? matched.toFixed(2)  : '?'}\n` +
        `P&L today: £${pnlToday != null ? (pnlToday >= 0 ? '+' : '') + pnlToday.toFixed(2) : '?'} (${betsToday} bet${betsToday === 1 ? '' : 's'} settled)\n` +
        `Markets monitored: ${summary ? summary.activeMatches : '?'}`;
    } catch (err) {
      logger.error('TelegramNotifier: error building /status reply', { message: err.message });
      text = '❌ Could not retrieve status.';
    }
    await this._replyTo(msg, text);
  }

  async _handleDebug(msg, matchName) {
    logger.info('TelegramNotifier: /debug requested', { matchName, from: msg.from?.username });
    if (!this._stateStore) { await this._replyTo(msg, '❌ StateStore not available.'); return; }

    const target = this._stateStore.getAll().find(m =>
      m.matchName.toLowerCase().includes(matchName.trim().toLowerCase())
    );

    if (!target) {
      await this._replyTo(msg, `❌ No active match found matching "*${matchName}*".`);
      return;
    }

    const snapshot = JSON.stringify(target.toSnapshot(), null, 2);
    const MAX = 3900;
    const body = snapshot.length > MAX ? snapshot.slice(0, MAX) + '\n… (truncated)' : snapshot;
    await this._replyTo(msg, `\`\`\`\n${body}\n\`\`\``);
  }

  async _handleMatches(msg, rawArg) {
    const systemFilter = (rawArg || '').trim();
    logger.info('TelegramNotifier: /matches requested', { from: msg.from?.username, systemFilter: systemFilter || 'all' });

    if (!this._stateStore) { await this._replyTo(msg, '❌ StateStore not available.'); return; }

    const allLive = this._stateStore.getAll().filter(m => m.isInPlay && m.status === 'LIVE');
    if (!allLive.length) { await this._replyTo(msg, '🎾 No live matches currently being tracked.'); return; }

    let liveMatches = allLive;
    let headerLabel = 'Live Matches';

    if (systemFilter) {
      const systems = this._strategies?.systems || [];
      const system  = systems.find(s => s.name.toLowerCase() === systemFilter.toLowerCase());
      if (!system) {
        const names = systems.map(s => s.name).join(', ');
        await this._replyTo(msg, `❌ System "*${systemFilter}*" not found.\nAvailable: ${names}`);
        return;
      }
      liveMatches = allLive.filter(m =>
        systemEvaluator.evaluateSystems(m, [system], this._strategies || {}).length > 0
      );
      headerLabel = `${system.name} — ${system.description}`;
      if (!liveMatches.length) {
        await this._replyTo(msg, `🎾 *${system.name}*\n_${system.description}_\n\nNo live matches currently qualify.`);
        return;
      }
    }

    const openMarkets = this._orderManager
      ? new Set([...this._orderManager.openOrders.values()].map(o => o.marketId))
      : new Set();
    const cfg = { ...(this._strategies?.signalEngine || {}), probabilityModel: this._strategies?.probabilityModel };

    const cards   = liveMatches.map(m => this._formatMatchCard(m, openMarkets, cfg));
    const LIMIT   = 3800;
    const BATCH   = 5;
    const batches = [];
    for (let i = 0; i < cards.length; i += BATCH) batches.push(cards.slice(i, i + BATCH));

    for (let i = 0; i < batches.length; i++) {
      const pageLabel  = batches.length > 1 ? ` (${i + 1}/${batches.length})` : '';
      const countLabel = i === 0 ? (systemFilter ? ` — ${liveMatches.length} of ${allLive.length}` : ` — ${liveMatches.length}`) : '';
      const header = `🎾 *${headerLabel}${countLabel}${pageLabel}*\n\n`;
      let body = batches[i].join('\n\n─────────────────\n\n');
      if (header.length + body.length > LIMIT) body = body.slice(0, LIMIT - header.length) + '\n…(truncated)';
      await this._replyTo(msg, header + body);
    }
  }

  _formatMatchCard(matchState, openMarkets, cfg) {
    const {
      betfairMarketId, matchName,
      sets, currentGame, surface, currentServer,
      liveServeStats, liveServeStatsSet1,
      breakPoints, breakPointsSet1,
      trueProbabilityA, trueProbabilityB,
      playerABack, playerBBack, edgeA, edgeB,
    } = matchState;

    const [nameA, nameB] = matchName.split(' v ').map(s => s.trim());

    const setStr  = (sets || []).map(s => `${s.playerA}-${s.playerB}`).join(' ');
    const gameStr = currentGame ? `(${currentGame.playerA}-${currentGame.playerB})` : '';
    const score   = [setStr, gameStr].filter(Boolean).join(' ') || '—';
    const server  = currentServer === 'playerA' ? `🎾 ${nameA}`
                  : currentServer === 'playerB' ? `🎾 ${nameB}` : '—';
    const surf    = surface ? surface[0].toUpperCase() + surface.slice(1) : '—';
    const fmtEdge = v => v != null ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : '—';
    const p       = v => v != null ? v.toFixed(0) + '%' : '—';

    let lines = [
      `*${matchName}*`,
      `Score: ${score}  ·  ${server}`,
      `Surface: ${surf}`,
      `Odds: ${playerABack?.toFixed(2) ?? '—'} / ${playerBBack?.toFixed(2) ?? '—'}`,
    ];

    if (trueProbabilityA != null) {
      lines.push(`True Prob: ${(trueProbabilityA * 100).toFixed(1)}% / ${(trueProbabilityB * 100).toFixed(1)}%`);
    }
    lines.push(`Edge: ${fmtEdge(edgeA)} / ${fmtEdge(edgeB)}`);

    const s1A = liveServeStatsSet1?.playerA;
    const s1B = liveServeStatsSet1?.playerB;
    const hasSet1 = s1A?.firstServeIn != null || s1A?.firstServeWon != null ||
                    s1B?.firstServeIn != null || s1B?.firstServeWon != null;
    const ssA = hasSet1 ? s1A : (liveServeStats?.playerA || {});
    const ssB = hasSet1 ? s1B : (liveServeStats?.playerB || {});
    const statsLabel = hasSet1 ? 'Set 1' : 'Match';
    if (ssA?.firstServeIn != null || ssA?.firstServeWon != null ||
        ssB?.firstServeIn != null || ssB?.firstServeWon != null) {
      lines.push(
        `${statsLabel} 1st In: ${p(ssA.firstServeIn)} / ${p(ssB.firstServeIn)}  ·  ` +
        `1st Won: ${p(ssA.firstServeWon)} / ${p(ssB.firstServeWon)}`
      );
      lines.push(
        `${statsLabel} 2nd Won: ${p(ssA.secondServeWon)} / ${p(ssB.secondServeWon)}  ·  ` +
        `DFs: ${ssA.doubleFaults ?? '—'} / ${ssB.doubleFaults ?? '—'}`
      );
    }

    const s1Bp = breakPointsSet1;
    const bpSrc   = (s1Bp?.playerA?.created || s1Bp?.playerB?.created) ? s1Bp : breakPoints;
    const bpLabel = bpSrc === s1Bp ? 'Set 1 BPs' : 'Break pts';
    const bpA = bpSrc?.playerA;
    const bpB = bpSrc?.playerB;
    if (bpA?.created || bpB?.created) {
      const fmtBp = b => b ? `${b.converted}/${b.created}` : '0/0';
      lines.push(`${bpLabel}: ${nameA} ${fmtBp(bpA)}  ·  ${nameB} ${fmtBp(bpB)}`);
    }

    try {
      const qualifying = systemEvaluator.evaluateSystems(
        matchState, this._strategies?.systems || [], this._strategies || {}
      );
      lines.push(qualifying.length > 0
        ? `System: ✅ ${qualifying[0].systemName} — ${qualifying[0].description}`
        : `System: ❌ No system matched`
      );
    } catch (_) {}

    let signal = 'UNKNOWN';
    try {
      const order = this._orderManager?.getOpenPositionForMarket(betfairMarketId) || null;
      const openPosition = order
        ? { side: order.playerKey || 'A', stake: order.stake, currentPnL: null }
        : null;
      const decision = signalEngine.evaluate(matchState, { openMarkets, openPosition, config: cfg });
      signal = decision.action;
    } catch (_) {}
    const emoji = signal === 'HOLD' ? '⏸' : signal === 'TRADE_OUT' ? '📤' : signal.startsWith('BET') ? '✅' : '❓';
    lines.push(`Signal: ${emoji} *${signal}*`);

    return lines.join('\n');
  }

  async _handleSystems(msg) {
    logger.info('TelegramNotifier: /systems requested', { from: msg.from?.username });
    const systems = this._strategies?.systems;
    if (!Array.isArray(systems) || systems.length === 0) {
      await this._replyTo(msg, '⚙️ No systems configured. Check config/strategies.json.');
      return;
    }

    const lines = ['⚙️ *Configured Systems*\n'];
    for (const sys of systems) {
      const icon   = sys.enabled ? '✅' : '❌';
      const status = sys.enabled ? 'ENABLED' : 'DISABLED';
      const f      = sys.filters || {};
      const parts  = [];

      if (f.surfaces?.length)           parts.push(f.surfaces.map(s => s[0].toUpperCase() + s.slice(1)).join('/'));
      if (f.minEdgePercent)             parts.push(`Edge ≥${f.minEdgePercent}%`);
      if (f.minOddsToBack != null)      parts.push(`Odds ${f.minOddsToBack}–${f.maxOddsToBack ?? '∞'}`);
      if (f.minMatchedVolume)           parts.push(`Vol ≥${(f.minMatchedVolume / 1000).toFixed(0)}k`);
      if (f.requireBreakInCurrentSet)   parts.push('Break req.');
      if (f.onlyBackFavourite)          parts.push('Fav only');
      if (f.onlyBackUnderdog)           parts.push('Dog only');
      if (f.minFirstServeWinPct)        parts.push(`1st srv ≥${f.minFirstServeWinPct}%`);
      if (f.minFirstServeInPct)         parts.push(`1st in ≥${f.minFirstServeInPct}%`);
      if (f.maxDoubleFaults != null)    parts.push(`DFs ≤${f.maxDoubleFaults}`);
      if (f.minTrueProbabilityBacked)   parts.push(`Prob ≥${f.minTrueProbabilityBacked}%`);
      if (f.allowedTournamentTiers?.length) parts.push(f.allowedTournamentTiers.join('/'));
      if (f.blockedTournaments?.length) parts.push(`Block: ${f.blockedTournaments.join(',')}`);
      if (f.minGamesPlayedInMatch)      parts.push(`≥${f.minGamesPlayedInMatch} games`);

      const s = sys.staking || {};
      lines.push(
        `${icon} *${sys.name}* — ${status}\n` +
        `_${sys.description}_\n` +
        `Filters: ${parts.join(' · ') || 'none'}\n` +
        `Stake: £${s.stakeGBP ?? '—'} / bet\n`
      );
    }

    // Show telegram settings summary
    const ts = this._tgSettings();
    const notifs = Object.entries({
      'Bet placed': ts.notifyBetPlaced, 'Trade out': ts.notifyTradeOut,
      'Stop loss': ts.notifyStopLoss,  'Sys match': ts.notifySystemMatch,
      'Low vol': ts.notifyLowLiquidity, 'Errors': ts.notifyError,
    }).map(([k, v]) => `${v ? '✅' : '❌'} ${k}`).join('  ');
    lines.push(`\n📱 *Notifications:* ${notifs}`);

    await this._replyTo(msg, lines.join('\n'));
  }

  async _handleHelp(msg) {
    logger.info('TelegramNotifier: /help requested', { from: msg.from?.username });
    await this._replyTo(msg,
      `🎾 *Tennis Bot Commands*\n\n` +
      `/status — Open positions, exposure & P&L today\n` +
      `/matches — All live matches with edge & stats\n` +
      `/matches SystemName — Matches qualifying for a specific system\n` +
      `/systems — All configured betting systems and notification settings\n` +
      `/debug MatchName — Full raw state dump for a match\n` +
      `/stop — Gracefully shut down the bot\n` +
      `/help — Show this message`
    );
  }

  async _handleStop(msg) {
    logger.info('TelegramNotifier: /stop requested', { from: msg.from?.username });
    if (!this._onStop) { await this._replyTo(msg, '❌ Stop handler not configured.'); return; }
    await this._replyTo(msg, '⏹ Shutdown initiated. The bot will stop gracefully.');
    this._onStop();
  }

  async _replyTo(msg, text) {
    if (!this._enabled) return;
    try {
      await this._bot.sendMessage(msg.chat.id, text, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id,
      });
    } catch (err) {
      logger.error('TelegramNotifier: failed to send reply', { message: err.message });
    }
  }
}

module.exports = TelegramNotifier;
