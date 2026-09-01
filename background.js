const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

const normalizeModelName = (model) => {
    const value = typeof model === 'string' ? model.trim() : '';
    return value.replace(/^models\//i, '').trim() || DEFAULT_GEMINI_MODEL;
};

const getGeminiApiUrl = (model) => {
    const modelName = normalizeModelName(model);
    return `${GEMINI_API_BASE}${modelName}:generateContent`;
};

const parseYouTubeVideoUrl = (rawUrl) => {
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

const buildInitialChatPrompt = (question) => `請先完整觀看這部影片，再回答使用者問題。請同時建立影片的語意時間索引：依主題或事件變化切分，目標每段約 30 到 60 秒，依原始時間順序排列，最多 180 段。每段都要有唯一且依序的 id（s001、s002、…）、開始與結束秒數、簡短標題、繁體中文摘要及關鍵字。

使用者問題：
${question}

回答規則：answer 放繁體中文回答；references 只能引用 segments 中確實與問題相關的 segment_id，無相關片段時使用空陣列。不要引用影片外的資料，也不要自行產生影片不存在的時間。`;

const buildFollowupChatPrompt = (question, segments) => {
    const compactIndex = (Array.isArray(segments) ? segments : []).map((segment) => ({
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

// --- Side Panel Logic ---
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// --- Message Listener ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_TAB_URL') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const parsedUrl = parseYouTubeVideoUrl(tabs[0]?.url);
            sendResponse({ url: parsedUrl?.canonicalUrl || null });
        });
        return true; // Indicates that the response is sent asynchronously
    }
    
    if (message.type === 'ANALYZE_VIDEO') {
        handleAnalysisRequest(message.data, sendResponse);
        return true; // Indicates that the response is sent asynchronously
    }

    if (message.type === 'CHAT_INTERACTION') {
        handleChatInteractionRequest(message.data, sendResponse);
        return true;
    }

    if (message.type === 'GET_VIDEO_METADATA') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab?.id) {
                sendResponse({ duration: null });
                return;
            }
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    const video = document.querySelector('video');
                    if (video && Number.isFinite(video.duration)) {
                        return { duration: Math.floor(video.duration) };
                    }
                    return { duration: null };
                }
            }, (results) => {
                const result = Array.isArray(results) && results[0]?.result;
                sendResponse(result || { duration: null });
            });
        });
        return true; // async
    }
});

async function handleAnalysisRequest(data, sendResponse) {
    const { url, prompt, startTime, endTime, fps } = data;

    // 取得 API 金鑰和 Model
    chrome.storage.local.get(['geminiApiKey', 'geminiModel'], async (store) => {
        const apiKey = store.geminiApiKey;
        const geminiModel = store.geminiModel || DEFAULT_GEMINI_MODEL;
        if (!apiKey) {
            sendResponse({ error: '尚未設定 API 金鑰，請先於面板儲存您的金鑰。' });
            return;
        }
        const clampNonNegative = (n) => (Number.isFinite(n) && n > 0 ? n : 0);
        const startSec = clampNonNegative(startTime);
        const endSec = Number.isFinite(endTime) && endTime > startSec ? endTime : 0;
        const fpsVal = Number.isFinite(fps) && fps > 0 ? fps : undefined;

        const parsedUrl = parseYouTubeVideoUrl(url);
        if (!parsedUrl) {
            sendResponse({ error: '請提供有效的 YouTube 影片網址。' });
            return;
        }

        const requestBody = {
            contents: [
                {
                    parts: [
                        {
                            file_data: {
                                file_uri: parsedUrl.canonicalUrl
                            },
                            video_metadata: {
                                ...(startSec ? { start_offset: `${startSec}s` } : {}),
                                ...(endSec ? { end_offset: `${endSec}s` } : {}),
                                ...(fpsVal ? { fps: fpsVal } : {})
                            }
                        },
                        { text: prompt }
                    ]
                }
            ],
            systemInstruction: {
                role: 'system',
                parts: [{
                    text: '請以繁體中文回覆。'
                }]
            }
        };

        try {
            const response = await fetch(getGeminiApiUrl(geminiModel), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                let errorBody = {};
                try { errorBody = await response.json(); } catch (e) {}
                const msg = errorBody?.error?.message || '未知錯誤';
                throw new Error(`API 請求失敗，狀態碼: ${response.status}. ${msg}`);
            }

            const result = await response.json();

            // 穩健地從 candidates 內找出第一個文字部分
            const text = (() => {
                if (!result?.candidates?.length) return '';
                for (const cand of result.candidates) {
                    const parts = cand?.content?.parts || [];
                    for (const p of parts) {
                        if (typeof p.text === 'string' && p.text.trim()) return p.text;
                    }
                }
                return '';
            })();

            if (text) {
                sendResponse({ data: text });
            } else {
                sendResponse({ error: 'API 回應中找不到有效的文字內容。' });
            }
        } catch (error) {
            console.error('Gemini API Error:', error);
            sendResponse({ error: error.message });
        }
    });
}

