import {
    extension_prompt_roles,
    extension_prompt_types,
    generateQuietPrompt,
} from '../../../../script.js';

import {
    createNewWorldInfo,
    createWorldInfoEntry,
    loadWorldInfo,
    saveWorldInfo,
    updateWorldInfoList,
} from '../../../world-info.js';

const MODULE_NAME = 'role_memory_forge';
const MODULE_TITLE = 'Role Memory Forge';
const MEMORY_KEY = `${MODULE_NAME}_state`;
const ENTRY_MARK = '[RMF]';
const RAW_ENTRY_COMMENT = `${ENTRY_MARK} 99 JSON_RAW_DO_NOT_EDIT`;
const DASHBOARD_ENTRY_COMMENT = `${ENTRY_MARK} 00 当前记忆总览`;
const RECORDS_ENTRY_COMMENT = `${ENTRY_MARK} 01 每层简记流水`;
const RELATION_ENTRY_COMMENT = `${ENTRY_MARK} 02 可视化关系表`;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    keepAcrossNewChats: false,
    cleanupWhenDisabled: true,
    source: 'st', // st | openai
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    chunkSize: 20,
    megaEvery: 5,
    injectDepth: 4,
    injectMaxChars: 9000,
    recentRecordCount: 8,
    maxRecordsStored: 600,
    maxOutputTokens: 1200,
    temperature: 0.15,
    worldNameTemplate: 'RMF-{{char}}-记忆世界书',
    showToast: true,
    autoProcess: true,
    includeRawJsonEntry: true,
    appendBriefToMessage: true,
    briefFoldTitle: '🧠 本轮记忆简记',
    showFloatingPanel: true,
    relationGraphMaxNodes: 10,
});

function context() {
    return SillyTavern.getContext();
}

function settings() {
    const ctx = context();
    const store = ctx.extensionSettings;
    if (!store[MODULE_NAME]) {
        store[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(store[MODULE_NAME], key)) {
            store[MODULE_NAME][key] = structuredClone(value);
        }
    }
    return store[MODULE_NAME];
}

function saveSettings() {
    context().saveSettingsDebounced?.();
}

function toast(message, type = 'info') {
    if (!settings().showToast) return;
    const fn = toastr?.[type] || toastr?.info;
    fn?.(message, MODULE_TITLE);
}

function log(...args) {
    console.log(`[${MODULE_TITLE}]`, ...args);
}

function warn(...args) {
    console.warn(`[${MODULE_TITLE}]`, ...args);
}

function nowIso() {
    return new Date().toISOString();
}

function stripRmfFoldHtml(input = '') {
    return String(input ?? '')
        .replace(/\n*<!--RMF_BRIEF_START-->[\s\S]*?<!--RMF_BRIEF_END-->\s*/gi, '')
        .replace(/\n*<details\b[^>]*(?:rmf-brief-fold|data-rmf-brief)[\s\S]*?<\/details>\s*/gi, '')
        .trim();
}

