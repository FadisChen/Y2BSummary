document.addEventListener('DOMContentLoaded', () => {
    // Elements
    const videoUrlInput = document.getElementById('video-url');
    const promptInput = document.getElementById('prompt');
    const tokenCountSpan = document.getElementById('token-count');
    const tokenWarning = document.getElementById('token-warning');
    const tokenCapSpan = document.getElementById('token-cap');
    const analysisForm = document.getElementById('analysis-form');
    const submitBtn = document.getElementById('submit-btn');
    const resultDisplay = document.getElementById('result-display');
    const selectedRange = document.getElementById('selected-range');

    // Settings modal elements
    const refreshBtn = document.getElementById('refresh-btn');
    const settingsBtn = document.getElementById('settings-btn');
    const modal = document.getElementById('settings-modal');
    const modalClose = document.getElementById('modal-close');
    const modalCancel = document.getElementById('modal-cancel');
    const modalSave = document.getElementById('modal-save');
    const apiKeyInput = document.getElementById('api-key');
    const fpsInput = document.getElementById('fps');
    const mediaResSelect = document.getElementById('media-res');
    const rangeStart = document.getElementById('range-start');
    const rangeEnd = document.getElementById('range-end');
    const startLabel = document.getElementById('start-label');
    const endLabel = document.getElementById('end-label');

    // Constants
    const TOKEN_CAP = 1048576;
    tokenCapSpan.textContent = TOKEN_CAP.toLocaleString();

    // Utils
    const formatMMSS = (sec) => {
        const s = Math.max(0, Math.floor(Number(sec) || 0));
        const mm = String(Math.floor(s / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        return `${mm}:${ss}`;
    };

    // Markdown to HTML converter
    const markdownToHtml = (markdown) => {
        if (!markdown || typeof markdown !== 'string') return '';
        
        let html = markdown
            // 代碼塊 (```code```)
            .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
            // 行內代碼 (`code`)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            // 標題
            .replace(/^### (.*$)/gm, '<h3>$1</h3>')
            .replace(/^## (.*$)/gm, '<h2>$1</h2>')
            .replace(/^# (.*$)/gm, '<h1>$1</h1>')
            // 粗體
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            // 斜體
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            // 無序列表
            .replace(/^- (.*$)/gm, '<li>$1</li>')
            // 有序列表
            .replace(/^\d+\. (.*$)/gm, '<li>$1</li>')
            // 換行
            .replace(/\n/g, '<br>');

        // 包裝連續的 <li> 標籤
        html = html.replace(/(<li>.*?<\/li>)(<br>)*(<li>.*?<\/li>)/g, (match, ...groups) => {
            // 找到連續的 li 標籤並包裝在 ul 中
            return match;
        });

        // 更好的列表處理
        html = html.replace(/(<li>.*?<\/li>(<br>)*)+/g, (match) => {
            const items = match.replace(/<br>/g, '');
            return `<ul>${items}</ul>`;
        });

        return html;
    };

    const updateRangeLabels = () => {
        startLabel.textContent = formatMMSS(rangeStart.value);
        endLabel.textContent = formatMMSS(rangeEnd.value);
        selectedRange.textContent = `${formatMMSS(rangeStart.value)} - ${formatMMSS(rangeEnd.value)}`;
        // 更新區間軌背景顏色
        const track = document.getElementById('range-track');
        if (track) {
            const min = Number(rangeStart.min) || 0;
            const max = Number(rangeStart.max) || 0;
            const start = Math.min(Number(rangeStart.value), Number(rangeEnd.value));
            const end = Math.max(Number(rangeStart.value), Number(rangeEnd.value));
            const startPct = max > min ? ((start - min) / (max - min)) * 100 : 0;
            const endPct = max > min ? ((end - min) / (max - min)) * 100 : 100;
            // 深色主題：未選區為深灰，選取區以高對比藍色強調
            track.style.background = `linear-gradient(90deg, #3c4043 0%, #3c4043 ${startPct}%, #8ab4f8 ${startPct}%, #8ab4f8 ${endPct}%, #3c4043 ${endPct}%, #3c4043 100%)`;
        }
    };

    const clampRanges = () => {
        const start = Number(rangeStart.value);
        const end = Number(rangeEnd.value);
        if (start > end) {
            // Keep 1s gap minimal by snapping the other handle
            if (document.activeElement === rangeStart) {
                rangeEnd.value = start;
            } else {
                rangeStart.value = end;
            }
        }
    };

    // Default prompt
    if (!promptInput.value) {
        promptInput.value = '請提供：\n1. 影片主要內容摘要\n2. 關鍵觀點和重要資訊\n3. 主要結論或要點\n4. 如果有教學內容，請列出主要步驟\n\n請用繁體中文回答，並保持內容簡潔明瞭。';
    }

    // 1) Seed URL from active tab (still editable)
    chrome.runtime.sendMessage({ type: 'GET_TAB_URL' }, (response) => {
        if (response && response.url) {
            videoUrlInput.value = response.url;
        }
        calculateTokens();
    });

    // Recalculate tokens and try re-fetch duration when URL changes
    let urlChangeTimer;
    videoUrlInput.addEventListener('input', () => {
        calculateTokens();
        clearTimeout(urlChangeTimer);
        urlChangeTimer = setTimeout(() => {
            if (videoUrlInput.value.includes('youtube.com/watch')) {
                initDuration();
            }
        }, 500);
    });

    // 2) Load saved settings
    const loadSettings = () => new Promise((resolve) => {
        chrome.storage.local.get(['geminiApiKey', 'fps', 'mediaRes'], (store) => {
            if (store.geminiApiKey) apiKeyInput.value = store.geminiApiKey;
            fpsInput.value = Number(store.fps) > 0 ? String(store.fps) : '1.0';
            mediaResSelect.value = store.mediaRes || 'default';
            resolve();
        });
    });

    const saveSettings = () => new Promise((resolve) => {
        const settings = {
            geminiApiKey: apiKeyInput.value.trim(),
            fps: parseFloat(fpsInput.value) || 1,
            mediaRes: mediaResSelect.value || 'default'
        };
        chrome.storage.local.set(settings, resolve);
    });

    // 3) Get video duration from the current page and init sliders
    const initDuration = () => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_VIDEO_METADATA' }, (res) => {
            const duration = Number(res?.duration) || 60; // fallback 60s
            rangeStart.min = '0';
            rangeStart.max = String(duration);
            rangeEnd.min = '0';
            rangeEnd.max = String(duration);
            rangeStart.value = '0';
            rangeEnd.value = String(duration);
            updateRangeLabels();
            resolve(duration);
        });
    });

    // 4) Token calculation
    const calculateTokens = () => {
        const startTime = Number(rangeStart.value) || 0;
        const endTime = Number(rangeEnd.value) || 0;
        const fps = parseFloat(fpsInput.value) || 0;
        const promptText = promptInput.value || '';
        const mediaRes = mediaResSelect?.value || 'default';

        if (startTime < 0 || endTime <= startTime || fps <= 0) {
            tokenCountSpan.textContent = '0';
            tokenWarning.style.display = 'none';
            submitBtn.disabled = true;
            return 0;
        }

        const duration = endTime - startTime;
        const tokensPerFrame = mediaRes === 'low' ? 66 : 258;
        const videoTokensPerSecond = tokensPerFrame * fps;
        const audioTokensPerSecond = 32;
        const totalMediaTokens = duration * (videoTokensPerSecond + audioTokensPerSecond);
        const textTokens = Math.ceil(promptText.length * 1.5);
        const totalTokens = Math.round(totalMediaTokens + textTokens);
        tokenCountSpan.textContent = totalTokens.toLocaleString();

        if (totalTokens > TOKEN_CAP) {
            tokenWarning.style.display = '';
            submitBtn.disabled = true;
        } else {
            tokenWarning.style.display = 'none';
            submitBtn.disabled = false;
        }
        return totalTokens;
    };

    // 5) Wire interactions
    refreshBtn.addEventListener('click', () => {
        // 重新取得目前網址
        chrome.runtime.sendMessage({ type: 'GET_TAB_URL' }, (response) => {
            if (response && response.url) {
                videoUrlInput.value = response.url;
                // 如果是YouTube網址，重新初始化範圍和計算tokens
                if (response.url.includes('youtube.com/watch')) {
                    initDuration().then(() => {
                        calculateTokens();
                    });
                } else {
                    calculateTokens();
                }
            }
        });
    });

    settingsBtn.addEventListener('click', async () => {
        await loadSettings();
        modal.classList.remove('hidden');
    });
    const closeModal = () => modal.classList.add('hidden');
    modalClose.addEventListener('click', closeModal);
    modalCancel.addEventListener('click', closeModal);
    modalSave.addEventListener('click', async () => {
        await saveSettings();
        closeModal();
        calculateTokens();
    });

    ;['input', 'change'].forEach(evt => {
        rangeStart.addEventListener(evt, () => { clampRanges(); updateRangeLabels(); calculateTokens(); });
        rangeEnd.addEventListener(evt, () => { clampRanges(); updateRangeLabels(); calculateTokens(); });
        fpsInput.addEventListener(evt, calculateTokens);
        mediaResSelect.addEventListener(evt, calculateTokens);
    });
    promptInput.addEventListener('change', calculateTokens);
    promptInput.addEventListener('blur', calculateTokens);
    // 6) Submit
    analysisForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const total = calculateTokens();
        if (total > TOKEN_CAP) {
            resultDisplay.textContent = '錯誤：預估 Tokens 超過上限。';
            return;
        }

        const requestData = {
            url: videoUrlInput.value,
            prompt: promptInput.value,
            startTime: Number(rangeStart.value),
            endTime: Number(rangeEnd.value),
            fps: parseFloat(fpsInput.value)
        };

        if (!requestData.url.includes('youtube.com/watch')) {
            resultDisplay.textContent = '錯誤：請提供有效的 YouTube 影片網址。';
            return;
        }
        if (requestData.endTime <= requestData.startTime) {
            resultDisplay.textContent = '錯誤：結束時間必須大於起始時間。';
            return;
        }
        if (!requestData.prompt) {
            resultDisplay.textContent = '錯誤：請輸入 Prompt。';
            return;
        }

        chrome.storage.local.get(['geminiApiKey'], (store) => {
            if (!store.geminiApiKey) {
                resultDisplay.textContent = '錯誤：尚未設定 API 金鑰（點擊右上角⚙️設定）。';
                return;
            }

            submitBtn.disabled = true;
            resultDisplay.textContent = '分析中，請稍候...';
            resultDisplay.classList.add('loading');

            chrome.runtime.sendMessage({ type: 'ANALYZE_VIDEO', data: requestData }, (response) => {
                if (response?.error) {
                    resultDisplay.textContent = `錯誤: ${response.error}`;
                } else {
                    const markdownContent = response.data || '無內容';
                    const htmlContent = markdownToHtml(markdownContent);
                    resultDisplay.innerHTML = htmlContent;
                }
                submitBtn.disabled = false;
                resultDisplay.classList.remove('loading');
            });
        });
    });

    // Initialize
    Promise.all([loadSettings(), initDuration()]).then(() => {
        updateRangeLabels();
        calculateTokens();
    });
});
