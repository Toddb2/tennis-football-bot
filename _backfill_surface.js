// Investigate + back-fill missing markets.surface using:
//   1. Tournament-name → surface lookup (curated)
//   2. Snapshot data if surface is stored anywhere there
const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db');

// Curated mapping of common tour stops → primary surface
const SURFACE_BY_TOURNAMENT = {
  // Clay
  'french open': 'clay', 'roland garros': 'clay', 'rome': 'clay', 'madrid': 'clay',
  'monte carlo': 'clay', 'monte-carlo': 'clay', 'barcelona': 'clay', 'hamburg': 'clay',
  'estoril': 'clay', 'munich': 'clay', 'geneva': 'clay', 'lyon': 'clay', 'strasbourg': 'clay',
  'rabat': 'clay', 'bogota': 'clay', 'rio': 'clay', 'rio de janeiro': 'clay', 'buenos aires': 'clay',
  'santiago': 'clay', 'cordoba': 'clay', 'houston': 'clay', 'umag': 'clay', 'gstaad': 'clay',
  'bastad': 'clay', 'bĺstad': 'clay', 'kitzbuhel': 'clay', 'kitzbühel': 'clay', 'palermo': 'clay',
  'parma': 'clay', 'cagliari': 'clay', 'belgrade': 'clay', 'marrakech': 'clay', 'tenerife': 'clay',
  'prague': 'clay', 'iasi': 'clay', 'bucharest': 'clay', 'warsaw': 'clay', 'wsm cup': 'clay',
  // Hard
  'australian open': 'hard', 'us open': 'hard', 'miami': 'hard', 'indian wells': 'hard',
  'cincinnati': 'hard', 'canada open': 'hard', 'canadian open': 'hard', 'toronto': 'hard',
  'montreal': 'hard', 'washington': 'hard', 'beijing': 'hard', 'shanghai': 'hard', 'tokyo': 'hard',
  'paris masters': 'hard', 'paris bercy': 'hard', 'rotterdam': 'hard', 'doha': 'hard',
  'dubai': 'hard', 'acapulco': 'hard', 'rio melbourne': 'hard',
  'chengdu': 'hard', 'zhuhai': 'hard', 'shenzhen': 'hard', 'guangzhou': 'hard', 'astana': 'hard',
  'metz': 'hard', 'antwerp': 'hard', 'vienna': 'hard', 'basel': 'hard', 'stockholm': 'hard',
  'gijon': 'hard', 'sofia': 'hard', 'marseille': 'hard', 'montpellier': 'hard', 'pune': 'hard',
  'auckland': 'hard', 'adelaide': 'hard', 'sydney': 'hard', 'brisbane': 'hard',
  'delray beach': 'hard', 'memphis': 'hard', 'san diego': 'hard', 'newport beach': 'hard',
  'almaty': 'hard', 'antalya': 'hard', 'bangkok': 'hard', 'macau': 'hard',
  // Grass
  'wimbledon': 'grass', 'queen': 'grass', "queen's": 'grass', 'halle': 'grass', 'eastbourne': 'grass',
  'stuttgart': 'grass', "'s-hertogenbosch": 'grass', 'hertogenbosch': 'grass', 'newport': 'grass',
  'mallorca': 'grass', 'antalya open': 'grass',
  // Challenger / lower-tier additions (most common on the clay swing window of this dataset)
  'wuxi': 'hard', 'santos': 'clay', 'brazzaville': 'clay', 'francavilla': 'clay',
  'bengaluru': 'hard', 'zagreb': 'clay', 'oeiras': 'clay', 'valencia': 'clay',
  'cassis': 'clay', 'savannah': 'clay', 'shymkent': 'clay', 'mauthausen': 'clay',
  'aix-en-provence': 'clay', 'aix en provence': 'clay', 'tunis': 'clay', 'taipei': 'hard',
  'maia': 'clay', 'cherbourg': 'hard', 'biella': 'hard', 'tenerife': 'hard',
  'turin': 'hard', 'koblenz': 'hard', 'nottingham': 'grass', 'surbiton': 'grass',
  'ilkley': 'grass', 'birmingham': 'grass',
};

function inferSurface(tournament) {
  if (!tournament) return null;
  const t = tournament.toLowerCase();
  // Exact match first
  if (SURFACE_BY_TOURNAMENT[t]) return SURFACE_BY_TOURNAMENT[t];
  // Substring match
  for (const [key, surf] of Object.entries(SURFACE_BY_TOURNAMENT)) {
    if (t.includes(key)) return surf;
  }
  return null;
}

console.log('═══ Markets missing surface (recent bet activity) ═══');
const nullSurfaceMarkets = db.prepare(`
  SELECT m.betfair_market_id, m.match_name, m.tournament, m.surface,
         COUNT(b.bet_id) AS bet_count
  FROM markets m
  LEFT JOIN bets b ON m.betfair_market_id = b.betfair_market_id
  WHERE m.surface IS NULL
  GROUP BY m.betfair_market_id
  ORDER BY bet_count DESC, m.went_in_play_at DESC NULLS LAST
  LIMIT 30
`).all();

console.log(`Found ${nullSurfaceMarkets.length} markets without surface (showing top 30):`);
for (const m of nullSurfaceMarkets) {
  const inferred = inferSurface(m.tournament);
  console.log(`  ${m.betfair_market_id}  bets=${m.bet_count}  tournament="${m.tournament}"  inferred=${inferred || '?'}`);
}

console.log('\n═══ Applying tournament-based surface backfill ═══');
const allNullSurface = db.prepare(`SELECT betfair_market_id, tournament FROM markets WHERE surface IS NULL AND tournament IS NOT NULL`).all();
const updateStmt = db.prepare(`UPDATE markets SET surface = ? WHERE betfair_market_id = ?`);
let fixed = 0, stillNull = 0;
const unknownTournaments = new Set();
const tx = db.transaction(() => {
  for (const m of allNullSurface) {
    const surf = inferSurface(m.tournament);
    if (surf) {
      updateStmt.run(surf, m.betfair_market_id);
      fixed++;
    } else {
      stillNull++;
      unknownTournaments.add(m.tournament);
    }
  }
});
tx();
console.log(`  Markets given surface from tournament name: ${fixed}`);
console.log(`  Markets still null (tournament unmapped):   ${stillNull}`);
if (unknownTournaments.size) {
  console.log('\n  Unmapped tournaments (sample 15):');
  [...unknownTournaments].slice(0, 15).forEach(t => console.log(`    "${t}"`));
}

// Also: markets with null tournament AND null surface — nothing to infer from.
const noMeta = db.prepare(`SELECT COUNT(*) AS n FROM markets WHERE surface IS NULL AND tournament IS NULL`).get();
console.log(`\n  Markets with NO surface and NO tournament: ${noMeta.n}`);

console.log('\n═══ Updated coverage ═══');
const after = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN m.surface IS NOT NULL THEN 1 ELSE 0 END) AS with_surface
  FROM bets b LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
`).get();
console.log(`  Bets with surface populated: ${after.with_surface}/${after.total} (${(after.with_surface/after.total*100).toFixed(1)}%)`);
