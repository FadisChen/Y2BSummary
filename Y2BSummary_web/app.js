(() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const STORAGE_KEY = 'y2bsummary_settings';
  const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
  const PROMPT_VERSION = 1;
  const DEFAULT_PROMPT = `請用繁體中文，以 Markdown 整理影片，內容保持精簡，但保留理解主題所需的脈絡。只根據影片實際表達或展示的內容，不從標題或外部常識推測；影片沒有說明的資訊不要自行補充。依影片內容使用以下結構，不適用的小節可省略：

1. **影片主旨**：用一兩句說明主題與核心論點。
2. **內容摘要**：按影片脈絡整理主要內容。
3. **關鍵觀點與例證**：列出重要主張、理由、數據或例子，區分講者說法與影片實際展示的佐證。
4. **結論與可行動重點**：整理影片結論；若有具體建議，列出可採取的行動。
5. **教學步驟**：若影片包含教學，整理必要前置條件、步驟、檢查點與提及的常見問題；標明哪些步驟有展示、哪些只有口頭提及，不推測缺漏步驟。

若能可靠辨識相關時間點，附上約略時間；無法確認時省略，不要猜測。`;

  function buildVideoPrompt(userSummaryInstruction) {
    const summaryReq = (userSummaryInstruction || '').trim() || DEFAULT_PROMPT;
    return `請觀看影片，並依照以下要求撰寫摘要筆記（使用 Markdown，繁體中文）：\n${summaryReq}`;
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

  function migratePromptSettings() {
    const s = loadSettings();
    if (s.promptVersion === PROMPT_VERSION) return;
    s.prompt = DEFAULT_PROMPT;
    s.promptVersion = PROMPT_VERSION;
    saveSettings(s);
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

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastTimer = null;

  function showToast(message, duration = 2200) {
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), duration);
  }

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

  // ── API call ───────────────────────────────────────────────────────────────
  async function analyzeVideo(url) {
    const s = loadSettings();

    if (!s.apiKey) {
      showError('尚未設定 API 金鑰，請點擊右上角「設定」按鈕填入。');
      return;
    }

    // 移除網址中&符號後的內容
    url = url.split('&')[0];

    const model = s.modelName || DEFAULT_MODEL;
    const prompt = buildVideoPrompt(s.prompt || DEFAULT_PROMPT);
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

      resultContent.innerHTML = markdownToHtml(raw.trim());
      showState('content');
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
  migratePromptSettings();
  showState('placeholder');
  (function initFpsMediaFromStorage() {
    const st = loadSettings();
    if (fpsInput && Number(st.fps) > 0) fpsInput.value = String(st.fps);
    if (mediaResSelect && st.mediaRes) mediaResSelect.value = st.mediaRes;
  })();
})();