function stripHtml(input = '') {
    const div = document.createElement('div');
    div.innerHTML = stripRmfFoldHtml(String(input ?? ''));
    return (div.textContent || div.innerText || stripRmfFoldHtml(String(input ?? '')))
        .replace(/\u200b/g, '')
        .replace(/\s+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

function escapeForHtml(text = '') {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function getCharacterName() {
    const ctx = context();
    const char = ctx.characters?.[ctx.characterId];
    return char?.name || ctx.name2 || '当前角色';
}

function getCharacterKey() {
    const ctx = context();
    const char = ctx.characters?.[ctx.characterId];
    return char?.avatar || char?.name || ctx.groupId || 'unknown';
}

function sanitizeWorldName(name) {
    return String(name || 'RMF-记忆世界书')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

function getWorldName() {
    const s = settings();
    const charName = getCharacterName();
    const chatId = context().chatId || 'chat';
    return sanitizeWorldName(
        s.worldNameTemplate
            .replaceAll('{{char}}', charName)
            .replaceAll('{{chat}}', String(chatId))
    );
}

function createEmptyTracker() {
    return {
        characterStates: {},
        profiles: {},
        relationships: [],
        worldSetting: [],
        inventory: {},
        promises: [],
        currentPlot: '',
        development: '',
        relationTableMarkdown: '| 人物A | 人物B | 关系 | 当前状态 | 证据 |\n|---|---|---|---|---|',
    };
}

function createEmptyState() {
    return {
        version: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        characterKey: getCharacterKey(),
        characterName: getCharacterName(),
        worldName: getWorldName(),
        records: [],
        summaries: [],
        megaSummary: {
            content: '',
            coversRecordId: 0,
            coversSummaryCount: 0,
            updatedAt: '',
        },
        tracker: createEmptyTracker(),
        processedPairs: [],
        lastError: '',
    };
}

function normalizeState(raw) {
    const base = createEmptyState();
    const state = raw && typeof raw === 'object' ? { ...base, ...raw } : base;
    state.records = Array.isArray(state.records) ? state.records : [];
    state.summaries = Array.isArray(state.summaries) ? state.summaries : [];
    state.megaSummary = { ...base.megaSummary, ...(state.megaSummary || {}) };
    state.tracker = { ...base.tracker, ...(state.tracker || {}) };
    state.tracker.characterStates = state.tracker.characterStates || {};
    state.tracker.profiles = state.tracker.profiles || {};
    state.tracker.relationships = Array.isArray(state.tracker.relationships) ? state.tracker.relationships : [];
    state.tracker.worldSetting = Array.isArray(state.tracker.worldSetting) ? state.tracker.worldSetting : [];
    state.tracker.inventory = state.tracker.inventory || {};
    state.tracker.promises = Array.isArray(state.tracker.promises) ? state.tracker.promises : [];
    state.processedPairs = Array.isArray(state.processedPairs) ? state.processedPairs : [];
    state.worldName = state.worldName || getWorldName();
    state.characterName = getCharacterName();
    state.characterKey = getCharacterKey();
    return state;
}

function getState() {
    const ctx = context();
    const meta = ctx.chatMetadata;
    meta[MEMORY_KEY] = normalizeState(meta[MEMORY_KEY]);
    return meta[MEMORY_KEY];
}

async function saveState() {
    const ctx = context();
    const state = getState();
    state.updatedAt = nowIso();
    ctx.chatMetadata[MEMORY_KEY] = state;
    await ctx.saveMetadata?.();
    refreshPromptInjection();
    refreshDashboard();
}

function stateHasContent(state = getState()) {
    return Boolean(
        state.records?.length ||
        state.summaries?.length ||
        state.megaSummary?.content ||
        state.tracker?.currentPlot ||
        state.tracker?.relationships?.length
    );
}

function findGeneratedEntries(data) {
    const entries = data?.entries || {};
    return Object.values(entries).filter((entry) => String(entry.comment || '').startsWith(ENTRY_MARK));
}

async function ensureWorldBook() {
    const state = getState();
    const worldName = state.worldName || getWorldName();
    state.worldName = worldName;
    let data = await loadWorldInfo(worldName);
    if (!data) {
        await createNewWorldInfo(worldName, { interactive: false });
        await updateWorldInfoList();
        data = await loadWorldInfo(worldName);
    }
    if (!data) {
        throw new Error(`无法创建或读取世界书：${worldName}`);
    }
    data.entries ||= {};
    return { worldName, data };
}

function configureEntry(entry, comment, content, order = 100) {
    entry.comment = comment;
    entry.content = content || '';
    entry.key = ['@@activate'];
    entry.keysecondary = [];
    entry.disable = false;
    entry.constant = true;
    entry.selective = false;
    entry.order = order;
    entry.position = 4; // at depth
    entry.depth = settings().injectDepth;
    entry.role = extension_prompt_roles.SYSTEM;
    entry.addMemo = true;
    entry.excludeRecursion = true;
    entry.preventRecursion = true;
    entry.matchWholeWords = false;
    entry.caseSensitive = false;
    entry.displayIndex = entry.displayIndex ?? order;
    return entry;
}

function upsertEntry(data, comment, content, order) {
    let entry = Object.values(data.entries || {}).find((x) => x.comment === comment);
    if (!entry) {
        entry = createWorldInfoEntry('', data);
    }
    if (!entry) {
        const uid = Object.keys(data.entries || {}).length;
        entry = { uid };
        data.entries[uid] = entry;
    }
    configureEntry(entry, comment, content, order);
    return entry;
}

function extractJsonFromRawEntry(data) {
    const entry = Object.values(data?.entries || {}).find((x) => x.comment === RAW_ENTRY_COMMENT);
    if (!entry?.content) return null;
    const text = String(entry.content).replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    try {
        return JSON.parse(text);
    } catch (error) {
        warn('JSON raw entry parse failed', error);
        return null;
    }
}

async function restoreStateFromWorldBookIfNeeded() {
    const ctx = context();
    const s = settings();
    if (ctx.chatMetadata?.[MEMORY_KEY]) return;

    if (!s.keepAcrossNewChats) {
        ctx.chatMetadata[MEMORY_KEY] = createEmptyState();
        await clearWorldBookEntries({ silent: true, onlyGeneratedEntries: true });
        await saveState();
        return;
    }

    const empty = createEmptyState();
    ctx.chatMetadata[MEMORY_KEY] = empty;
    try {
        const data = await loadWorldInfo(empty.worldName);
        const restored = extractJsonFromRawEntry(data);
        if (restored) {
            ctx.chatMetadata[MEMORY_KEY] = normalizeState(restored);
        }
    } catch (error) {
        warn('restoreStateFromWorldBookIfNeeded failed', error);
    }
    await saveState();
}

async function writeWorldBook() {
    if (!settings().enabled && !stateHasContent()) return;
    const { worldName, data } = await ensureWorldBook();
    const state = getState();
    state.worldName = worldName;

    upsertEntry(data, DASHBOARD_ENTRY_COMMENT, buildWorldBookDashboard(state), 10);
    upsertEntry(data, RECORDS_ENTRY_COMMENT, buildRecordsBook(state), 20);
    upsertEntry(data, RELATION_ENTRY_COMMENT, buildRelationBook(state), 30);

    if (settings().includeRawJsonEntry) {
        upsertEntry(data, RAW_ENTRY_COMMENT, `\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``, 999);
    }

    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
}

async function clearWorldBookEntries({ silent = false } = {}, onlyGeneratedEntries = true) {
    try {
        const state = getState();
        const worldName = state.worldName || getWorldName();
        const data = await loadWorldInfo(worldName);
        if (!data?.entries) return;
        for (const [uid, entry] of Object.entries(data.entries)) {
            if (!onlyGeneratedEntries || String(entry.comment || '').startsWith(ENTRY_MARK)) {
                delete data.entries[uid];
            }
        }
        await saveWorldInfo(worldName, data, true);
        await updateWorldInfoList();
        if (!silent) toast('已清理当前角色的 RMF 世界书记忆。', 'success');
    } catch (error) {
        warn('clearWorldBookEntries failed', error);
        if (!silent) toast(`清理世界书失败：${error.message}`, 'error');
    }
}

async function clearCurrentMemory({ clearWorld = true, silent = false } = {}) {
    const ctx = context();
    const oldWorldName = ctx.chatMetadata?.[MEMORY_KEY]?.worldName || getWorldName();
    ctx.chatMetadata[MEMORY_KEY] = createEmptyState();
    ctx.chatMetadata[MEMORY_KEY].worldName = oldWorldName;
    await ctx.saveMetadata?.();
    refreshPromptInjection();
    refreshDashboard();
    if (clearWorld) {
        await clearWorldBookEntries({ silent: true, onlyGeneratedEntries: true });
    }
    if (!silent) toast('当前聊天记忆已清空。', 'success');
}

function buildWorldBookDashboard(state) {
    const pendingSummaries = state.summaries.filter((s) => !s.consolidated).map((s) => `- ${s.content}`).join('\n');
    return [
        '# Role Memory Forge 当前记忆',
        `更新时间：${state.updatedAt}`,
        `角色：${state.characterName}`,
        '',
        '## 大总结',
        state.megaSummary.content || '暂无。',
        '',
        '## 大总结之后的阶段总结',
        pendingSummaries || '暂无。',
        '',
        '## 当前剧情',
        state.tracker.currentPlot || '暂无。',
        '',
        '## 发展方向',
        state.tracker.development || '暂无。',
        '',
        '## 角色状态',
        objectToBulletList(state.tracker.characterStates),
        '',
        '## 人物档案',
        objectToBulletList(state.tracker.profiles),
        '',
        '## 世界设定',
        arrayToBulletList(state.tracker.worldSetting),
        '',
        '## 物品栏',
        objectToBulletList(state.tracker.inventory),
        '',
        '## 约定',
        arrayToBulletList(state.tracker.promises),
    ].join('\n');
}

function buildRecordsBook(state) {
    const rows = state.records.map((record) => `- #${record.id} ${record.brief}`).join('\n');
    return ['# 每层简略记录', rows || '暂无。'].join('\n\n');
}

function buildRelationBook(state) {
    return [
        '# 可视化关系表',
        state.tracker.relationTableMarkdown || buildRelationMarkdown(state.tracker.relationships),
        '',
        '## Mermaid 关系图',
        '```mermaid',
        buildMermaid(state.tracker.relationships),
        '```',
    ].join('\n');
}

function objectToBulletList(obj) {
    if (!obj || typeof obj !== 'object' || !Object.keys(obj).length) return '暂无。';
    return Object.entries(obj).map(([key, value]) => `- ${key}：${Array.isArray(value) ? value.join('；') : value}`).join('\n');
}

function arrayToBulletList(arr) {
    if (!Array.isArray(arr) || !arr.length) return '暂无。';
    return arr.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n');
}

function buildRelationMarkdown(relationships = []) {
    if (!Array.isArray(relationships) || !relationships.length) {
        return '| 人物A | 人物B | 关系 | 当前状态 | 证据 |\n|---|---|---|---|---|';
    }
    const lines = ['| 人物A | 人物B | 关系 | 当前状态 | 证据 |', '|---|---|---|---|---|'];
    for (const r of relationships) {
        lines.push(`| ${r.from || ''} | ${r.to || ''} | ${r.relation || ''} | ${r.attitude || r.status || ''} | ${r.evidence || ''} |`);
    }
    return lines.join('\n');
}

function buildMermaid(relationships = []) {
    const safe = (text) => String(text || '未知').replace(/["`|\[\]{}<>]/g, '').slice(0, 24) || '未知';
    const lines = ['graph TD'];
    if (!Array.isArray(relationships) || !relationships.length) {
        lines.push('  A[暂无关系记录]');
        return lines.join('\n');
    }
    relationships.slice(0, 40).forEach((r, index) => {
        const a = `N${index}A[${safe(r.from)}]`;
        const b = `N${index}B[${safe(r.to)}]`;
        const label = safe(r.relation || r.attitude || '关系');
        lines.push(`  ${a} -->|${label}| ${b}`);
    });
    return lines.join('\n');
}

function buildInjectionText(state = getState()) {
    if (!stateHasContent(state)) return '';
    const s = settings();
    const pendingSummaries = state.summaries
        .filter((item) => !item.consolidated)
        .map((item) => `- ${item.content}`)
        .join('\n');
    const recentRecords = state.records
        .slice(-s.recentRecordCount)
        .map((record) => `- #${record.id} ${record.brief}`)
        .join('\n');

    const text = [
        '<角色记忆插件：请严格参考，但不要在正文中直接复述以下记忆；若与当前最新对话冲突，以最新对话为准。>',
        '',
        '【大总结】',
        state.megaSummary.content || '暂无',
        '',
        '【大总结之后的阶段总结】',
        pendingSummaries || '暂无',
        '',
        '【最近简记】',
        recentRecords || '暂无',
        '',
        '【当前剧情与发展】',
        `当前剧情：${state.tracker.currentPlot || '暂无'}`,
        `发展：${state.tracker.development || '暂无'}`,
        '',
        '【角色状态】',
        objectToBulletList(state.tracker.characterStates),
        '',
        '【人物关系】',
        state.tracker.relationTableMarkdown || buildRelationMarkdown(state.tracker.relationships),
        '',
        '【世界设定/物品/约定】',
        `世界设定：${Array.isArray(state.tracker.worldSetting) ? state.tracker.worldSetting.join('；') : '暂无'}`,
        `物品栏：${JSON.stringify(state.tracker.inventory || {}, null, 0)}`,
        `约定：${Array.isArray(state.tracker.promises) ? state.tracker.promises.join('；') : '暂无'}`,
        '</角色记忆插件>',
    ].join('\n');

    const max = clampNumber(s.injectMaxChars, 1000, 50000, DEFAULT_SETTINGS.injectMaxChars);
    return text.length > max ? `${text.slice(0, max)}\n[记忆因长度限制被截断]` : text;
}

function refreshPromptInjection() {
    const s = settings();
    const ctx = context();
    if (!s.enabled) {
        ctx.setExtensionPrompt?.(MODULE_NAME, '', extension_prompt_types.IN_CHAT, s.injectDepth, true, extension_prompt_roles.SYSTEM);
        return;
    }
    const state = getState();
    const prompt = buildInjectionText(state);
    ctx.setExtensionPrompt?.(
        MODULE_NAME,
        prompt,
        extension_prompt_types.IN_CHAT,
        clampNumber(s.injectDepth, 0, 100, DEFAULT_SETTINGS.injectDepth),
        true,
        extension_prompt_roles.SYSTEM,
    );
}

globalThis.RoleMemoryForge_generateInterceptor = async function RoleMemoryForge_generateInterceptor() {
    try {
        await restoreStateFromWorldBookIfNeeded();
        refreshPromptInjection();
    } catch (error) {
        warn('generate interceptor failed', error);
    }
};

function parseJsonLoose(text) {
    if (!text) throw new Error('空回复');
    const cleaned = String(text)
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```$/i, '')
        .trim();
    try {
        return JSON.parse(cleaned);
    } catch (_) {
        const first = cleaned.indexOf('{');
        const last = cleaned.lastIndexOf('}');
        if (first >= 0 && last > first) {
            return JSON.parse(cleaned.slice(first, last + 1));
        }
        throw new Error('模型没有返回可解析 JSON');
    }
}

async function callMemoryModel(prompt, { json = true } = {}) {
    const s = settings();
    if (s.source === 'openai') {
        return await callOpenAICompatible(prompt, { json });
    }
    const result = await generateQuietPrompt({ quietPrompt: prompt });
    return typeof result === 'string' ? result : String(result ?? '');
}

function normalizeChatCompletionsUrl(baseUrl) {
    const url = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!url) throw new Error('API 地址为空');
    if (/\/chat\/completions$/i.test(url)) return url;
    if (/\/v1$/i.test(url)) return `${url}/chat/completions`;
    return `${url}/v1/chat/completions`;
}

async function callOpenAICompatible(prompt, { json = true } = {}) {
    const s = settings();
    if (!s.apiKey?.trim()) throw new Error('API Key 为空');
    if (!s.model?.trim()) throw new Error('模型名为空');
    const url = normalizeChatCompletionsUrl(s.baseUrl);
    const body = {
        model: s.model.trim(),
        messages: [
            { role: 'system', content: 'You are a precise memory extraction engine. Return concise Chinese. Output valid JSON when requested.' },
            { role: 'user', content: prompt },
        ],
        temperature: Number(s.temperature ?? 0.15),
        max_tokens: clampNumber(s.maxOutputTokens, 128, 8000, DEFAULT_SETTINGS.maxOutputTokens),
    };
    if (json) body.response_format = { type: 'json_object' };

    let response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${s.apiKey.trim()}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok && json) {
        delete body.response_format;
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${s.apiKey.trim()}`,
            },
            body: JSON.stringify(body),
        });
    }

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`API 请求失败：${response.status} ${detail.slice(0, 300)}`);
    }
    const data = await response.json();
    return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
}

function buildPairPrompt({ userText, aiText, state }) {
    return `你是 SillyTavern 角色扮演记忆插件的“实时填表器”。请根据【最新一轮对话】更新记忆。\n\n规则：\n1. 只记录已经发生、已经明确的信息；不要脑补，不要讨好 user，不要写“可能/似乎”。\n2. brief 用 1-2 句中文概括本轮，不写废话。\n3. tracker 必须返回“完整更新后的状态”，不是增量。\n4. 人物关系要保留矛盾、距离、亲密度变化、承诺、物品归属。\n5. 做爱/亲密行为只作为普通事件记录，不默认等于恋爱、告白或攻略成功，除非对话明确说明。\n\n【旧 tracker】\n${JSON.stringify(state.tracker || createEmptyTracker(), null, 2)}\n\n【最新一轮对话】\nUser：${userText}\nAI：${aiText}\n\n请只输出 JSON：\n{\n  "brief": "本轮简记",\n  "tracker": {\n    "characterStates": {"角色名":"当前身体/情绪/位置/目标等状态"},\n    "profiles": {"角色名":"稳定人物档案和已知事实"},\n    "relationships": [{"from":"人物A","to":"人物B","relation":"关系类型","attitude":"当前关系状态/张力","tension":0,"evidence":"证据"}],\n    "worldSetting": ["世界设定/地点/规则"],\n    "inventory": {"持有人":["物品/线索"]},\n    "promises": ["约定/未完成事项"],\n    "currentPlot": "当前剧情位置和正在发生的事",\n    "development": "自然的发展方向，不要替 user 决定行动",\n    "relationTableMarkdown": "markdown 表格"\n  }\n}`;
}

function buildChunkSummaryPrompt(records) {
    return `请把以下 ${records.length} 条“每轮简记”压缩成一段阶段总结。\n要求：中文；保留因果、人物关系变化、关键物品、约定、剧情推进；不要写分析废话；不要编造。\n\n${records.map((r) => `#${r.id} ${r.brief}`).join('\n')}\n\n只输出 JSON：{"summary":"阶段总结内容"}`;
}

function buildMegaSummaryPrompt({ oldMega, summaries }) {
    return `请把旧大总结和新的阶段总结合并成一个更稳定的大总结。\n要求：中文；保留长期有效事实、关系、世界设定、剧情主线、关键物品和承诺；删除重复；不要编造；不要过度细节化。\n\n【旧大总结】\n${oldMega || '暂无'}\n\n【新的阶段总结】\n${summaries.map((s, i) => `${i + 1}. ${s.content}`).join('\n')}\n\n只输出 JSON：{"megaSummary":"合并后的大总结"}`;
}

function getLatestExchange() {
    const chat = context().chat || [];
    let aiIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system && stripHtml(m.mes)) {
            aiIndex = i;
            break;
        }
    }
    if (aiIndex <= 0) return null;
    let userIndex = -1;
    for (let i = aiIndex - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && m.is_user && !m.is_system && stripHtml(m.mes)) {
            userIndex = i;
            break;
        }
    }
    if (userIndex < 0) return null;
    return {
        pairKey: `${userIndex}:${aiIndex}:${stripHtml(chat[userIndex].mes).slice(0, 60)}:${stripHtml(chat[aiIndex].mes).slice(0, 60)}`,
        userIndex,
        aiIndex,
        userText: stripHtml(chat[userIndex].mes),
        aiText: stripHtml(chat[aiIndex].mes),
        userName: chat[userIndex].name || context().name1 || '{{user}}',
        aiName: chat[aiIndex].name || getCharacterName(),
    };
}

