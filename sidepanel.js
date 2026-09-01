document.addEventListener('DOMContentLoaded', () => {
    const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
    const MAX_CHAT_SEGMENTS = 180;
    const MAX_CHAT_REFERENCES = 5;
    const DEFAULT_SUMMARY_PROMPT = '請提供：\n1. 影片主要內容筆記\n2. 關鍵觀點和重要資訊\n3. 主要結論或要點\n4. 如果有教學內容，請列出主要步驟\n\n請用繁體中文回答，並保持內容簡潔明瞭。';
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
    const geminiModelInput = document.getElementById('gemini-model');
    const fpsInput = document.getElementById('fps');
    const mediaResSelect = document.getElementById('media-res');
    const rangeStart = document.getElementById('range-start');
    const rangeEnd = document.getElementById('range-end');
    const startLabel = document.getElementById('start-label');
    const endLabel = document.getElementById('end-label');
    const chatStage = document.getElementById('chat-stage');
    const chatEmpty = document.getElementById('chat-empty');
    const chatMessages = document.getElementById('chat-messages');
    const chatIndexStatus = document.getElementById('chat-index-status');
    const chatStatus = document.getElementById('chat-status');
    const chatError = document.getElementById('chat-error');
    const chatInput = document.getElementById('chat-input');
    const chatForm = document.getElementById('chat-form');
    const chatResetBtn = document.getElementById('chat-reset-btn');
    const tabSummary = document.getElementById('tab-summary');
    const tabChat = document.getElementById('tab-chat');
    const panelSummary = document.getElementById('panel-summary');
    const panelChat = document.getElementById('panel-chat');

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

    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const parseYouTubeUrl = (rawUrl) => {
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
    };

    const normalizeModelName = (value) => {
        const model = typeof value === 'string' ? value.trim() : '';
        return model.replace(/^models\//i, '').trim() || DEFAULT_MODEL;
    };

    const extractInteractionText = (result) => {
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
    };

    const parseJsonPayload = (raw) => {
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
    };

    const cleanChatText = (value, fallback = '') =>
        typeof value === 'string' ? value.trim() : fallback;

    const normalizeVideoIndex = (rawSegments) => {
        const candidates = [];

        (Array.isArray(rawSegments) ? rawSegments : []).forEach((raw, sourceIndex) => {
            if (!raw || typeof raw !== 'object' || raw.start_seconds == null || raw.end_seconds == null) return;

            const start = Number(raw.start_seconds);
            const end = Number(raw.end_seconds);
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return;

            candidates.push({
                sourceId: cleanChatText(raw.id, `__missing_${sourceIndex}`),
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
    };

    const normalizeChatReferences = (rawReferences, indexInfo) => {
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
    };

    const parseInitialChatResponse = (raw) => {
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
    };

    const parseFollowupChatResponse = (raw) => {
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
    };

    const formatChatTime = (seconds) => {
        const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const remainder = totalSeconds % 60;
        const paddedMinutes = String(minutes).padStart(2, '0');
        const paddedSeconds = String(remainder).padStart(2, '0');
        return hours > 0
            ? `${hours}:${paddedMinutes}:${paddedSeconds}`
            : `${paddedMinutes}:${paddedSeconds}`;
    };

    const buildYouTubeTimestampUrl = (videoId, startSeconds) => {
        const url = new URL('https://www.youtube.com/watch');
        url.searchParams.set('v', videoId);
        url.searchParams.set('t', `${Math.max(0, Math.floor(Number(startSeconds) || 0))}s`);
        return url.toString();
    };

    const buildInitialChatPrompt = (question) => `請先完整觀看這部影片，再回答使用者問題。請同時建立影片的語意時間索引：依主題或事件變化切分，目標每段約 30 到 60 秒，依原始時間順序排列，最多 180 段。每段都要有唯一且依序的 id（s001、s002、…）、開始與結束秒數、簡短標題、繁體中文摘要及關鍵字。

使用者問題：
${question}

回答規則：answer 放繁體中文回答；references 只能引用 segments 中確實與問題相關的 segment_id，無相關片段時使用空陣列。不要引用影片外的資料，也不要自行產生影片不存在的時間。`;

    const buildFollowupChatPrompt = (question) => {
        const compactIndex = chatState.segments.map(segment => ({
            id: segment.id,
            start_seconds: segment.start_seconds,
            end_seconds: segment.end_seconds,
            title: segment.title,
            summary: segment.summary,
            keywords: segment.keywords,
        }));

        return `原始影片已在上一輪提供。請根據原始影片及下列已驗證的時間索引回答新的問題。references 只能使用索引中的 segment_id，不要自行改寫時間；沒有直接相關片段時使用空陣列。

影片時間索引：
${JSON.stringify(compactIndex)}

使用者問題：
${question}`;
    };

    // Markdown to HTML converter
    const markdownToHtml = (markdown) => {
        if (!markdown || typeof markdown !== 'string') return '';

        let html = escapeHtml(markdown)
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
        promptInput.value = '請提供：\n1. 影片主要內容筆記\n2. 關鍵觀點和重要資訊\n3. 主要結論或要點\n4. 如果有教學內容，請列出主要步驟\n\n請用繁體中文回答，並保持內容簡潔明瞭。';
    }

    // 1) Seed URL from active tab (still editable)
    chrome.runtime.sendMessage({ type: 'GET_TAB_URL' }, (response) => {
        if (response && response.url) {
            videoUrlInput.value = parseYouTubeUrl(response.url)?.canonicalUrl || response.url;
        }
        calculateTokens();
    });

    // Recalculate tokens and try re-fetch duration when URL changes
    let urlChangeTimer;
    videoUrlInput.addEventListener('input', () => {
        calculateTokens();
        const parsedUrl = parseYouTubeUrl(videoUrlInput.value);
        if (chatState.videoId && (!parsedUrl || parsedUrl.videoId !== chatState.videoId)) {
            resetChatConversation();
        }
        clearTimeout(urlChangeTimer);
        urlChangeTimer = setTimeout(() => {
            if (parsedUrl) {
                initDuration();
            }
        }, 500);
    });

    // 2) Load saved settings
    const loadSettings = () => new Promise((resolve) => {
        chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'fps', 'mediaRes'], (store) => {
            if (store.geminiApiKey) apiKeyInput.value = store.geminiApiKey;
            geminiModelInput.value = store.geminiModel || 'gemini-3.5-flash-lite';
            fpsInput.value = Number(store.fps) > 0 ? String(store.fps) : '1.0';
            mediaResSelect.value = store.mediaRes || 'default';
            resolve();
        });
    });

    const saveSettings = () => new Promise((resolve) => {
        const settings = {
            geminiApiKey: apiKeyInput.value.trim(),
            geminiModel: geminiModelInput.value.trim() || 'gemini-3.5-flash-lite',
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
            tokenCountSpan.style.color = '#d93025'; // Set color to red if over cap
            tokenWarning.style.display = '';
            submitBtn.disabled = true;
        } else {
            tokenCountSpan.style.color = '#a4a5a7'; // Set color to white if within cap
            tokenWarning.style.display = 'none';
            submitBtn.disabled = false;
        }
        return totalTokens;
    };

    const updateChatIndexStatus = () => {
        chatIndexStatus.textContent = chatState.segments.length
            ? `已建立 ${chatState.segments.length} 段 AI 時間索引 · 時間可能有誤差`
            : '尚未建立影片時間索引';
    };

    const createChatReferences = (references) => {
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
            time.textContent = `${formatChatTime(segment.start_seconds)}–${formatChatTime(segment.end_seconds)}`;

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
    };

    const createChatMessage = (item) => {
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
    };

    const renderChat = () => {
        const hasMessages = chatState.messages.length > 0;
        chatEmpty.style.display = hasMessages ? 'none' : '';
        chatMessages.style.display = hasMessages ? 'flex' : 'none';
        chatMessages.replaceChildren();

        chatState.messages.forEach((item) => {
            chatMessages.appendChild(createChatMessage(item));
        });

        if (hasMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
        updateChatIndexStatus();
    };

    const showChatError = (message) => {
        chatError.textContent = message;
        chatError.hidden = false;
    };

    const clearChatError = () => {
        chatError.textContent = '';
        chatError.hidden = true;
    };

    const setChatLoading = (isLoading, message = '') => {
        chatState.loading = isLoading;
        chatStage.setAttribute('aria-busy', String(isLoading));
        chatInput.disabled = isLoading;
        chatResetBtn.disabled = isLoading;
        chatStatus.textContent = isLoading ? message : '';
        chatStatus.classList.toggle('is-loading', isLoading);
    };

    const resetChatConversation = () => {
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
    };

    const sendRuntimeMessage = (message) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
            }
            if (!response || response.error) {
                reject(new Error(response?.error || 'Extension 背景服務沒有回應。'));
                return;
            }
            resolve(response);
        });
    });

    const getChatSettings = () => new Promise((resolve) => {
        chrome.storage.local.get(['geminiApiKey', 'geminiModel'], resolve);
    });

    const sendChatMessage = async () => {
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

        const settings = await getChatSettings();
        if (!settings.geminiApiKey) {
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
            const model = chatState.modelName || normalizeModelName(settings.geminiModel);
            const response = await sendRuntimeMessage({
                type: 'CHAT_INTERACTION',
                data: {
                    mode: isFirstMessage ? 'initial' : 'followup',
                    model,
                    videoUrl: chatState.canonicalUrl,
                    question,
                    previousInteractionId: chatState.interactionId,
                    segments: chatState.segments,
                },
            });

            if (requestSerial !== chatState.requestSerial) return;

            const result = response.data;
            const raw = extractInteractionText(result);
            if (!raw) throw new Error('API 回應中找不到有效的文字內容，請確認影片網址是否正確。');
            if (!result?.id) throw new Error('API 回應缺少對話識別碼，請重試。');

            if (isFirstMessage) {
                const parsed = parseInitialChatResponse(raw);
                chatState.segments = parsed.segments;
                chatState.modelName = response.modelName || model;
                chatState.interactionId = result.id;
                chatState.messages.push({ role: 'assistant', answer: parsed.answer, references: parsed.references });
            } else {
                const parsed = parseFollowupChatResponse(raw);
                chatState.interactionId = result.id;
                chatState.messages.push({ role: 'assistant', answer: parsed.answer, references: parsed.references });
            }

            renderChat();
        } catch (error) {
            if (requestSerial === chatState.requestSerial) showChatError(error.message || '對話請求失敗，請稍後再試。');
        } finally {
            if (requestSerial === chatState.requestSerial) setChatLoading(false);
        }
    };

    const activateTab = (tabName, shouldFocusChat = true) => {
        const isSummary = tabName === 'summary';

        tabSummary.classList.toggle('is-active', isSummary);
        tabSummary.setAttribute('aria-selected', String(isSummary));
        tabSummary.tabIndex = isSummary ? 0 : -1;
        panelSummary.classList.toggle('is-active', isSummary);
        panelSummary.hidden = !isSummary;

        tabChat.classList.toggle('is-active', !isSummary);
        tabChat.setAttribute('aria-selected', String(!isSummary));
        tabChat.tabIndex = isSummary ? -1 : 0;
        panelChat.classList.toggle('is-active', !isSummary);
        panelChat.hidden = isSummary;

        if (!isSummary && shouldFocusChat && !chatState.loading) {
            requestAnimationFrame(() => chatInput.focus());
        }
    };

    const tabButtons = [tabSummary, tabChat];
    tabButtons.forEach((tabButton, index) => {
        tabButton.addEventListener('click', () => {
            activateTab(index === 0 ? 'summary' : 'chat');
        });
        tabButton.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const nextIndex = event.key === 'ArrowRight'
                ? (index + 1) % tabButtons.length
                : (index - 1 + tabButtons.length) % tabButtons.length;
            tabButtons[nextIndex].focus();
            activateTab(nextIndex === 0 ? 'summary' : 'chat', false);
        });
    });

    // 5) Wire interactions
    refreshBtn.addEventListener('click', () => {
        // 重新取得目前網址
        chrome.runtime.sendMessage({ type: 'GET_TAB_URL' }, (response) => {
            if (response && response.url) {
                const parsedUrl = parseYouTubeUrl(response.url);
                if (chatState.videoId && (!parsedUrl || parsedUrl.videoId !== chatState.videoId)) {
                    resetChatConversation();
                }
                videoUrlInput.value = parsedUrl?.canonicalUrl || response.url;
                // 如果是YouTube網址，重新初始化範圍和計算tokens
                if (parsedUrl) {
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

        const parsedUrl = parseYouTubeUrl(videoUrlInput.value);
        const requestData = {
            url: parsedUrl?.canonicalUrl || videoUrlInput.value,
            prompt: promptInput.value,
            startTime: Number(rangeStart.value),
            endTime: Number(rangeEnd.value),
            fps: parseFloat(fpsInput.value)
        };

        if (!parsedUrl) {
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

        resetChatConversation();

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

    chatForm.addEventListener('submit', (event) => {
        event.preventDefault();
        sendChatMessage();
    });

    chatInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        chatForm.requestSubmit();
    });

    chatResetBtn.addEventListener('click', () => {
        if (chatState.loading) return;
        resetChatConversation();
        chatInput.focus();
    });

    // Initialize
    activateTab('summary', false);
    Promise.all([loadSettings(), initDuration()]).then(() => {
        updateRangeLabels();
        calculateTokens();
        renderChat();
    });
});
