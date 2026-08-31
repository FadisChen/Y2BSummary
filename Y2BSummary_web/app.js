(() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  const STORAGE_KEY = 'y2bsummary_settings';
  const DEFAULT_MODEL = 'gemini-3-flash-preview';
  const MAX_CHAT_SEGMENTS = 180;
  const MAX_CHAT_REFERENCES = 5;
  const DEFAULT_PROMPT =
    '請提供：\n1. 影片主要內容筆記\n2. 關鍵觀點和重要資訊\n3. 主要結論或要點\n4. 如果有教學內容，請列出主要步驟\n\n請用繁體中文回答，並保持內容簡潔明瞭。';

  const CHAT_SYSTEM_INSTRUCTION = `你是影片研究助理。請只根據使用者提供的 YouTube 影片回答，不要把影片以外的推測當成事實。
所有回答使用繁體中文。回答相關問題時，請引用時間索引中的 segment_id；若影片沒有足夠證據，references 回傳空陣列。
時間索引的時間點是 AI 對影片內容的近似定位，不能聲稱是精確字幕或官方 citation。`;

  const CHAT_SEGMENT_SCHEMA = {
    type: 'object',
    properties: {
      id: { type: 'string', description: '依影片時間順序的片段 ID，例如 s001。' },
      start_seconds: { type: 'number' },
      end_seconds: { type: 'number' },
      title: { type: 'string' },
      summary: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' } },
    },
    required: ['id', 'start_seconds', 'end_seconds', 'title', 'summary', 'keywords'],
  };

  const CHAT_REFERENCE_SCHEMA = {
    type: 'object',
    properties: {
      segment_id: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['segment_id', 'reason'],
  };

  const CHAT_INIT_RESPONSE_FORMAT = {
    type: 'text',
    mime_type: 'application/json',
    schema: {
      type: 'object',
      properties: {
        answer: { type: 'string' },
        segments: { type: 'array', items: CHAT_SEGMENT_SCHEMA },
        references: { type: 'array', items: CHAT_REFERENCE_SCHEMA },
      },
      required: ['answer', 'segments', 'references'],
    },
  };

  const CHAT_FOLLOWUP_RESPONSE_FORMAT = {
    type: 'text',
    mime_type: 'application/json',
    schema: {
      type: 'object',
      properties: {
        answer: { type: 'string' },
        references: { type: 'array', items: CHAT_REFERENCE_SCHEMA },
      },
      required: ['answer', 'references'],
    },
  };

  const MARK_SUMMARY = '<<<Y2B_SUMMARY>>>';
  const MARK_MINDMAP = '<<<Y2B_MINDMAP>>>';

  /**
   * 單次請求：同時要求摘要筆記 + 心智圖 Markdown（與 ChatExtension 心智圖規則一致），以分隔線切分。
   */
  function buildCombinedVideoPrompt(userSummaryInstruction) {
    const summaryReq = (userSummaryInstruction || '').trim() || DEFAULT_PROMPT;
    return `請觀看影片，並依序產出兩個區塊。你必須使用下列分隔線（各占獨立一行，文字需完全一致），不得在分隔線之外寫任何前言、結語或重複標題。

${MARK_SUMMARY}
請依照下列要求撰寫「摘要筆記」（使用 Markdown，繁體中文）：
${summaryReq}

${MARK_MINDMAP}
請另產出「心智圖專用」Markdown（僅此區塊內容；不要重複貼上摘要全文）。心智圖規則：
1. 第一行用 # 標題作為心智圖的中心主題
2. 用 ## 表示主要分支（3到6個）
3. 用 ### 表示次要分支
4. 在各層級下用 - 列出關鍵要點
5. 每個要點保持簡潔（不超過15個字）
6. 層級不超過 5 層
7. 不要包在程式碼區塊（\`\`\`）內，不要額外說明文字`;
  }

  function stripMarkdownCodeFence(raw) {
    return raw
      .replace(/^```(?:markdown)?\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();
  }

  function extractGeminiText(result) {
    if (!result?.candidates?.length) return '';
    for (const cand of result.candidates) {
      const parts = cand?.content?.parts || [];
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text.trim()) return p.text;
      }
    }
    return '';
  }

  function extractInteractionText(result) {
    if (typeof result?.output_text === 'string' && result.output_text.trim()) {
      return result.output_text.trim();
    }

    const steps = Array.isArray(result?.steps) ? result.steps : [];
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i]?.type !== 'model_output') continue;
      const content = Array.isArray(steps[i].content) ? steps[i].content : [];
      for (let j = content.length - 1; j >= 0; j -= 1) {
        if (content[j]?.type === 'text' && typeof content[j].text === 'string' && content[j].text.trim()) {
          return content[j].text.trim();
        }
      }
    }

    return '';
  }

  function parseJsonPayload(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;

    const text = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      return JSON.parse(text);
    } catch {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end <= start) return null;
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }

  function parseYouTubeUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;

    let parsed;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
    let videoId = '';

    if (youtubeHosts.has(hostname) && parsed.pathname === '/watch') {
      videoId = parsed.searchParams.get('v') || '';
    } else if (hostname === 'youtu.be') {
      videoId = parsed.pathname.split('/').filter(Boolean)[0] || '';
    }

    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;

    return {
      videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  function normalizeModelName(value) {
    const model = typeof value === 'string' ? value.trim() : '';
    return model.replace(/^models\//i, '').trim() || DEFAULT_MODEL;
  }

  function formatTime(seconds) {
    const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainder = totalSeconds % 60;
    const paddedMinutes = String(minutes).padStart(2, '0');
    const paddedSeconds = String(remainder).padStart(2, '0');
    return hours > 0
      ? `${hours}:${paddedMinutes}:${paddedSeconds}`
      : `${paddedMinutes}:${paddedSeconds}`;
  }

  function buildYouTubeTimestampUrl(videoId, startSeconds) {
    const url = new URL('https://www.youtube.com/watch');
    url.searchParams.set('v', videoId);
    url.searchParams.set('t', `${Math.max(0, Math.floor(Number(startSeconds) || 0))}s`);
    return url.toString();
  }

  /**
   * 從單次 API 回傳中切出摘要與心智圖 Markdown；若格式不符則整段當摘要、心智圖為 null。
   */
  function parseCombinedResponse(raw) {
    if (!raw || typeof raw !== 'string') {
      return { summary: '', mindmapMd: null };
    }
    const text = raw.trim();
    const iS = text.indexOf(MARK_SUMMARY);
    const iM = text.indexOf(MARK_MINDMAP);
    if (iS === -1 || iM === -1 || iM <= iS) {
      return { summary: text, mindmapMd: null };
    }
    const afterS = iS + MARK_SUMMARY.length;
    const summary = text.slice(afterS, iM).trim();
    let mindmapMd = text.slice(iM + MARK_MINDMAP.length).trim();
    mindmapMd = stripMarkdownCodeFence(mindmapMd);
    return { summary: summary || text, mindmapMd: mindmapMd || null };
  }

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const videoUrlInput = document.getElementById('video-url');
  const submitBtn = document.getElementById('submit-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalClose = document.getElementById('modal-close');
  const modalCancel = document.getElementById('modal-cancel');
  const modalSave = document.getElementById('modal-save');
  const apiKeyInput = document.getElementById('api-key');
  const modelNameInput = document.getElementById('model-name');
  const promptInput = document.getElementById('prompt-input');
  const resultPlaceholder = document.getElementById('result-placeholder');
  const resultLoading = document.getElementById('result-loading');
  const resultError = document.getElementById('result-error');
  const resultErrorMsg = document.getElementById('result-error-msg');
  const resultContent = document.getElementById('result-content');
  const toast = document.getElementById('toast');

  const fpsInput = document.getElementById('fps');
  const mediaResSelect = document.getElementById('media-res');

  // ── Tab refs ───────────────────────────────────────────────────────────────
  const tabNote = document.getElementById('tab-note');
  const tabMindmap = document.getElementById('tab-mindmap');
  const tabChat = document.getElementById('tab-chat');
  const panelNote = document.getElementById('panel-note');
  const panelMindmap = document.getElementById('panel-mindmap');
  const panelChat = document.getElementById('panel-chat');

  // ── Chat refs ───────────────────────────────────────────────────────────────
  const chatStage = document.getElementById('chat-stage');
  const chatEmpty = document.getElementById('chat-empty');
  const chatMessages = document.getElementById('chat-messages');
  const chatIndexStatus = document.getElementById('chat-index-status');
  const chatStatus = document.getElementById('chat-status');
  const chatError = document.getElementById('chat-error');
  const chatInput = document.getElementById('chat-input');
  const chatForm = document.getElementById('chat-form');
  const chatSendBtn = document.getElementById('chat-send-btn');
  const chatResetBtn = document.getElementById('chat-reset-btn');

  // ── Mindmap refs ───────────────────────────────────────────────────────────
  const mindmapWrap = document.getElementById('mindmap-wrap');
  const mindmapSvg = document.getElementById('mindmap-svg');
  const mindmapPlaceholder = document.getElementById('mindmap-placeholder');
  const mmZoomIn = document.getElementById('mm-zoom-in');
  const mmZoomOut = document.getElementById('mm-zoom-out');
  const mmFit = document.getElementById('mm-fit');
  const mmExpand = document.getElementById('mm-expand');
  const mmCollapse = document.getElementById('mm-collapse');

  const chatState = {
    videoId: '',
    canonicalUrl: '',
    modelName: '',
    interactionId: '',
    segments: [],
    messages: [],
    requestSerial: 0,
    loading: false,
  };

  // ── Settings ───────────────────────────────────────────────────────────────
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveSettings(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function populateModal() {
    const s = loadSettings();
    apiKeyInput.value = s.apiKey || '';
    modelNameInput.value = s.modelName || DEFAULT_MODEL;
    promptInput.value = s.prompt || DEFAULT_PROMPT;
    fpsInput.value = Number(s.fps) > 0 ? String(s.fps) : '1';
    mediaResSelect.value = s.mediaRes || 'default';
  }

  function persistModal() {
    const s = loadSettings();
    s.apiKey = apiKeyInput.value.trim();
    s.modelName = modelNameInput.value.trim() || DEFAULT_MODEL;
    s.prompt = promptInput.value.trim() || DEFAULT_PROMPT;
    s.fps = parseFloat(fpsInput.value) || 1;
    s.mediaRes = mediaResSelect.value || 'default';
    saveSettings(s);
  }

  // ── Modal ──────────────────────────────────────────────────────────────────
  function openModal() {
    populateModal();
    modalOverlay.classList.add('is-open');
    setTimeout(() => apiKeyInput.focus(), 50);
  }

  function closeModal() {
    modalOverlay.classList.remove('is-open');
    settingsBtn.focus();
  }

  settingsBtn.addEventListener('click', openModal);
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);

  modalSave.addEventListener('click', () => {
    persistModal();
    closeModal();
    showToast('設定已儲存');
  });

  // Close on overlay click (outside modal box)
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalOverlay.classList.contains('is-open')) {
      closeModal();
    }
  });

  // ── Tab switching ─────────────────────────────────────────────────────────
  function activateTab(tab) {
    const isNote = tab === 'note';
    const isMindmap = tab === 'mindmap';
    const isChat = tab === 'chat';
    tabNote.classList.toggle('is-active', isNote);
    tabNote.setAttribute('aria-selected', String(isNote));
    tabMindmap.classList.toggle('is-active', isMindmap);
    tabMindmap.setAttribute('aria-selected', String(isMindmap));
    tabChat.classList.toggle('is-active', isChat);
    tabChat.setAttribute('aria-selected', String(isChat));
    panelNote.classList.toggle('is-active', isNote);
    panelMindmap.classList.toggle('is-active', isMindmap);
    panelChat.classList.toggle('is-active', isChat);

    // 分頁剛顯示時容器尺寸才正確，延遲 fit 避免在 display:none 下建立導致空白
    if (isMindmap && markmapInstance) {
      requestAnimationFrame(() => {
        markmapInstance.fit();
        requestAnimationFrame(() => markmapInstance.fit());
      });
    }

    if (isChat && !chatState.loading) {
      requestAnimationFrame(() => chatInput.focus());
    }
  }

  tabNote.addEventListener('click', () => activateTab('note'));
  tabMindmap.addEventListener('click', () => activateTab('mindmap'));
  tabChat.addEventListener('click', () => activateTab('chat'));

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastTimer = null;

  function showToast(message, duration = 2200) {
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), duration);
  }

  // ── Markmap（與 ChatExtension/sidebar.js 相同模式：destroy → 清空 SVG → Markmap.create）──
  let markmapInstance = null;

  function mindmapWalkTree(node, callback) {
    if (!node) return;
    callback(node);
    if (node.children) {
      node.children.forEach((child) => mindmapWalkTree(child, callback));
    }
  }

  function fitMindmapSoon() {
    if (!markmapInstance) return;
    requestAnimationFrame(() => {
      markmapInstance.fit();
      requestAnimationFrame(() => markmapInstance.fit());
    });
  }

  /** 心智圖在「摘要筆記」分頁時可能處於 display:none，尺寸為 0；用 ResizeObserver 在可見後重算版面 */
  if (typeof ResizeObserver !== 'undefined' && mindmapWrap) {
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e || !markmapInstance) return;
      const { width, height } = e.contentRect;
      if (width > 1 && height > 1) markmapInstance.fit();
    });
    ro.observe(mindmapWrap);
  }

  function renderMindmap(markdownText) {
    const mm = window.markmap;
    if (!mm || !mm.Transformer || !mm.Markmap) {
      console.warn('markmap 未載入（請確認 js/d3、markmap-lib、markmap-view 順序正確）');
      return;
    }

    const { Transformer, Markmap } = mm;

    try {
      const transformer = new Transformer();
      const { root } = transformer.transform(markdownText);

      mindmapPlaceholder.style.display = 'none';
      mindmapSvg.classList.add('is-visible');

      if (markmapInstance) {
        markmapInstance.destroy();
        markmapInstance = null;
      }
      mindmapSvg.innerHTML = '';

      markmapInstance = Markmap.create(
        mindmapSvg,
        {
          autoFit: true,
          duration: 300,
        },
        root
      );

      fitMindmapSoon();
    } catch (err) {
      console.error('心智圖渲染失敗', err);
    }
  }

  // Toolbar button handlers
  mmZoomIn.addEventListener('click', () => {
    if (!markmapInstance) return;
    markmapInstance.rescale(1.25);
  });

  mmZoomOut.addEventListener('click', () => {
    if (!markmapInstance) return;
    markmapInstance.rescale(0.8);
  });

  mmFit.addEventListener('click', () => {
    if (!markmapInstance) return;
    markmapInstance.fit();
  });

  mmExpand.addEventListener('click', () => {
    if (!markmapInstance) return;
    mindmapWalkTree(markmapInstance.state.data, (node) => {
      if (node.payload) node.payload.fold = 0;
      else node.payload = { fold: 0 };
    });
    markmapInstance.setData();
    markmapInstance.fit();
  });

  mmCollapse.addEventListener('click', () => {
    if (!markmapInstance) return;
    const root = markmapInstance.state.data;
    if (root && root.children) {
      root.children.forEach((child) => {
        mindmapWalkTree(child, (node) => {
          if (node.payload) node.payload.fold = 1;
          else node.payload = { fold: 1 };
        });
      });
    }
    markmapInstance.setData();
    markmapInstance.fit();
  });

  // ── Result display helpers ─────────────────────────────────────────────────
  function showState(state) {
    resultPlaceholder.style.display = state === 'placeholder' ? '' : 'none';
    resultLoading.style.display = state === 'loading' ? '' : 'none';
    resultError.style.display = state === 'error' ? '' : 'none';
    resultContent.style.display = state === 'content' ? '' : 'none';
  }

  function showError(message) {
    resultErrorMsg.textContent = message;
    showState('error');
  }

  // ── Markdown → HTML ────────────────────────────────────────────────────────
  function markdownToHtml(md) {
    if (!md || typeof md !== 'string') return '';

    // Escape HTML entities first to prevent XSS
    let html = md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Fenced code blocks (must run before inline code)
    html = html.replace(/```[\s\S]*?```/g, (match) => {
      const inner = match.slice(3, -3).replace(/^\n/, '');
      return `<pre><code>${inner}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Headings
    html = html
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold / italic
    html = html
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Lists — collect consecutive list items into <ul>
    html = html.replace(/((?:^[-*] .+\n?)+)/gm, (block) => {
      const items = block
        .trim()
        .split('\n')
        .map(line => `<li>${line.replace(/^[-*] /, '')}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    });

    // Ordered lists
    html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
      const items = block
        .trim()
        .split('\n')
        .map(line => `<li>${line.replace(/^\d+\. /, '')}</li>`)
        .join('');
      return `<ol>${items}</ol>`;
    });

    // Paragraphs — wrap non-tag lines
    html = html
      .split('\n')
      .map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        if (/^<(h[1-3]|ul|ol|li|pre|\/ul|\/ol|\/pre)/.test(trimmed)) return trimmed;
        return `<p>${trimmed}</p>`;
      })
      .join('\n');

    return html;
  }

  // ── Video chat and timestamp index ─────────────────────────────────────────
  function cleanChatText(value, fallback = '') {
    return typeof value === 'string' ? value.trim() : fallback;
  }

  function normalizeVideoIndex(rawSegments) {
    const candidates = [];

    (Array.isArray(rawSegments) ? rawSegments : []).forEach((raw, sourceIndex) => {
      if (!raw || typeof raw !== 'object' || raw.start_seconds == null || raw.end_seconds == null) return;

      const start = Number(raw.start_seconds);
      const end = Number(raw.end_seconds);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return;

      const sourceId = cleanChatText(raw.id, `__missing_${sourceIndex}`);

      candidates.push({
        sourceId,
        start,
        end,
        title: cleanChatText(raw.title, '影片片段'),
        summary: cleanChatText(raw.summary),
        keywords: Array.isArray(raw.keywords)
          ? [...new Set(raw.keywords.filter(keyword => typeof keyword === 'string' && keyword.trim()))].slice(0, 8)
          : [],
        sourceIndex,
      });
    });

    candidates.sort((a, b) => a.start - b.start || a.end - b.end || a.sourceIndex - b.sourceIndex);

    const idMap = new Map();
    const segments = candidates.slice(0, MAX_CHAT_SEGMENTS).map((candidate, index) => {
      const id = `s${String(index + 1).padStart(3, '0')}`;
      if (!idMap.has(candidate.sourceId)) idMap.set(candidate.sourceId, id);

      return {
        id,
        start_seconds: candidate.start,
        end_seconds: candidate.end,
        title: candidate.title,
        summary: candidate.summary,
        keywords: candidate.keywords,
      };
    });

    return { segments, idMap };
  }

  function normalizeChatReferences(rawReferences, indexInfo) {
    const segments = indexInfo?.segments || [];
    const idMap = indexInfo?.idMap || new Map();
    const validIds = new Set(segments.map(segment => segment.id));
    const seenIds = new Set();
    const references = [];

    (Array.isArray(rawReferences) ? rawReferences : []).forEach((raw) => {
      if (references.length >= MAX_CHAT_REFERENCES || !raw || typeof raw !== 'object') return;

      const requestedId = cleanChatText(raw.segment_id);
      const segmentId = idMap.get(requestedId) || requestedId;
      if (!validIds.has(segmentId) || seenIds.has(segmentId)) return;

      seenIds.add(segmentId);
      references.push({
        segmentId,
        reason: cleanChatText(raw.reason, '此片段包含與問題相關的內容。'),
      });
    });

    return references;
  }

  function parseInitialChatResponse(raw) {
    const payload = parseJsonPayload(raw);
    const answer = cleanChatText(payload?.answer);
    const indexInfo = normalizeVideoIndex(payload?.segments);

    if (!answer) throw new Error('API 回應中找不到有效的回答內容。');
    if (!indexInfo.segments.length) throw new Error('API 回應未包含可用的影片時間索引，請重試。');

    return {
      answer,
      segments: indexInfo.segments,
      references: normalizeChatReferences(payload.references, indexInfo),
    };
  }

  function parseFollowupChatResponse(raw) {
    const payload = parseJsonPayload(raw);
    const answer = cleanChatText(payload?.answer);
    if (!answer) throw new Error('API 回應中找不到有效的回答內容。');

    const indexInfo = {
      segments: chatState.segments,
      idMap: new Map(chatState.segments.map(segment => [segment.id, segment.id])),
    };

    return {
      answer,
      references: normalizeChatReferences(payload.references, indexInfo),
    };
  }

  function buildInitialChatPrompt(question) {
    return `請先完整觀看這部影片，再回答使用者問題。請同時建立影片的語意時間索引：依主題或事件變化切分，目標每段約 30 到 60 秒，依原始時間順序排列，最多 180 段。每段都要有唯一且依序的 id（s001、s002、…）、開始與結束秒數、簡短標題、繁體中文摘要及關鍵字。\n
使用者問題：\n${question}\n
回答規則：answer 放繁體中文回答；references 只能引用 segments 中確實與問題相關的 segment_id，無相關片段時使用空陣列。不要引用影片外的資料，也不要自行產生影片不存在的時間。`;
  }

  function buildFollowupChatPrompt(question) {
    const compactIndex = chatState.segments.map(segment => ({
      id: segment.id,
      start_seconds: segment.start_seconds,
      end_seconds: segment.end_seconds,
      title: segment.title,
      summary: segment.summary,
      keywords: segment.keywords,
    }));

    return `原始影片已在上一輪提供。請根據原始影片及下列已驗證的時間索引回答新的問題。references 只能使用索引中的 segment_id，不要自行改寫時間；沒有直接相關片段時使用空陣列。\n\n影片時間索引：\n${JSON.stringify(compactIndex)}\n\n使用者問題：\n${question}`;
  }

  function updateChatIndexStatus() {
    chatIndexStatus.textContent = chatState.segments.length
      ? `已建立 ${chatState.segments.length} 段 AI 時間索引 · 時間可能有誤差`
      : '尚未建立影片時間索引';
  }

  function createChatReferences(references) {
    const segmentById = new Map(chatState.segments.map(segment => [segment.id, segment]));
    const validReferences = references
      .map(reference => ({ reference, segment: segmentById.get(reference.segmentId) }))
      .filter(item => item.segment);

    if (!validReferences.length) return null;

    const section = document.createElement('section');
    section.className = 'chat-references';

    const heading = document.createElement('div');
    heading.className = 'chat-references-heading';
    heading.textContent = '影片片段';
    const headingHint = document.createElement('span');
    headingHint.textContent = 'AI 時間索引對應';
    heading.appendChild(headingHint);
    section.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'chat-reference-list';

    validReferences.forEach(({ reference, segment }) => {
      const item = document.createElement('div');
      item.className = 'chat-reference-item';

      const link = document.createElement('a');
      link.className = 'chat-reference-link';
      link.href = buildYouTubeTimestampUrl(chatState.videoId, segment.start_seconds);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = '在 YouTube 開啟此片段起點';

      const time = document.createElement('span');
      time.className = 'chat-reference-time';
      time.textContent = `${formatTime(segment.start_seconds)}–${formatTime(segment.end_seconds)}`;

      const title = document.createElement('span');
      title.className = 'chat-reference-title';
      title.textContent = segment.title;

      const arrow = document.createElement('span');
      arrow.className = 'chat-reference-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '↗';

      link.append(time, title, arrow);

      const reason = document.createElement('p');
      reason.className = 'chat-reference-reason';
      reason.textContent = reference.reason;

      item.append(link, reason);
      list.appendChild(item);
    });

    section.appendChild(list);
    return section;
  }

  function createChatMessage(item) {
    const article = document.createElement('article');
    article.className = `chat-message chat-message-${item.role}`;

    const meta = document.createElement('div');
    meta.className = 'chat-message-meta';
    meta.textContent = item.role === 'user' ? '你' : 'Gemini';

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';

    if (item.role === 'user') {
      bubble.textContent = item.text;
    } else {
      const answer = document.createElement('div');
      answer.className = 'chat-answer';
      answer.innerHTML = markdownToHtml(item.answer);
      bubble.appendChild(answer);

      const references = createChatReferences(item.references || []);
      if (references) bubble.appendChild(references);
    }

    article.append(meta, bubble);
    return article;
  }

  function renderChat() {
    const hasMessages = chatState.messages.length > 0;
    chatEmpty.style.display = hasMessages ? 'none' : '';
    chatMessages.style.display = hasMessages ? 'flex' : 'none';
    chatMessages.replaceChildren();

    chatState.messages.forEach((item) => {
      chatMessages.appendChild(createChatMessage(item));
    });

    if (hasMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    updateChatIndexStatus();
  }

  function showChatError(message) {
    chatError.textContent = message;
    chatError.hidden = false;
  }

  function clearChatError() {
    chatError.textContent = '';
    chatError.hidden = true;
  }

  function setChatLoading(isLoading, message = '') {
    chatState.loading = isLoading;
    chatStage.setAttribute('aria-busy', String(isLoading));
    chatInput.disabled = isLoading;
    chatSendBtn.disabled = isLoading;
    chatResetBtn.disabled = isLoading;
    chatStatus.textContent = isLoading ? message : '';
    chatStatus.classList.toggle('is-loading', isLoading);
  }

  function resetChatConversation() {
    chatState.requestSerial += 1;
    chatState.videoId = '';
    chatState.canonicalUrl = '';
    chatState.modelName = '';
    chatState.interactionId = '';
    chatState.segments = [];
    chatState.messages = [];
    chatInput.value = '';
    clearChatError();
    setChatLoading(false);
    renderChat();
  }

  function requestInteraction(requestBody, apiKey) {
    return fetch(GEMINI_INTERACTIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    }).then(async (response) => {
      if (!response.ok) {
        let errorBody = {};
        try { errorBody = await response.json(); } catch { /* ignore */ }
        const msg = errorBody?.error?.message || '未知錯誤';
        const details = Array.isArray(errorBody?.error?.details)
          ? errorBody.error.details
            .flatMap(detail => Array.isArray(detail?.fieldViolations) ? detail.fieldViolations : [])
            .map(violation => violation?.description)
            .filter(Boolean)
          : [];
        const detailMessage = details.length ? `（${[...new Set(details)].join('；')}）` : '';
        const error = new Error(`API 請求失敗（狀態碼 ${response.status}）：${msg}${detailMessage}`);
        error.status = response.status;
        error.apiMessage = msg;
        throw error;
      }
      return response.json();
    });
  }

  function isInvalidArgumentError(error) {
    return error?.status === 400 && /invalid argument/i.test(error.apiMessage || error.message || '');
  }

  async function requestInteractionWithCompatibilityFallback(requestBody, apiKey) {
    try {
      return {
        result: await requestInteraction(requestBody, apiKey),
        modelName: requestBody.model,
      };
    } catch (error) {
      if (!isInvalidArgumentError(error) || requestBody.model === DEFAULT_MODEL) throw error;

      // 舊版或自訂模型可能仍能呼叫 generateContent，但不在 Interactions 支援清單中。
      // 只在 API 明確回覆 INVALID_ARGUMENT 時改用目前預設模型，避免吞掉其他錯誤。
      return {
        result: await requestInteraction({ ...requestBody, model: DEFAULT_MODEL }, apiKey),
        modelName: DEFAULT_MODEL,
      };
    }
  }

  async function sendChatMessage() {
    if (chatState.loading) return;

    const question = chatInput.value.trim();
    if (!question) {
      showChatError('請先輸入想詢問影片的內容。');
      chatInput.focus();
      return;
    }

    const parsedUrl = parseYouTubeUrl(videoUrlInput.value);
    if (!parsedUrl) {
      showChatError('請先輸入有效的 YouTube 影片網址（支援 youtube.com/watch 或 youtu.be）。');
      videoUrlInput.focus();
      return;
    }

    const settings = loadSettings();
    if (!settings.apiKey) {
      showChatError('尚未設定 API 金鑰，請點擊右上角「設定」按鈕填入。');
      return;
    }

    if (chatState.videoId !== parsedUrl.videoId) resetChatConversation();
    chatState.videoId = parsedUrl.videoId;
    chatState.canonicalUrl = parsedUrl.canonicalUrl;

    const isFirstMessage = !chatState.interactionId || !chatState.segments.length;
    chatState.messages.push({ role: 'user', text: question });
    chatInput.value = '';
    clearChatError();
    renderChat();

    const requestSerial = ++chatState.requestSerial;
    setChatLoading(true, isFirstMessage
      ? 'Gemini 正在觀看影片並建立時間索引…'
      : 'Gemini 正在整理回答…');

    try {
      const model = chatState.modelName || normalizeModelName(settings.modelName);
      const requestBody = isFirstMessage
        ? {
            model,
            store: true,
            system_instruction: CHAT_SYSTEM_INSTRUCTION,
            input: [
              { type: 'text', text: buildInitialChatPrompt(question) },
              { type: 'video', uri: chatState.canonicalUrl },
            ],
            response_format: CHAT_INIT_RESPONSE_FORMAT,
          }
        : {
            model,
            store: true,
            previous_interaction_id: chatState.interactionId,
            system_instruction: CHAT_SYSTEM_INSTRUCTION,
            input: buildFollowupChatPrompt(question),
            response_format: CHAT_FOLLOWUP_RESPONSE_FORMAT,
          };

      const { result, modelName } = await requestInteractionWithCompatibilityFallback(requestBody, settings.apiKey);
      if (requestSerial !== chatState.requestSerial) return;

      const raw = extractInteractionText(result);
      if (!raw) throw new Error('API 回應中找不到有效的文字內容，請確認影片網址是否正確。');
      if (!result?.id) throw new Error('API 回應缺少對話識別碼，請重試。');

      if (isFirstMessage) {
        const parsed = parseInitialChatResponse(raw);
        chatState.segments = parsed.segments;
        chatState.modelName = modelName;
        chatState.interactionId = result.id;
        chatState.messages.push({ role: 'assistant', answer: parsed.answer, references: parsed.references });
      } else {
        const parsed = parseFollowupChatResponse(raw);
        chatState.interactionId = result.id;
        chatState.messages.push({ role: 'assistant', answer: parsed.answer, references: parsed.references });
      }

      renderChat();
    } catch (err) {
      if (requestSerial === chatState.requestSerial) showChatError(err.message || '對話請求失敗，請稍後再試。');
    } finally {
      if (requestSerial === chatState.requestSerial) setChatLoading(false);
    }
  }

  // ── API call ───────────────────────────────────────────────────────────────
  async function analyzeVideo(url) {
    const parsedUrl = parseYouTubeUrl(url);
    if (!parsedUrl) {
      showError('請輸入有效的 YouTube 影片網址（需包含 youtube.com/watch 或 youtu.be）。');
      return;
    }

    resetChatConversation();
    const s = loadSettings();

    if (!s.apiKey) {
      showError('尚未設定 API 金鑰，請點擊右上角「設定」按鈕填入。');
      return;
    }

    url = parsedUrl.canonicalUrl;

    const model = normalizeModelName(s.modelName);
    const prompt = buildCombinedVideoPrompt(s.prompt || DEFAULT_PROMPT);
    const apiUrl = `${GEMINI_API_BASE}${encodeURIComponent(model)}:generateContent`;

    const fpsVal =
      parseFloat(fpsInput.value) || parseFloat(s.fps) || 1;
    const videoMeta = { fps: fpsVal > 0 ? fpsVal : 1 };

    const requestBody = {
      contents: [
        {
          parts: [
            {
              file_data: { file_uri: url },
              video_metadata: videoMeta,
            },
            { text: prompt },
          ],
        },
      ],
      systemInstruction: {
        role: 'system',
        parts: [{ text: '請以繁體中文回覆。' }],
      },
    };

    showState('loading');
    submitBtn.disabled = true;

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': s.apiKey
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        let errorBody = {};
        try { errorBody = await response.json(); } catch { /* ignore */ }
        const msg = errorBody?.error?.message || '未知錯誤';
        throw new Error(`API 請求失敗（狀態碼 ${response.status}）：${msg}`);
      }

      const result = await response.json();
      const raw = extractGeminiText(result);

      if (!raw) {
        throw new Error('API 回應中找不到有效的文字內容，請確認影片網址是否正確。');
      }

      const { summary, mindmapMd } = parseCombinedResponse(raw);

      resultContent.innerHTML = markdownToHtml(summary);
      showState('content');

      if (mindmapMd) {
        renderMindmap(mindmapMd);
      } else {
        console.warn('回應未含心智圖分隔區塊，改以摘要文字繪製心智圖');
        showToast('未偵測到心智圖區塊，已暫以摘要文字繪製心智圖');
        renderMindmap(summary);
      }
    } catch (err) {
      showError(err.message);
    } finally {
      submitBtn.disabled = false;
    }
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  submitBtn.addEventListener('click', () => {
    const url = videoUrlInput.value.trim();

    if (!url) {
      showError('請輸入 YouTube 影片網址。');
      videoUrlInput.focus();
      return;
    }

    if (!parseYouTubeUrl(url)) {
      showError('請輸入有效的 YouTube 影片網址（需包含 youtube.com/watch 或 youtu.be）。');
      videoUrlInput.focus();
      return;
    }

    analyzeVideo(url);
  });

  // Allow pressing Enter in URL input to submit
  videoUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitBtn.click();
  });

  videoUrlInput.addEventListener('input', () => {
    const parsedUrl = parseYouTubeUrl(videoUrlInput.value);
    if (chatState.videoId && (!parsedUrl || parsedUrl.videoId !== chatState.videoId)) {
      resetChatConversation();
    }
  });

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChatMessage();
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    chatForm.requestSubmit();
  });

  chatResetBtn.addEventListener('click', () => {
    if (chatState.loading) return;
    resetChatConversation();
    chatInput.focus();
    showToast('已清除對話，下一次提問會重新建立影片索引');
  });

  // ── Init ───────────────────────────────────────────────────────────────────
  showState('placeholder');
  renderChat();
  (function initFpsMediaFromStorage() {
    const st = loadSettings();
    if (fpsInput && Number(st.fps) > 0) fpsInput.value = String(st.fps);
    if (mediaResSelect && st.mediaRes) mediaResSelect.value = st.mediaRes;
  })();
})();