let processing = false;
let pendingProcess = false;

async function processLatestExchange({ force = false } = {}) {
    const s = settings();
    if (!s.enabled || !s.autoProcess) return;
    if (processing) {
        pendingProcess = true;
        return;
    }
    processing = true;
    try {
        await restoreStateFromWorldBookIfNeeded();
        const state = getState();
        const exchange = getLatestExchange();
        if (!exchange) return;
        if (!force && state.processedPairs.includes(exchange.pairKey)) return;

        updateStatus('正在总结最新一轮……');
        const raw = await callMemoryModel(buildPairPrompt({ ...exchange, state }), { json: true });
        const json = parseJsonLoose(raw);
        const brief = String(json.brief || '').trim() || fallbackBrief(exchange);
        const tracker = normalizeTracker(json.tracker, state.tracker);

        const nextId = (state.records.at(-1)?.id || 0) + 1;
        state.records.push({
            id: nextId,
            userIndex: exchange.userIndex,
            aiIndex: exchange.aiIndex,
            userName: exchange.userName,
            aiName: exchange.aiName,
            user: exchange.userText,
            ai: exchange.aiText,
            brief,
            createdAt: nowIso(),
        });
        state.tracker = tracker;
        state.processedPairs.push(exchange.pairKey);
        state.processedPairs = state.processedPairs.slice(-Math.max(200, s.maxRecordsStored));
        state.records = state.records.slice(-clampNumber(s.maxRecordsStored, 50, 5000, DEFAULT_SETTINGS.maxRecordsStored));
        state.lastError = '';

        await maybeCreateChunkSummary(state);
        await maybeCreateMegaSummary(state);
        await saveState();
        await writeWorldBook();
        await appendBriefToAiMessage(state.records.at(-1));
        refreshDashboard();
        updateStatus('记忆已更新。');
    } catch (error) {
        const state = getState();
        state.lastError = error.message;
        await saveState();
        warn('processLatestExchange failed', error);
        toast(`记忆总结失败：${error.message}`, 'error');
        updateStatus(`失败：${error.message}`);
    } finally {
        processing = false;
        if (pendingProcess) {
            pendingProcess = false;
            setTimeout(() => processLatestExchange(), 300);
        }
    }
}

