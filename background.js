const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// --- Side Panel Logic ---
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// --- Message Listener ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_TAB_URL') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0] && tabs[0].url.includes("youtube.com/watch")) {
                sendResponse({ url: tabs[0].url });
            } else {
                sendResponse({ url: null });
            }
        });
        return true; // Indicates that the response is sent asynchronously
    }
    
    if (message.type === 'ANALYZE_VIDEO') {
        handleAnalysisRequest(message.data, sendResponse);
        return true; // Indicates that the response is sent asynchronously
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

    // 取得 API 金鑰
    chrome.storage.local.get(['geminiApiKey'], async (store) => {
        const apiKey = store.geminiApiKey;
        if (!apiKey) {
            sendResponse({ error: '尚未設定 API 金鑰，請先於面板儲存您的金鑰。' });
            return;
        }
        const clampNonNegative = (n) => (Number.isFinite(n) && n > 0 ? n : 0);
        const startSec = clampNonNegative(startTime);
        const endSec = Number.isFinite(endTime) && endTime > startSec ? endTime : 0;
        const fpsVal = Number.isFinite(fps) && fps > 0 ? fps : undefined;

        const requestBody = {
            contents: [
                {
                    parts: [
                        {
                            file_data: {
                                file_uri: url
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
            const response = await fetch(GEMINI_API_URL, {
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
