'use strict';

// Direct surface keywords returned by upstream APIs.
const SURFACE_MAP = {
  clay:   'clay',
  hard:   'hard',
  grass:  'grass',
  carpet: 'carpet',
  indoor: 'hard',
  'hard indoor':  'hard',
  'hard outdoor': 'hard',
  'clay indoor':  'clay',
};

// Tournament / venue name substring → surface. Lower-case keys.
const TOURNAMENT_SURFACE_MAP = [
  // ── Hard ──
  ['australian open','hard'], ['us open','hard'], ['miami','hard'],
  ['indian wells','hard'], ['cincinnati','hard'], ['toronto','hard'],
  ['montreal','hard'], ['canada open','hard'], ['canadian open','hard'],
  ['dubai','hard'], ['doha','hard'], ['rotterdam','hard'], ['marseille','hard'],
  ['beijing','hard'], ['tokyo','hard'], ['shanghai','hard'], ['acapulco','hard'],
  ['delray beach','hard'], ['dallas','hard'], ['san diego','hard'],
  ['washington','hard'], ['citi open','hard'], ['winston-salem','hard'],
  ['atlanta','hard'], ['astana','hard'], ['nur-sultan','hard'], ['almaty','hard'],
  ['tel aviv','hard'], ['metz','hard'], ['sofia','hard'], ['stockholm','hard'],
  ['antwerp','hard'], ['vienna','hard'], ['paris masters','hard'],
  ['bercy','hard'], ['rolex paris','hard'], ['singapore','hard'],
  ['wuhan','hard'], ['florence','hard'], ['gijon','hard'], ['naples','hard'],
  ['adelaide','hard'], ['brisbane','hard'], ['sydney','hard'], ['auckland','hard'],
  ['hobart','hard'], ['pune','hard'], ['chennai','hard'],
  ['ho chi minh','hard'], ['nottingham challenger','hard'], ['bangkok','hard'],
  ['kaohsiung','hard'], ['taipei','hard'], ['guangzhou','hard'],
  ['ningbo','hard'], ['hangzhou','hard'], ['chengdu','hard'], ['zhuhai','hard'],
  ['hong kong','hard'], ['seoul','hard'], ['busan','hard'],
  ['next gen finals','hard'], ['atp finals','hard'], ['wta finals','hard'],
  ['davis cup finals','hard'],

  // ── Clay ──
  ['roland garros','clay'], ['french open','clay'], ['madrid','clay'],
  ['rome','clay'], ['italian open','clay'], ['internazionali','clay'],
  ['monte carlo','clay'], ['monte-carlo','clay'], ['barcelona','clay'],
  ['hamburg','clay'], ['houston','clay'], ['estoril','clay'], ['lyon','clay'],
  ['bucharest','clay'], ['marrakech','clay'], ['budapest','clay'],
  ['kitzbuhel','clay'], ['umag','clay'], ['gstaad','clay'], ['palermo','clay'],
  ['prague','clay'], ['bogota','clay'], ['buenos aires','clay'],
  ['cordoba','clay'], ['rio','clay'], ['sao paulo','clay'], ['dubrovnik','clay'],
  ['istanbul','clay'], ['munich','clay'], ['bmw open','clay'], ['geneva','clay'],
  ['bordeaux','clay'], ['aix-en-provence','clay'], ['aix en provence','clay'],
  ['tunis','clay'], ['casablanca','clay'], ['rabat','clay'], ['bastad','clay'],
  ['sarajevo','clay'], ['seville','clay'], ['portoroz','clay'], ['cluj','clay'],
  ['marbella','clay'], ['lima','clay'], ['santiago','clay'], ['montevideo','clay'],
  ['concepcion','clay'], ['cancun','clay'], ['guadalajara','clay'],
  ['parma','clay'], ['perugia','clay'], ['cagliari','clay'], ['sardegna','clay'],
  ['oeiras','clay'], ['braga','clay'], ['banja luka','clay'], ['szczecin','clay'],
  ['ostrava clay','clay'], ['olomouc','clay'], ['liberec','clay'],
  ['todi','clay'], ['mauthausen','clay'], ['tulln','clay'], ['salzburg','clay'],
  ['heilbronn','clay'], ['saarbrucken','clay'], ['mallorca challenger','clay'],
  ['valencia','clay'], ['alicante','clay'], ['girona','clay'], ['tarragona','clay'],

  // ── Grass ──
  ['wimbledon','grass'], ['halle','grass'], ["queen's",'grass'], ['queens','grass'],
  ['eastbourne','grass'], ['birmingham','grass'], ['nottingham','grass'],
  ['stuttgart','grass'], ['s-hertogenbosch','grass'], ['hertogenbosch','grass'],
  ['mallorca championships','grass'], ['mallorca grass','grass'],
  ['newport hall of fame','grass'], ['ilkley','grass'], ['surbiton','grass'],
  ['berlin','grass'],

  // ── Common ITF/Challenger venues without country marker ──
  ['strasbourg','clay'], ['santos','clay'], ['francavilla','clay'],
  ['split','clay'], ['murska sobota','clay'], ['montemar','clay'],
  ['bucaramanga','clay'], ['morelia','clay'], ['croissy-beaubourg','clay'],
  ['yokkaichi','hard'], ['maanshan','hard'], ['brazzaville','hard'],
  ['zhangjiagang','hard'], ['nanjing','hard'], ['kunming','hard'],
  ['cary','hard'], ['tiburon','hard'], ['las vegas','hard'],

  // ── Carpet (rare) ──
  ['st petersburg','hard'], ['st. petersburg','hard'],
];