function normalizeTracker(next, previous) {
    const base = createEmptyTracker();
    const merged = { ...base, ...(previous || {}), ...(next || {}) };
    merged.characterStates = typeof merged.characterStates === 'object' && !Array.isArray(merged.characterStates) ? merged.characterStates : {};
    merged.profiles = typeof merged.profiles === 'object' && !Array.isArray(merged.profiles) ? merged.profiles : {};
    merged.relationships = Array.isArray(merged.relationships) ? merged.relationships : [];
    merged.worldSetting = Array.isArray(merged.worldSetting) ? merged.worldSetting : [];
    merged.inventory = typeof merged.inventory === 'object' && !Array.isArray(merged.inventory) ? merged.inventory : {};
    merged.promises = Array.isArray(merged.promises) ? merged.promises : [];
    merged.currentPlot = String(merged.currentPlot || '');
    merged.development = String(merged.development || '');
    merged.relationTableMarkdown = String(merged.relationTableMarkdown || buildRelationMarkdown(merged.relationships));
    return merged;
}

function fallbackBrief(exchange) {
    const u = exchange.userText.slice(0, 120);
    const a = exchange.aiText.slice(0, 160);
    return `User 表达/行动：${u}；${exchange.aiName}回应/行动：${a}`;
}

function buildBriefFoldHtml(record) {
    const title = settings().briefFoldTitle || DEFAULT_SETTINGS.briefFoldTitle;
    return [
        '\n\n<!--RMF_BRIEF_START-->',
        `<details class="rmf-brief-fold" data-rmf-brief="${record.id}">`,
        `<summary>${escapeForHtml(title)} #${record.id}</summary>`,
        `<div class="rmf-brief-body">${escapeForHtml(record.brief)}</div>`,
        '</details>',
        '<!--RMF_BRIEF_END-->',
    ].join('');
}

