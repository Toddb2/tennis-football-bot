#!/usr/bin/env python3
import re
P = '/home/bots/tennis-bot/src/dashboard/public/app.js'
with open(P, 'r', encoding='utf-8') as f:
    s = f.read()

m = re.search(r'function _aiMarkdown\(text\) \{[\s\S]*?\n\}\n', s)
if not m:
    print('not found'); raise SystemExit(1)

new_fn = r'''function _aiMarkdown(text) {
  if (!text) return '';
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/```([\s\S]*?)```/g, (_, c) => `<pre style="background:var(--surface2);padding:8px;border-radius:5px;overflow-x:auto;font-size:11px;line-height:1.4">${c}</pre>`);
  html = html.replace(/`([^`\n]+)`/g, '<code style="background:var(--surface2);padding:1px 5px;border-radius:3px;font-size:12px">$1</code>');
  html = html.replace(/^### (.*)$/gm, '<h4 style="font-size:13px;margin:10px 0 4px;color:var(--text)">$1</h4>');
  html = html.replace(/^## (.*)$/gm, '<h3 style="font-size:14px;margin:12px 0 6px;color:var(--text)">$1</h3>');
  html = html.replace(/^# (.*)$/gm, '<h2 style="font-size:15px;margin:14px 0 8px;color:var(--text)">$1</h2>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // Pipe tables
  html = html.replace(/(^|\n)((?:\|[^\n]+\|\n)+)/g, (full, lead, block) => {
    const lines = block.trim().split('\n');
    if (lines.length < 2) return full;
    const sep = lines[1];
    if (!/^\s*\|[\s\-:|]+\|\s*$/.test(sep)) return full;
    const cells = (line) => line.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim());
    const head = cells(lines[0]);
    const rows = lines.slice(2).map(cells);
    const thStyle = 'text-align:left;padding:4px 8px;border-bottom:1px solid var(--border);font-weight:700;font-size:12px;color:var(--muted)';
    const tdStyle = 'padding:4px 8px;border-bottom:1px solid rgba(48,54,61,.4);font-size:12px';
    const headHtml = `<tr>${head.map(h => `<th style="${thStyle}">${h}</th>`).join('')}</tr>`;
    const bodyHtml = rows.map(r => `<tr>${r.map(c => `<td style="${tdStyle}">${c}</td>`).join('')}</tr>`).join('');
    return `${lead}<div style="overflow-x:auto;margin:6px 0"><table style="border-collapse:collapse;width:100%;background:var(--surface2);border-radius:6px">${headHtml}${bodyHtml}</table></div>`;
  });
  html = html.replace(/(^|\n)((?:[-*]\s.+\n?)+)/g, (m_, lead, block) => {
    const items = block.trim().split(/\n/).map(l => l.replace(/^[-*]\s+/, '').trim()).filter(Boolean).map(li => `<li style="margin:2px 0">${li}</li>`).join('');
    return lead + `<ul style="margin:4px 0 6px 18px;padding:0">${items}</ul>`;
  });
  html = html.replace(/(^|\n)((?:\d+\.\s.+\n?)+)/g, (m_, lead, block) => {
    const items = block.trim().split(/\n/).map(l => l.replace(/^\d+\.\s+/, '').trim()).filter(Boolean).map(li => `<li style="margin:2px 0">${li}</li>`).join('');
    return lead + `<ol style="margin:4px 0 6px 22px;padding:0">${items}</ol>`;
  });
  html = html.split(/\n{2,}/).map(p => {
    const t = p.trim();
    if (!t) return '';
    if (/^<(h\d|ul|ol|pre|div|table)/.test(t)) return t;
    return `<p style="margin:6px 0">${p.replace(/\n/g, '<br>')}</p>`;
  }).join('');
  return html;
}
'''
s = s[:m.start()] + new_fn + s[m.end():]
with open(P, 'w', encoding='utf-8') as f:
    f.write(s)
print('_aiMarkdown rewritten')