const CLAY_COUNTRIES = [
  'spain','italy','france','portugal','argentina','chile','brazil','colombia',
  'peru','ecuador','mexico','morocco','tunisia','egypt','turkey','greece',
  'croatia','serbia','hungary','czech','slovakia','poland','romania','bulgaria',
  'austria','belgium','switzerland','netherlands','germany','sweden','norway',
  'denmark','finland','slovenia','montenegro','bosnia','albania','macedonia',
];
const HARD_COUNTRIES = [
  'australia','japan','china','hong kong','taiwan','south korea','korea',
  'india','uae','qatar','bahrain','saudi arabia','singapore','thailand',
  'malaysia','vietnam','indonesia','philippines','kazakhstan','uzbekistan',
  'usa','united states','canada',
];
const GRASS_COUNTRIES = ['uk','england','ireland','great britain'];

/**
 * Infer surface from upstream metadata. Order: explicit field → tournament
 * keyword → country fallback. Returns null when nothing matches.
 */
function inferSurface(src = {}) {
  const explicit = String(src.eventSurface || src.courtSurface || '').toLowerCase().trim();
  if (explicit && SURFACE_MAP[explicit]) return SURFACE_MAP[explicit];

  const haystack = [
    String(src.tournament || '').toLowerCase(),
    String(src.venue || '').toLowerCase(),
  ].filter(Boolean).join(' | ');

  for (const [key, surface] of TOURNAMENT_SURFACE_MAP) {
    if (haystack.includes(key)) return surface;
  }

  // Country in trailing parens "M25 City (Country)" OR after a comma "City, Country".
  const parenMatch = haystack.match(/\(([^)]+)\)/);
  const commaMatch = haystack.match(/,\s*([a-z][a-z\s.\-]+?)(?:\s*\||\s*$)/);
  const tail = (parenMatch?.[1] || commaMatch?.[1] || '').toLowerCase();
  if (tail) {
    if (CLAY_COUNTRIES.some(c  => tail.includes(c))) return 'clay';
    if (HARD_COUNTRIES.some(c  => tail.includes(c))) return 'hard';
    if (GRASS_COUNTRIES.some(c => tail.includes(c))) return 'grass';
  }

  if (haystack.includes('(usa)') || haystack.includes('united states')) return 'hard';

  return null;
}

module.exports = { inferSurface, SURFACE_MAP, TOURNAMENT_SURFACE_MAP };