async function saveChatAfterMessagePatch() {
    const ctx = context();
    if (typeof ctx.saveChat === 'function') {
        await ctx.saveChat();
        return;
    }
    if (typeof ctx.saveChatConditional === 'function') {
        await ctx.saveChatConditional();
        return;
    }
    if (typeof ctx.saveChatDebounced === 'function') {
        ctx.saveChatDebounced();
        return;
    }
}

async function appendBriefToAiMessage(record) {
    const s = settings();
    if (!s.appendBriefToMessage || !record) return;
    try {
        const chat = context().chat || [];
        const msg = chat[record.aiIndex];
        if (!msg || msg.is_user || msg.is_system) return;
        const clean = stripRmfFoldHtml(msg.mes || '');
        msg.mes = `${clean}${buildBriefFoldHtml(record)}`;
        await saveChatAfterMessagePatch();

        // 轻量刷新已渲染的最后一条消息：不同 ST 版本 DOM 结构不完全一致，失败也不影响存档。
        const rendered = document.querySelector(`.mes[mesid="${record.aiIndex}"] .mes_text`)
            || document.querySelector(`.mes[mesid='${record.aiIndex}'] .mes_text`);
        if (rendered) {
            rendered.insertAdjacentHTML('beforeend', buildBriefFoldHtml(record));
        }
    } catch (error) {
        warn('appendBriefToAiMessage failed', error);
    }
}

async function maybeCreateChunkSummary(state) {
    const s = settings();
    const chunkSize = clampNumber(s.chunkSize, 2, 100, DEFAULT_SETTINGS.chunkSize);
    const alreadyCovered = state.summaries.at(-1)?.endRecordId || 0;
    const newRecords = state.records.filter((r) => r.id > alreadyCovered);
    if (newRecords.length < chunkSize) return;
    const chunk = newRecords.slice(0, chunkSize);
    updateStatus(`正在生成 ${chunk.length} 条简记的阶段总结……`);
    const raw = await callMemoryModel(buildChunkSummaryPrompt(chunk), { json: true });
    const json = parseJsonLoose(raw);
    state.summaries.push({
        id: (state.summaries.at(-1)?.id || 0) + 1,
        startRecordId: chunk[0].id,
        endRecordId: chunk.at(-1).id,
        content: String(json.summary || raw || '').trim(),
        consolidated: false,
        createdAt: nowIso(),
    });
}

async function maybeCreateMegaSummary(state) {
    const s = settings();
    const megaEvery = clampNumber(s.megaEvery, 2, 20, DEFAULT_SETTINGS.megaEvery);
    const pending = state.summaries.filter((item) => !item.consolidated);
    if (pending.length < megaEvery) return;
    const batch = pending.slice(0, megaEvery);
    updateStatus(`正在生成大总结（${batch.length} 个阶段总结）……`);
    const raw = await callMemoryModel(buildMegaSummaryPrompt({ oldMega: state.megaSummary.content, summaries: batch }), { json: true });
    const json = parseJsonLoose(raw);
    state.megaSummary = {
        content: String(json.megaSummary || raw || '').trim(),
        coversRecordId: batch.at(-1).endRecordId,
        coversSummaryCount: (state.megaSummary.coversSummaryCount || 0) + batch.length,
        updatedAt: nowIso(),
    };
    for (const summary of batch) {
        summary.consolidated = true;
    }
}

function scheduleProcessLatest() {
    if (!settings().enabled || !settings().autoProcess) return;
    setTimeout(() => processLatestExchange(), 500);
}

function updateStatus(text) {
    const el = document.querySelector('#rmf_status');
    if (el) el.textContent = text;
}

async function rescanCurrentChat() {
    const s = settings();
    if (!s.enabled) return toast('请先启用插件。', 'warning');
    await clearCurrentMemory({ clearWorld: true, silent: true });
    const chat = context().chat || [];
    const pairs = [];
    for (let aiIndex = 0; aiIndex < chat.length; aiIndex++) {
        const ai = chat[aiIndex];
        if (!ai || ai.is_user || ai.is_system || !stripHtml(ai.mes)) continue;
        let userIndex = -1;
        for (let j = aiIndex - 1; j >= 0; j--) {
            if (chat[j]?.is_user && !chat[j]?.is_system && stripHtml(chat[j]?.mes)) {
                userIndex = j;
                break;
            }
        }
        if (userIndex >= 0) {
            pairs.push({ userIndex, aiIndex });
        }
    }
    toast(`开始补录 ${pairs.length} 轮聊天。`, 'info');
    for (const pair of pairs) {
        const state = getState();
        const exchange = {
            pairKey: `${pair.userIndex}:${pair.aiIndex}:${stripHtml(chat[pair.userIndex].mes).slice(0, 60)}:${stripHtml(chat[pair.aiIndex].mes).slice(0, 60)}`,
            userIndex: pair.userIndex,
            aiIndex: pair.aiIndex,
            userText: stripHtml(chat[pair.userIndex].mes),
            aiText: stripHtml(chat[pair.aiIndex].mes),
            userName: chat[pair.userIndex].name || context().name1 || '{{user}}',
            aiName: chat[pair.aiIndex].name || getCharacterName(),
        };
        if (state.processedPairs.includes(exchange.pairKey)) continue;
        try {
            updateStatus(`补录中：${pairs.indexOf(pair) + 1}/${pairs.length}`);
            const raw = await callMemoryModel(buildPairPrompt({ ...exchange, state }), { json: true });
            const json = parseJsonLoose(raw);
            const nextId = (state.records.at(-1)?.id || 0) + 1;
            state.records.push({
                id: nextId,
                userIndex: exchange.userIndex,
                aiIndex: exchange.aiIndex,
                userName: exchange.userName,
                aiName: exchange.aiName,
                user: exchange.userText,
                ai: exchange.aiText,
                brief: String(json.brief || '').trim() || fallbackBrief(exchange),
                createdAt: nowIso(),
            });
            state.tracker = normalizeTracker(json.tracker, state.tracker);
            state.processedPairs.push(exchange.pairKey);
            await maybeCreateChunkSummary(state);
            await maybeCreateMegaSummary(state);
            await saveState();
        } catch (error) {
            warn('rescan pair failed', pair, error);
        }
    }
    await writeWorldBook();
    updateStatus('补录完成。');
    toast('当前聊天补录完成。', 'success');
}

