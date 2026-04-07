(() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const STORAGE_KEY = 'y2bsummary_settings';
  const DEFAULT_MODEL = 'gemini-3-flash-preview';
  const DEFAULT_PROMPT =
    '請提供：\n1. 影片主要內容筆記\n2. 關鍵觀點和重要資訊\n3. 主要結論或要點\n4. 如果有教學內容，請列出主要步驟\n\n請用繁體中文回答，並保持內容簡潔明瞭。';

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
  const videoUrlInput   = document.getElementById('video-url');
  const submitBtn       = document.getElementById('submit-btn');
  const settingsBtn     = document.getElementById('settings-btn');
  const modalOverlay    = document.getElementById('modal-overlay');
  const modalClose      = document.getElementById('modal-close');
  const modalCancel     = document.getElementById('modal-cancel');
  const modalSave       = document.getElementById('modal-save');
  const apiKeyInput     = document.getElementById('api-key');
  const modelNameInput  = document.getElementById('model-name');
  const promptInput     = document.getElementById('prompt-input');
  const resultPlaceholder = document.getElementById('result-placeholder');
  const resultLoading   = document.getElementById('result-loading');
  const resultError     = document.getElementById('result-error');
  const resultErrorMsg  = document.getElementById('result-error-msg');
  const resultContent   = document.getElementById('result-content');
  const toast           = document.getElementById('toast');

  const fpsInput        = document.getElementById('fps');
  const mediaResSelect  = document.getElementById('media-res');

  // ── Tab refs ───────────────────────────────────────────────────────────────
  const tabNote       = document.getElementById('tab-note');
  const tabMindmap    = document.getElementById('tab-mindmap');
  const panelNote     = document.getElementById('panel-note');
  const panelMindmap  = document.getElementById('panel-mindmap');

  // ── Mindmap refs ───────────────────────────────────────────────────────────
  const mindmapWrap        = document.getElementById('mindmap-wrap');
  const mindmapSvg         = document.getElementById('mindmap-svg');
  const mindmapPlaceholder = document.getElementById('mindmap-placeholder');
  const mmZoomIn    = document.getElementById('mm-zoom-in');
  const mmZoomOut   = document.getElementById('mm-zoom-out');
  const mmFit       = document.getElementById('mm-fit');
  const mmExpand    = document.getElementById('mm-expand');
  const mmCollapse  = document.getElementById('mm-collapse');

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
    apiKeyInput.value    = s.apiKey    || '';
    modelNameInput.value = s.modelName || DEFAULT_MODEL;
    promptInput.value    = s.prompt    || DEFAULT_PROMPT;
    fpsInput.value       = Number(s.fps) > 0 ? String(s.fps) : '1';
    mediaResSelect.value = s.mediaRes || 'default';
  }

  function persistModal() {
    const s = loadSettings();
    s.apiKey    = apiKeyInput.value.trim();
    s.modelName = modelNameInput.value.trim() || DEFAULT_MODEL;
    s.prompt    = promptInput.value.trim()    || DEFAULT_PROMPT;
    s.fps       = parseFloat(fpsInput.value) || 1;
    s.mediaRes  = mediaResSelect.value || 'default';
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
    tabNote.classList.toggle('is-active', isNote);
    tabNote.setAttribute('aria-selected', String(isNote));
    tabMindmap.classList.toggle('is-active', !isNote);
    tabMindmap.setAttribute('aria-selected', String(!isNote));
    panelNote.classList.toggle('is-active', isNote);
    panelMindmap.classList.toggle('is-active', !isNote);

    // 分頁剛顯示時容器尺寸才正確，延遲 fit 避免在 display:none 下建立導致空白
    if (!isNote && markmapInstance) {
      requestAnimationFrame(() => {
        markmapInstance.fit();
        requestAnimationFrame(() => markmapInstance.fit());
      });
    }
  }

  tabNote.addEventListener('click', () => activateTab('note'));
  tabMindmap.addEventListener('click', () => activateTab('mindmap'));

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
    resultLoading.style.display     = state === 'loading'     ? '' : 'none';
    resultError.style.display       = state === 'error'       ? '' : 'none';
    resultContent.style.display     = state === 'content'     ? '' : 'none';
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
      .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
      .replace(/^# (.+)$/gm,   '<h1>$1</h1>');

    // Bold / italic
    html = html
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,     '<em>$1</em>');

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

  // ── API call ───────────────────────────────────────────────────────────────
  async function analyzeVideo(url) {
    const s = loadSettings();

    if (!s.apiKey) {
      showError('尚未設定 API 金鑰，請點擊右上角「設定」按鈕填入。');
      return;
    }

    const model  = s.modelName || DEFAULT_MODEL;
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

    if (!url.includes('youtube.com/watch') && !url.includes('youtu.be/')) {
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

  // ── Init ───────────────────────────────────────────────────────────────────
  showState('placeholder');
  (function initFpsMediaFromStorage() {
    const st = loadSettings();
    if (fpsInput && Number(st.fps) > 0) fpsInput.value = String(st.fps);
    if (mediaResSelect && st.mediaRes) mediaResSelect.value = st.mediaRes;
  })();
})();
