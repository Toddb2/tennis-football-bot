// Try api-tennis to confirm the Faria match outcome.
const axios = require('/home/bots/tennis-bot/node_modules/axios').default || require('/home/bots/tennis-bot/node_modules/axios');
const apiKey = process.env.API_TENNIS_KEY || require('fs').readFileSync('/home/bots/tennis-bot/.env','utf8').split('\n').find(l => l.startsWith('API_TENNIS_KEY='))?.split('=')[1]?.trim().replace(/^["']|["']$/g,'');
if (!apiKey) { console.error('No API_TENNIS_KEY'); process.exit(1); }

async function main() {
  // Get today's ATP fixtures
  const r = await axios.get('https://api.api-tennis.com/tennis/', {
    params: { method: 'get_fixtures', APIkey: apiKey, date_start: '2026-05-19', date_stop: '2026-05-19' },
    timeout: 15000,
  });
  const fixtures = r.data?.result || [];
  console.log(`Got ${fixtures.length} fixtures today`);

  const wanted = ['faria', 'kouame', 'vidmanova', 'masarova'];
  for (const f of fixtures) {
    const text = `${f.event_first_player || ''} ${f.event_second_player || ''}`.toLowerCase();
    if (wanted.some(w => text.includes(w))) {
      console.log(`\n  ${f.event_first_player} v ${f.event_second_player}`);
      console.log(`    tournament: ${f.tournament_name || f.league_name}`);
      console.log(`    status:     ${f.event_status}`);
      console.log(`    final:      ${f.event_final_result}`);
      console.log(`    winner:     ${f.event_winner}`);
      console.log(`    game_score: ${f.event_game_result}`);
      console.log(`    date/time:  ${f.event_date} ${f.event_time}`);
    }
  }
}
main().catch(e => console.error('Failed:', e.message));