function renderSettingsPanel() {
    if (document.querySelector('#rmf_settings')) return;
    const html = `
    <button id="rmf_float_button" class="rmf-float" title="Role Memory Forge">
        <span>🧠</span>
        <em id="rmf_float_badge">0</em>
    </button>

    <div id="rmf_modal" class="rmf-modal rmf-hidden" aria-hidden="true">
        <div id="rmf_backdrop" class="rmf-backdrop"></div>
        <section id="rmf_settings" class="rmf-panel rmf-window" role="dialog" aria-label="Role Memory Forge">
            <div class="rmf-hero">
                <div class="rmf-orb">✦</div>
                <div class="rmf-titlebox">
                    <strong>Role Memory Forge</strong>
                    <small>分层总结 / 实时填表 / 关系网络 / 世界书记忆</small>
                </div>
                <span id="rmf_status" class="rmf-status">待机</span>
                <button id="rmf_close" class="rmf-icon-btn" title="关闭">×</button>
            </div>

            <div class="rmf-quick-row">
                <label class="rmf-switch"><input id="rmf_enabled" type="checkbox"><span></span><b>启用记忆</b></label>
                <label class="rmf-switch"><input id="rmf_auto" type="checkbox"><span></span><b>AI 回复后实时填表</b></label>
                <label class="rmf-switch"><input id="rmf_appendBrief" type="checkbox"><span></span><b>回复结尾折叠简记</b></label>
                <label class="rmf-switch"><input id="rmf_keep" type="checkbox"><span></span><b>新聊天保留记忆</b></label>
            </div>

            <div class="rmf-layout">
                <aside class="rmf-side-card">
                    <div class="rmf-side-title">当前状态</div>
                    <div id="rmf_dashboard" class="rmf-dashboard"></div>
                </aside>

                <main class="rmf-main-card">
                    <details open class="rmf-section">
                        <summary>API 与模型</summary>
                        <div class="rmf-grid">
                            <label>总结来源
                                <select id="rmf_source">
                                    <option value="st">使用 SillyTavern 当前 API（推荐）</option>
                                    <option value="openai">自填 OpenAI-compatible 地址/密钥/模型</option>
                                </select>
                            </label>
                            <label>API 地址/端口
                                <input id="rmf_baseUrl" type="text" placeholder="https://api.openai.com/v1 或 http://127.0.0.1:8000/v1">
                            </label>
                            <label>API Key
                                <input id="rmf_apiKey" type="password" autocomplete="off" placeholder="sk-...">
                            </label>
                            <label>模型名
                                <input id="rmf_model" type="text" placeholder="gpt-4o-mini / deepseek-chat / Qwen...">
                            </label>
                            <label>最大输出 Token
                                <input id="rmf_maxOutputTokens" type="number" min="128" max="8000">
                            </label>
                            <label>温度
                                <input id="rmf_temperature" type="number" min="0" max="1" step="0.05">
                            </label>
                        </div>
                    </details>

                    <details open class="rmf-section">
                        <summary>记忆规则</summary>
                        <div class="rmf-grid">
                            <label>每多少条简记生成阶段总结
                                <input id="rmf_chunkSize" type="number" min="2" max="100">
                            </label>
                            <label>多少个阶段总结生成大总结
                                <input id="rmf_megaEvery" type="number" min="2" max="20">
                            </label>
                            <label>最近简记注入数量
                                <input id="rmf_recentRecordCount" type="number" min="0" max="50">
                            </label>
                            <label>最多保存简记数量
                                <input id="rmf_maxRecordsStored" type="number" min="50" max="5000">
                            </label>
                            <label>注入深度
                                <input id="rmf_injectDepth" type="number" min="0" max="100">
                            </label>
                            <label>最大注入字符
                                <input id="rmf_injectMaxChars" type="number" min="1000" max="50000">
                            </label>
                        </div>
                    </details>

                    <details open class="rmf-section">
                        <summary>显示与世界书</summary>
                        <div class="rmf-grid">
                            <label>折叠简记标题
                                <input id="rmf_briefFoldTitle" type="text" placeholder="🧠 本轮记忆简记">
                            </label>
                            <label>关系图最多节点
                                <input id="rmf_relationGraphMaxNodes" type="number" min="4" max="24">
                            </label>
                            <label>世界书命名模板
                                <input id="rmf_worldNameTemplate" type="text" placeholder="RMF-{{char}}-记忆世界书">
                            </label>
                            <label class="rmf-checkline"><input id="rmf_cleanup" type="checkbox"> 关闭插件时清理当前记忆</label>
                            <label class="rmf-checkline"><input id="rmf_toast" type="checkbox"> 显示提示消息</label>
                            <label class="rmf-checkline"><input id="rmf_raw" type="checkbox"> 保存 JSON_RAW 世界书条目</label>
                        </div>
                    </details>

                    <div class="rmf-actions">
                        <button id="rmf_process" class="menu_button">手动记录最新一轮</button>
                        <button id="rmf_rescan" class="menu_button">补录当前聊天</button>
                        <button id="rmf_sync" class="menu_button">同步到世界书</button>
                        <button id="rmf_export" class="menu_button">导出 JSON</button>
                        <button id="rmf_clear" class="menu_button danger">清空当前记忆</button>
                    </div>

                    <div class="rmf-note">提示：折叠简记会追加到 AI 最新回复末尾；如不想增加聊天正文长度，可以关闭“回复结尾折叠简记”。自填 API Key 会保存在 ST 扩展设置里；更安全的方式是选择“使用 SillyTavern 当前 API”。浏览器直连某些 API 可能被 CORS 拦截。</div>
                </main>
            </div>
        </section>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    bindPanelEvents();
    bindFloatingPanelEvents();
    refreshPanelValues();
    refreshDashboard();
}

function bindFloatingPanelEvents() {
    const modal = document.querySelector('#rmf_modal');
    const open = () => {
        modal?.classList.remove('rmf-hidden');
        modal?.setAttribute('aria-hidden', 'false');
        refreshDashboard();
    };
    const close = () => {
        modal?.classList.add('rmf-hidden');
        modal?.setAttribute('aria-hidden', 'true');
    };
    document.querySelector('#rmf_float_button')?.addEventListener('click', open);
    document.querySelector('#rmf_backdrop')?.addEventListener('click', close);
    document.querySelector('#rmf_close')?.addEventListener('click', close);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close();
    });
}

function bindPanelEvents() {
    const map = {
        rmf_enabled: ['enabled', 'checked'],
        rmf_keep: ['keepAcrossNewChats', 'checked'],
        rmf_cleanup: ['cleanupWhenDisabled', 'checked'],
        rmf_auto: ['autoProcess', 'checked'],
        rmf_appendBrief: ['appendBriefToMessage', 'checked'],
        rmf_toast: ['showToast', 'checked'],
        rmf_raw: ['includeRawJsonEntry', 'checked'],
        rmf_source: ['source', 'value'],
        rmf_baseUrl: ['baseUrl', 'value'],
        rmf_apiKey: ['apiKey', 'value'],
        rmf_model: ['model', 'value'],
        rmf_maxOutputTokens: ['maxOutputTokens', 'value'],
        rmf_temperature: ['temperature', 'value'],
        rmf_chunkSize: ['chunkSize', 'value'],
        rmf_megaEvery: ['megaEvery', 'value'],
        rmf_injectDepth: ['injectDepth', 'value'],
        rmf_injectMaxChars: ['injectMaxChars', 'value'],
        rmf_recentRecordCount: ['recentRecordCount', 'value'],
        rmf_maxRecordsStored: ['maxRecordsStored', 'value'],
        rmf_briefFoldTitle: ['briefFoldTitle', 'value'],
        rmf_relationGraphMaxNodes: ['relationGraphMaxNodes', 'value'],
        rmf_worldNameTemplate: ['worldNameTemplate', 'value'],
    };
    for (const [id, [key, prop]] of Object.entries(map)) {
        document.querySelector(`#${id}`)?.addEventListener('change', async (event) => {
            const s = settings();
            let value = event.target[prop];
            if (event.target.type === 'number') value = Number(value);
            s[key] = value;
            saveSettings();
            if (key === 'enabled') {
                if (value) {
                    await restoreStateFromWorldBookIfNeeded();
                    refreshPromptInjection();
                    await writeWorldBook().catch((error) => warn('writeWorldBook after enable failed', error));
                } else if (s.cleanupWhenDisabled) {
                    await clearCurrentMemory({ clearWorld: true });
                } else {
                    refreshPromptInjection();
                }
            } else {
                refreshPromptInjection();
            }
            refreshDashboard();
        });
    }

    document.querySelector('#rmf_process')?.addEventListener('click', () => processLatestExchange({ force: true }));
    document.querySelector('#rmf_rescan')?.addEventListener('click', () => rescanCurrentChat());
    document.querySelector('#rmf_sync')?.addEventListener('click', async () => {
        await writeWorldBook();
        toast('已同步到世界书。', 'success');
    });
    document.querySelector('#rmf_export')?.addEventListener('click', () => exportJson());
    document.querySelector('#rmf_clear')?.addEventListener('click', async () => {
        const ok = confirm('确定清空当前聊天的 RMF 记忆和世界书记录吗？');
        if (ok) await clearCurrentMemory({ clearWorld: true });
    });
}