async function requestInteraction(requestBody, apiKey) {
    const response = await fetch(GEMINI_INTERACTIONS_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        let errorBody = {};
        try { errorBody = await response.json(); } catch (e) {}
        const apiMessage = errorBody?.error?.message || '未知錯誤';
        const details = Array.isArray(errorBody?.error?.details)
            ? errorBody.error.details
                .flatMap(detail => Array.isArray(detail?.fieldViolations) ? detail.fieldViolations : [])
                .map(violation => violation?.description)
                .filter(Boolean)
            : [];
        const detailMessage = details.length ? `（${[...new Set(details)].join('；')}）` : '';
        const error = new Error(`API 請求失敗（狀態碼 ${response.status}）：${apiMessage}${detailMessage}`);
        error.status = response.status;
        error.apiMessage = apiMessage;
        throw error;
    }

    return response.json();
}

const isInvalidArgumentError = (error) =>
    error?.status === 400 && /invalid argument/i.test(error.apiMessage || error.message || '');

async function requestInteractionWithCompatibilityFallback(requestBody, apiKey) {
    try {
        return {
            result: await requestInteraction(requestBody, apiKey),
            modelName: requestBody.model,
        };
    } catch (error) {
        if (!isInvalidArgumentError(error) || requestBody.model === DEFAULT_GEMINI_MODEL) throw error;

        return {
            result: await requestInteraction({ ...requestBody, model: DEFAULT_GEMINI_MODEL }, apiKey),
            modelName: DEFAULT_GEMINI_MODEL,
        };
    }
}

function handleChatInteractionRequest(data, sendResponse) {
    chrome.storage.local.get(['geminiApiKey', 'geminiModel'], async (store) => {
        try {
            const apiKey = store.geminiApiKey;
            if (!apiKey) {
                sendResponse({ error: '尚未設定 API 金鑰，請先於面板設定中儲存您的金鑰。' });
                return;
            }

            const request = data && typeof data === 'object' ? data : {};
            const parsedUrl = parseYouTubeVideoUrl(request.videoUrl);
            const question = typeof request.question === 'string' ? request.question.trim() : '';
            if (!parsedUrl || !question) {
                sendResponse({ error: '請提供有效的 YouTube 影片網址與問題。' });
                return;
            }

            const model = normalizeModelName(request.model || store.geminiModel);
            const hasPreviousInteraction = typeof request.previousInteractionId === 'string'
                && request.previousInteractionId.trim();
            const isFollowup = request.mode === 'followup' && hasPreviousInteraction;
            const requestBody = isFollowup
                ? {
                    model,
                    store: true,
                    previous_interaction_id: request.previousInteractionId,
                    system_instruction: CHAT_SYSTEM_INSTRUCTION,
                    input: buildFollowupChatPrompt(question, request.segments),
                    response_format: CHAT_FOLLOWUP_RESPONSE_FORMAT,
                }
                : {
                    model,
                    store: true,
                    system_instruction: CHAT_SYSTEM_INSTRUCTION,
                    input: [
                        { type: 'text', text: buildInitialChatPrompt(question) },
                        { type: 'video', uri: parsedUrl.canonicalUrl },
                    ],
                    response_format: CHAT_INIT_RESPONSE_FORMAT,
                };

            const { result, modelName } = await requestInteractionWithCompatibilityFallback(requestBody, apiKey);
            sendResponse({ data: result, modelName });
        } catch (error) {
            console.error('Gemini Interaction Error:', error);
            sendResponse({ error: error.message || '對話請求失敗，請稍後再試。' });
        }
    });
}
