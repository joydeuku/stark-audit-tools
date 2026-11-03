// ==UserScript==
// @name         Stark Audit Report Generator
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  Auto-discovers queues from Stark and generates Slack pending report by marketplace
// @match        https://console.harmony.a2z.com/stark/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      corp.wwasss-wwasstark-jjmlrkhkqh.iad.prod.hex.a2z.com
// ==/UserScript==

(function () {
  'use strict';

  const API_HOST = 'https://corp.wwasss-wwasstark-jjmlrkhkqh.iad.prod.hex.a2z.com';
  const CAT_ORDER = ['Inhouse', '3P', '3P CTC', 'Other'];
  const MARKETPLACE_ORDER = ['EN', 'FR', 'DE', 'IT', 'ES&MX'];

  function getUsername() {
    const fromSpan = document.querySelector('.userName span')?.textContent?.trim();
    if (fromSpan) return fromSpan;
    try {
      const img = document.querySelector('.badgePhoto');
      if (img?.src) return new URL(img.src).searchParams.get('uid');
    } catch {}
    return null;
  }

  function detectCategory(templateName) {
    const lower = templateName.toLowerCase();
    if (lower.includes('ctcaudit')) return '3P CTC';
    if (lower.includes('amzaudit')) return '3P';
    if (lower.includes('inhouse')) return 'Inhouse';
    return 'Other';
  }

  function detectMarketplace(templateName) {
    if (templateName.endsWith('_ES&MX')) return 'ES&MX';
    if (templateName.endsWith('_IT')) return 'IT';
    if (templateName.endsWith('_FR')) return 'FR';
    if (templateName.endsWith('_DE')) return 'DE';
    if (templateName.endsWith('_EN')) return 'EN';
    return 'EN'; // default
  }

  function cleanName(templateName) {
    let name = templateName
      .replace(/^SPRelevance_/, '')
      .replace(/^SBRelevance_/, '')
      .replace(/^BooksRelevance_/, 'BooksRelevance ')
      .replace(/^BooksRelevanceLLM_/, 'BooksRelevanceLLM ')
      .replace(/^ABRelevance_/, 'ABRelevance ')
      .replace(/_AMZAudit/i, '')
      .replace(/_CTCAudit/i, '')
      .replace(/_Inhouse/i, '')
      .replace(/_/g, ' ')
      .trim();
    return name || templateName;
  }

  function getWeekOffsets(category) {
    if (category === '3P') return [-1, -2];
    return [0, -1];
  }

  function getWeekAndYear(offset) {
    const now = new Date();
    const target = new Date(now);
    target.setDate(target.getDate() + offset * 7);
    const year = target.getFullYear();
    const start = new Date(year, 0, 1);
    const diff = target.getTime() - start.getTime();
    const week = Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
    return { week, year };
  }

  function gmRequest(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        withCredentials: true,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Origin': 'https://console.harmony.a2z.com',
          'Referer': 'https://console.harmony.a2z.com/stark/Queue',
        },
        timeout: 20000,
        onload: (r) => {
          if (r.status !== 200) { resolve(null); return; }
          try { resolve(JSON.parse(r.responseText)); } catch { resolve(null); }
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  async function gmRequestWithRetry(url, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      const result = await gmRequest(url);
      if (result !== null) return result;
      if (i < retries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
    return null;
  }

  async function discoverSources(username) {
    const data = await gmRequestWithRetry(`${API_HOST}/moderation/templatesource?user=${username}`);
    if (!data || !Array.isArray(data)) return null;
    const sources = [];
    for (const item of data) {
      if (item.id && item.templateName) {
        sources.push({
          id: item.id,
          templateName: item.templateName,
          name: cleanName(item.templateName),
          category: detectCategory(item.templateName),
          marketplace: detectMarketplace(item.templateName),
        });
      }
    }
    return sources;
  }

  async function fetchCount(sourceId, weekNo, year) {
    const url = `${API_HOST}/statistics/taskcount?workflowType=QUEUE&sourceId=${sourceId}&weekNo=${weekNo}&year=${year}`;
    const data = await gmRequestWithRetry(url);
    if (!data) return { error: 'Failed after 3 attempts' };
    const stats = data?.taskCountStats?.[0]?.taskCount || [];
    let completed = 0, unworked = 0, assigned = 0;
    for (const s of stats) {
      if (s.status === 'Completed') completed = s.count;
      if (s.status === 'Unworked') unworked = s.count;
      if (s.status === 'Assigned') assigned = s.count;
    }
    return { completed, unworked, assigned };
  }

  function generateReport(rows, username) {
    const now = new Date();
    const timeLabel = now.getHours() < 12 ? 'Morning' : now.getHours() < 17 ? 'Afternoon' : 'Evening';
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    // Group: marketplace → category → rows
    const grouped = {};
    for (const r of rows) {
      if (!grouped[r.marketplace]) grouped[r.marketplace] = {};
      if (!grouped[r.marketplace][r.category]) grouped[r.marketplace][r.category] = [];
      grouped[r.marketplace][r.category].push(r);
    }

    // Collect all pending rows for overall summary
    const allPending = rows.filter(r => r.pending > 0);
    const grandVol = allPending.reduce((s, r) => s + r.volume, 0);
    const grandComp = allPending.reduce((s, r) => s + r.completed, 0);
    const grandPend = allPending.reduce((s, r) => s + r.pending, 0);

    let report = `📊 *Stark Audit — Pending Count Status (${timeLabel} Update)*\n`;
    report += `📅 ${dateStr} | 🕐 ${timeStr}\n`;
    report += `${'─'.repeat(50)}\n\n`;

    report += `*📈 Overall Summary*\n`;
    report += `• Total Audit Volume: *${grandVol}*\n`;
    report += `• Total Completed: *${grandComp}*\n`;
    report += `• 🔴 Total Pending: *${grandPend}*\n\n`;

    if (allPending.length === 0) {
      report += `✅ *All queues are clear — no pending audits!*\n\n`;
      report += `${'─'.repeat(50)}\n`;
      report += `_Sent via Stark Audit Auto-Report (${username})_`;
      return report;
    }

    // Sort marketplaces: known order first, then any extras alphabetically
    const allMarketplaces = Object.keys(grouped);
    const sortedMarketplaces = [
      ...MARKETPLACE_ORDER.filter(m => allMarketplaces.includes(m)),
      ...allMarketplaces.filter(m => !MARKETPLACE_ORDER.includes(m)).sort(),
    ];

    for (const mp of sortedMarketplaces) {
      const cats = grouped[mp];

      // Check if this marketplace has any pending rows
      let mpPending = 0;
      for (const cat of CAT_ORDER) {
        if (cats[cat]) mpPending += cats[cat].filter(r => r.pending > 0).length;
      }
      if (mpPending === 0) continue;

      // Marketplace totals (only pending rows)
      let mpVol = 0, mpComp = 0, mpPend = 0;
      for (const cat of CAT_ORDER) {
        if (cats[cat]) {
          for (const r of cats[cat].filter(r => r.pending > 0)) {
            mpVol += r.volume;
            mpComp += r.completed;
            mpPend += r.pending;
          }
        }
      }

      report += `${'═'.repeat(50)}\n`;
      report += `*🌍 ${mp}* (Pending: ${mpPend} | Vol: ${mpVol} | Completed: ${mpComp})\n`;

      for (const cat of CAT_ORDER) {
        if (!cats[cat]) continue;
        const pendingRows = cats[cat].filter(r => r.pending > 0);
        if (pendingRows.length === 0) continue;

        const catVol = pendingRows.reduce((s, r) => s + r.volume, 0);
        const catComp = pendingRows.reduce((s, r) => s + r.completed, 0);
        const catPend = pendingRows.reduce((s, r) => s + r.pending, 0);

        report += `\n${'─'.repeat(50)}\n`;
        report += `*📋 ${cat}* (Pending: ${catPend})\n\n`;
        report += `| Process | Wk | Audit Vol | Completed | Pending |\n`;
        report += `|---------|----|-----------|-----------|----------|\n`;

        for (const r of pendingRows) {
          report += `| ${r.name} | ${r.week} | ${r.volume} | ${r.completed} | *${r.pending}* |\n`;
        }
        report += `| *Total* | | *${catVol}* | *${catComp}* | *${catPend}* |\n`;
      }
      report += `\n`;
    }

    report += `${'═'.repeat(50)}\n`;
    report += `_Sent via Stark Audit Auto-Report (${username})_`;
    return report;
  }

  function createUI() {
    const btn = document.createElement('button');
    btn.innerHTML = '📊 Generate Report';
    btn.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;padding:12px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 15px rgba(0,0,0,0.3);font-family:-apple-system,sans-serif;';

    const panel = document.createElement('div');
    panel.style.cssText = 'display:none;position:fixed;bottom:70px;right:20px;width:580px;max-height:80vh;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.2);overflow:hidden;z-index:99999;font-family:-apple-system,sans-serif;';

    const header = document.createElement('div');
    header.style.cssText = 'background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:14px 18px;font-weight:700;font-size:15px;display:flex;justify-content:space-between;align-items:center;';
    header.innerHTML = '<span>⚡ Stark Audit Report</span>';
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:18px;cursor:pointer;';
    closeBtn.onclick = () => panel.style.display = 'none';
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.style.cssText = 'padding:16px;overflow-y:auto;max-height:calc(80vh - 50px);';

    const statusDiv = document.createElement('div');
    statusDiv.style.cssText = 'margin-bottom:12px;padding:10px;border-radius:6px;background:#ebf5fb;color:#2980b9;font-size:13px;';
    statusDiv.innerHTML = 'Click "Generate Report" to start.';

    const debugDiv = document.createElement('div');
    debugDiv.style.cssText = 'margin-bottom:12px;padding:10px;border-radius:6px;background:#f8f9fa;font-size:11px;color:#666;display:none;max-height:200px;overflow:auto;font-family:monospace;white-space:pre-wrap;';

    const previewDiv = document.createElement('div');
    previewDiv.style.cssText = 'background:#1a1a2e;border-radius:8px;padding:14px;font-family:monospace;font-size:11px;color:#e0e0e0;white-space:pre-wrap;line-height:1.5;max-height:350px;overflow:auto;margin-bottom:12px;display:none;user-select:text;';

    const actionsDiv = document.createElement('div');
    actionsDiv.style.cssText = 'display:none;gap:8px;flex-wrap:wrap;';

    body.appendChild(statusDiv);
    body.appendChild(debugDiv);
    body.appendChild(previewDiv);
    body.appendChild(actionsDiv);
    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(btn);
    document.body.appendChild(panel);

    let lastReport = '';

    btn.onclick = async () => {
      panel.style.display = 'block';
      previewDiv.style.display = 'none';
      actionsDiv.style.display = 'none';
      debugDiv.style.display = 'none';
      statusDiv.style.background = '#ebf5fb';
      statusDiv.style.color = '#2980b9';

      const username = getUsername();
      if (!username) {
        statusDiv.style.background = '#fdecea';
        statusDiv.style.color = '#721c24';
        statusDiv.innerHTML = '❌ Could not detect username. Make sure the Stark page is fully loaded.';
        return;
      }
      statusDiv.innerHTML = `⏳ Logged in as <b>${username}</b> — discovering sources...`;

      const startTime = Date.now();
      let debugLog = `👤 User: ${username}\n\n`;

      const sources = await discoverSources(username);

      if (!sources || sources.length === 0) {
        statusDiv.style.background = '#fdecea';
        statusDiv.style.color = '#721c24';
        statusDiv.innerHTML = `❌ No sources found for <b>${username}</b>.`;
        debugDiv.style.display = 'block';
        debugDiv.textContent = `${debugLog}API failed after retries.`;
        return;
      }

      debugLog += `📡 Discovered ${sources.length} sources:\n`;
      for (const mp of MARKETPLACE_ORDER) {
        const mpSources = sources.filter(s => s.marketplace === mp);
        if (mpSources.length === 0) continue;
        debugLog += `\n  🌍 ${mp} (${mpSources.length}):\n`;
        for (const cat of CAT_ORDER) {
          const catSources = mpSources.filter(s => s.category === cat);
          if (catSources.length === 0) continue;
          debugLog += `    ${cat}:\n`;
          for (const s of catSources) debugLog += `      • ${s.name}\n`;
        }
      }
      debugLog += `\n${'─'.repeat(40)}\n`;

      const totalCalls = sources.reduce((s, src) => s + getWeekOffsets(src.category).length, 0);
      let failCount = 0;
      statusDiv.innerHTML = `⏳ <b>${username}</b> — fetching ${totalCalls} counts (with auto-retry)...`;

      const allPromises = [];
      for (const src of sources) {
        for (const offset of getWeekOffsets(src.category)) {
          const { week, year } = getWeekAndYear(offset);
          allPromises.push(
            fetchCount(src.id, week, year).then(data => ({
              cat: src.category, name: src.name, marketplace: src.marketplace, week, data,
            }))
          );
        }
      }

      const allResults = await Promise.all(allPromises);

      const allRows = [];
      for (const { cat, name, marketplace, week, data } of allResults) {
        if (data.error) {
          failCount++;
          debugLog += `❌ ${name} (${cat}/${marketplace}) Wk${week}: ${data.error}\n`;
          continue;
        }
        const volume = data.completed + data.unworked + data.assigned;
        const pending = data.unworked + data.assigned;
        debugLog += `✅ ${name} (${cat}/${marketplace}) Wk${week}: Vol=${volume} Comp=${data.completed} Pend=${pending}\n`;
        allRows.push({ name, category: cat, marketplace, week, volume, completed: data.completed, pending });
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      debugDiv.style.display = 'block';
      debugDiv.textContent = `👤 ${username} | ${sources.length} sources | ${totalCalls} calls in ${elapsed}s | Failed: ${failCount}\n${'─'.repeat(40)}\n${debugLog}`;

      lastReport = generateReport(allRows, username);

      if (failCount > 0) {
        statusDiv.style.background = '#fef9e7';
        statusDiv.style.color = '#856404';
        statusDiv.innerHTML = `⚠️ <b>${username}</b> — Done in ${elapsed}s. ${failCount}/${totalCalls} failed (after retries).`;
      } else {
        statusDiv.style.background = '#e8f8f0';
        statusDiv.style.color = '#155724';
        statusDiv.innerHTML = `✅ <b>${username}</b> — Done in ${elapsed}s. ${sources.length} sources, all OK!`;
      }

      previewDiv.style.display = 'block';
      previewDiv.textContent = lastReport;
      actionsDiv.style.display = 'flex';
      actionsDiv.innerHTML = '';

      const copyBtn = document.createElement('button');
      copyBtn.innerHTML = '📋 Copy to Clipboard';
      copyBtn.style.cssText = 'padding:8px 16px;border-radius:6px;border:none;background:#27ae60;color:#fff;font-size:13px;font-weight:600;cursor:pointer;';
      copyBtn.onclick = () => {
        try {
          GM_setClipboard(lastReport);
          statusDiv.style.background = '#e8f8f0';
          statusDiv.style.color = '#155724';
          statusDiv.innerHTML = '✅ Copied! Paste in Slack.';
        } catch (e) {
          navigator.clipboard.writeText(lastReport).then(() => {
            statusDiv.innerHTML = '✅ Copied! Paste in Slack.';
          }).catch(() => {
            statusDiv.innerHTML = '⚠️ Copy failed — select text manually.';
          });
        }
      };
      actionsDiv.appendChild(copyBtn);
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createUI);
  } else {
    createUI();
  }
})();