function refreshPanelValues() {
    const s = settings();
    const set = (id, value, prop = 'value') => {
        const el = document.querySelector(`#${id}`);
        if (el) el[prop] = value;
    };
    set('rmf_enabled', !!s.enabled, 'checked');
    set('rmf_keep', !!s.keepAcrossNewChats, 'checked');
    set('rmf_cleanup', !!s.cleanupWhenDisabled, 'checked');
    set('rmf_auto', !!s.autoProcess, 'checked');
    set('rmf_appendBrief', !!s.appendBriefToMessage, 'checked');
    set('rmf_toast', !!s.showToast, 'checked');
    set('rmf_raw', !!s.includeRawJsonEntry, 'checked');
    set('rmf_source', s.source);
    set('rmf_baseUrl', s.baseUrl);
    set('rmf_apiKey', s.apiKey);
    set('rmf_model', s.model);
    set('rmf_maxOutputTokens', s.maxOutputTokens);
    set('rmf_temperature', s.temperature);
    set('rmf_chunkSize', s.chunkSize);
    set('rmf_megaEvery', s.megaEvery);
    set('rmf_injectDepth', s.injectDepth);
    set('rmf_injectMaxChars', s.injectMaxChars);
    set('rmf_recentRecordCount', s.recentRecordCount);
    set('rmf_maxRecordsStored', s.maxRecordsStored);
    set('rmf_briefFoldTitle', s.briefFoldTitle);
    set('rmf_relationGraphMaxNodes', s.relationGraphMaxNodes);
    set('rmf_worldNameTemplate', s.worldNameTemplate);
}

function avatarUrlForName(name) {
    const ctx = context();
    const wanted = String(name || '').trim();
    const char = (ctx.characters || []).find((item) => String(item?.name || '').trim() === wanted);
    if (char?.avatar && char.avatar !== 'none') {
        return `/thumbnail?type=avatar&file=${encodeURIComponent(char.avatar)}`;
    }
    return '';
}

function relationStrengthLabel(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    if (n >= 80) return '极强';
    if (n >= 55) return '明显';
    if (n >= 25) return '微妙';
    if (n <= -60) return '敌对';
    if (n <= -25) return '紧张';
    return '中性';
}

function collectRelationGraph(state) {
    const relationships = Array.isArray(state?.tracker?.relationships) ? state.tracker.relationships : [];
    const main = getCharacterName();
    const scores = new Map([[main, 999]]);
    for (const r of relationships) {
        const from = String(r.from || '').trim();
        const to = String(r.to || '').trim();
        if (!from || !to) continue;
        scores.set(from, (scores.get(from) || 0) + 1);
        scores.set(to, (scores.get(to) || 0) + 1);
    }
    const center = scores.has(main) ? main : [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || main;
    const maxNodes = clampNumber(settings().relationGraphMaxNodes, 4, 24, DEFAULT_SETTINGS.relationGraphMaxNodes);
    const names = [...scores.keys()]
        .filter((name) => name && name !== center)
        .sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0))
        .slice(0, maxNodes - 1);
    const all = [center, ...names];
    const allowed = new Set(all);
    const edges = relationships
        .filter((r) => allowed.has(String(r.from || '').trim()) && allowed.has(String(r.to || '').trim()))
        .slice(0, 40);
    return { center, names, all, edges };
}

