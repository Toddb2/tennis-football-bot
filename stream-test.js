const API_BASE = (process.env.API_BASE || 'http://77.72.7.148:6616').replace(/\/$/, '');
function parseArgs(argv) {
    const positional = [], flags = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            let key = arg.slice(2), value = null;
            const eq = key.indexOf('=');
            if (eq !== -1) { value = key.slice(eq + 1); key = key.slice(0, eq); }
            if (value === null || value === '') {
                const next = argv[i + 1];
                if (next && !next.startsWith('--')) { value = next; i++; } else { value = 'true'; }
            }
            flags[key] = value;
        } else { positional.push(arg); }
    }
    return { sport: positional[0] || 'tennis', date: flags.date || null, marketId: flags.marketId || null, eventId: flags.eventId || null, selectionId: flags.selectionId || null, inPlay: flags.inPlay ?? null };
}
function buildUrl(sport, filters) {
    const params = new URLSearchParams();
    if (filters.date) params.set('date', filters.date);
    if (filters.marketId) params.set('marketId', filters.marketId);
    if (filters.inPlay != null) params.set('inPlay', String(filters.inPlay));
    const qs = params.toString();
    return `${API_BASE}/api/${sport}/external/stream${qs ? `?${qs}` : ''}`;
}
function parseSseChunk(buffer, chunk) {
    buffer += chunk;
    const events = [], parts = buffer.split('\n\n'), remainder = parts.pop() || '';
    for (const block of parts) {
        const lines = block.split('\n').filter(Boolean);
        let event = 'message'; const dataLines = [];
        for (const line of lines) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length) events.push({ event, data: dataLines.join('\n') });
    }
    return { events, buffer: remainder };
}
function summariseMarket(market) {
    const runners = market.runners || [], first = runners[0], prices = first?.prices;
    return { marketId: market.marketId, market_name: market.market_name, in_play: market.in_play, status: market.status, runners: runners.length, sample: first ? { selectionId: first.selectionId, name: first.name, back: prices?.back, lay: prices?.lay, ltp: prices?.ltp } : null };
}
function handleEvent(event, dataRaw) {
    let data; try { data = JSON.parse(dataRaw); } catch { console.log(`[${event}] (non-JSON) ${dataRaw.slice(0, 200)}`); return; }
    const ts = new Date().toISOString();
    switch (event) {
        case 'connected': console.log(`[${ts}] connected`, data); break;
        case 'snapshot': console.log(`[${ts}] snapshot: ${data.count} market(s)`, (data.markets || []).map(summariseMarket)); break;
        case 'market': console.log(`[${ts}] market update`, summariseMarket(data.market)); break;
        case 'heartbeat': process.stdout.write('.'); break;
        case 'error': console.error(`[${ts}] error`, data); break;
        default: console.log(`[${ts}] ${event}`, data);
    }
}
async function main() {
    const filters = parseArgs(process.argv), url = buildUrl(filters.sport, filters);
    console.log('Connecting:', url); console.log('(Ctrl+C to stop)\n');
    const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
    if (!res.ok) { console.error(`HTTP ${res.status}\n${await res.text()}`); process.exit(1); }
    const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    process.on('SIGINT', () => { console.log('\nStopped.'); process.exit(0); });
    while (true) {
        const { done, value } = await reader.read();
        if (done) { console.log('\nStream ended.'); break; }
        const chunk = decoder.decode(value, { stream: true }), parsed = parseSseChunk(buffer, chunk);
        buffer = parsed.buffer;
        for (const { event, data } of parsed.events) handleEvent(event, data);
    }
}
main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
