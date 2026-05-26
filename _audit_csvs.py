#!/usr/bin/env python3
import csv, os, urllib.request

URLS = {
    'bets':    'http://127.0.0.1:3001/api/db/bets/csv?since=-90%20days',
    'scanner': 'http://127.0.0.1:3001/api/db/market-scanner/csv',
    'entry':   'http://127.0.0.1:3001/api/db/bets/entry-data/csv',
}

def looks_num(v):
    try: float(v); return True
    except: return False

for tag, url in URLS.items():
    print(f'\n=========== {tag} ===========')
    fn = f'/tmp/_audit_{tag}.csv'
    urllib.request.urlretrieve(url, fn)
    rows = list(csv.DictReader(open(fn)))
    if not rows:
        print('NO ROWS')
        continue
    cols = list(rows[0].keys())
    print(f'rows: {len(rows)}  cols: {len(cols)}')

    # Columns that are entirely empty
    all_empty = [k for k in cols if all((r.get(k) or '').strip() == '' for r in rows)]
    print(f'all-empty cols ({len(all_empty)}):')
    for k in all_empty: print(f'  - {k}')

    # Columns with weird long decimals (float garbage)
    weird = []
    for k in cols:
        vs = [r[k] for r in rows if r.get(k)]
        if vs and all(looks_num(v) for v in vs):
            longs = [v for v in vs if '.' in v and len(v.split('.')[-1]) > 4]
            if longs:
                weird.append((k, longs[:3]))
    if weird:
        print('long-decimal cols:')
        for k, vs in weird: print(f'  - {k}: {vs}')

    # Rows where sets_at_entry is empty but bet was placed mid-match
    if tag == 'bets':
        empty_sets = [r for r in rows if not (r.get('sets_at_entry') or '').strip() and r.get('reason')]
        print(f"bets with empty sets_at_entry but reason populated: {len(empty_sets)} / {len(rows)}")
        if empty_sets:
            for r in empty_sets[:3]:
                print(f"  bet_id={r['bet_id']}  reason snippet={r['reason'][:60]}")

    # Sample sets_final
    if 'sets_final' in cols:
        samples = list(set([r['sets_final'] for r in rows if r.get('sets_final')]))[:6]
        print(f'sets_final sample values: {samples}')

    # Spot any suspicious empty for normally-populated cols
    for k in ['pnl', 'requested_odds', 'placed_at']:
        if k in cols:
            empty = sum(1 for r in rows if not (r.get(k) or '').strip())
            print(f'  {k}: {empty} empty / {len(rows)}')