function buildRelationGraphHtml(state) {
    const { center, names, all, edges } = collectRelationGraph(state);
    if (!edges.length && !names.length) {
        return `<div class="rmf-empty-graph">暂无人物关系，继续聊天后这里会生成关系网络。</div>`;
    }

    const positions = new Map();
    positions.set(center, { x: 50, y: 48, center: true });
    const radiusX = names.length <= 4 ? 34 : 38;
    const radiusY = names.length <= 4 ? 28 : 33;
    names.forEach((name, index) => {
        const angle = (-90 + index * (360 / Math.max(names.length, 1))) * Math.PI / 180;
        positions.set(name, {
            x: 50 + Math.cos(angle) * radiusX,
            y: 48 + Math.sin(angle) * radiusY,
            center: false,
        });
    });

    const nodeHtml = all.map((name) => {
        const pos = positions.get(name);
        const avatar = avatarUrlForName(name);
        const initial = escapeForHtml(name.slice(0, 2) || '?');
        return `<div class="rmf-node ${pos.center ? 'is-center' : ''}" style="left:${pos.x}%;top:${pos.y}%">
            <div class="rmf-avatar">${avatar ? `<img src="${avatar}" alt="">` : `<span>${initial}</span>`}</div>
            <div class="rmf-node-name">${escapeForHtml(name)}</div>
        </div>`;
    }).join('');

    const svgEdges = edges.map((r, index) => {
        const from = String(r.from || '').trim();
        const to = String(r.to || '').trim();
        const a = positions.get(from);
        const b = positions.get(to);
        if (!a || !b) return '';
        const relation = escapeForHtml(String(r.relation || r.attitude || '关系').slice(0, 12));
        const strength = relationStrengthLabel(r.tension);
        const label = strength ? `${relation} · ${strength}` : relation;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        return `<g class="rmf-edge">
            <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"></line>
            <text x="${mx}" y="${my - 1}" text-anchor="middle">${label}</text>
        </g>`;
    }).join('');

    return `<div class="rmf-graph-wrap">
        <svg class="rmf-graph-lines" viewBox="0 0 100 100" preserveAspectRatio="none">${svgEdges}</svg>
        ${nodeHtml}
    </div>`;
}

function buildRelationshipCards(state) {
    const relationships = Array.isArray(state?.tracker?.relationships) ? state.tracker.relationships : [];
    if (!relationships.length) return '<div class="rmf-muted">暂无关系记录。</div>';
    return relationships.slice(0, 18).map((r) => `
        <div class="rmf-relation-card">
            <b>${escapeForHtml(r.from || '未知')}</b>
            <span>${escapeForHtml(r.relation || '关系')}</span>
            <b>${escapeForHtml(r.to || '未知')}</b>
            <small>${escapeForHtml(r.attitude || r.status || r.evidence || '')}</small>
        </div>`).join('');
}

function refreshDashboard() {
    const el = document.querySelector('#rmf_dashboard');
    const badge = document.querySelector('#rmf_float_badge');
    const floatButton = document.querySelector('#rmf_float_button');
    if (!el && !badge && !floatButton) return;
    const state = getState();
    const pending = state.summaries.filter((s) => !s.consolidated).length;
    if (badge) badge.textContent = String(state.records.length || 0);
    if (floatButton) {
        floatButton.classList.toggle('is-disabled', !settings().enabled);
        floatButton.title = settings().enabled ? 'Role Memory Forge 已启用' : 'Role Memory Forge 未启用';
    }
    if (!el) return;
    el.innerHTML = `
        <div class="rmf-statline">
            <span>世界书 <b>${escapeForHtml(state.worldName || getWorldName())}</b></span>
            <span>简记 <b>${state.records.length}</b></span>
            <span>阶段总结 <b>${state.summaries.length}</b> / 未合并 <b>${pending}</b></span>
            <span>大总结 <b>${state.megaSummary.content ? '有' : '无'}</b></span>
        </div>
        ${state.lastError ? `<div class="rmf-error">${escapeForHtml(state.lastError)}</div>` : ''}
        <details open class="rmf-dash-block">
            <summary>人物关系网络</summary>
            ${buildRelationGraphHtml(state)}
            <div class="rmf-relation-list">${buildRelationshipCards(state)}</div>
        </details>
        <details open class="rmf-dash-block">
            <summary>当前剧情</summary>
            <div class="rmf-text-box">${escapeForHtml(state.tracker.currentPlot || '暂无')}</div>
        </details>
        <details class="rmf-dash-block">
            <summary>发展方向</summary>
            <div class="rmf-text-box">${escapeForHtml(state.tracker.development || '暂无')}</div>
        </details>
        <details class="rmf-dash-block">
            <summary>最近简记</summary>
            <ol class="rmf-record-list">${state.records.slice(-8).map((r) => `<li><b>#${r.id}</b> ${escapeForHtml(r.brief)}</li>`).join('') || '<li>暂无</li>'}</ol>
        </details>
        <details class="rmf-dash-block">
            <summary>人物关系 Markdown</summary>
            <pre>${escapeForHtml(state.tracker.relationTableMarkdown || buildRelationMarkdown(state.tracker.relationships))}</pre>
        </details>
        <details class="rmf-dash-block">
            <summary>大总结</summary>
            <div class="rmf-text-box">${escapeForHtml(state.megaSummary.content || '暂无')}</div>
        </details>
    `;
}

function exportJson() {
    const state = getState();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${sanitizeWorldName(state.worldName || 'role-memory')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
}

function registerEvents() {
    const ctx = context();
    const events = ctx.eventTypes || ctx.event_types;
    ctx.eventSource.on(events.APP_READY, async () => {
        renderSettingsPanel();
        await restoreStateFromWorldBookIfNeeded();
        refreshPromptInjection();
    });
    ctx.eventSource.on(events.CHAT_CHANGED, async () => {
        await restoreStateFromWorldBookIfNeeded();
        refreshPromptInjection();
        refreshPanelValues();
        refreshDashboard();
    });
    ctx.eventSource.on(events.CHAT_CREATED, async () => {
        if (!settings().keepAcrossNewChats) {
            await clearCurrentMemory({ clearWorld: true, silent: true });
        } else {
            await restoreStateFromWorldBookIfNeeded();
        }
    });
    ctx.eventSource.on(events.MESSAGE_RECEIVED, scheduleProcessLatest);
    ctx.eventSource.on(events.MESSAGE_SWIPED, scheduleProcessLatest);
    ctx.eventSource.on(events.MESSAGE_EDITED, async () => {
        const state = getState();
        state.lastError = '消息被编辑过：建议点击“补录当前聊天”重建记忆，避免旧简记不一致。';
        await saveState();
    });
    ctx.eventSource.on(events.MESSAGE_DELETED, async () => {
        const state = getState();
        state.lastError = '消息被删除过：建议点击“补录当前聊天”重建记忆，避免旧简记不一致。';
        await saveState();
    });
}

let initialized = false;

async function init() {
    if (initialized) return;
    initialized = true;
    settings();
    registerEvents();
    renderSettingsPanel();
    await restoreStateFromWorldBookIfNeeded();
    refreshPromptInjection();
    log('loaded');
}

export async function onActivate() {
    await init();
}

export async function onEnable() {
    settings().enabled = true;
    saveSettings();
    await init();
    await writeWorldBook().catch((error) => warn('writeWorldBook onEnable failed', error));
}

export async function onDisable() {
    const s = settings();
    s.enabled = false;
    saveSettings();
    refreshPromptInjection();
    if (s.cleanupWhenDisabled) {
        await clearCurrentMemory({ clearWorld: true, silent: true });
    }
}

export async function onClean() {
    await clearCurrentMemory({ clearWorld: true, silent: true });
}

init().catch((error) => warn('init failed', error));
