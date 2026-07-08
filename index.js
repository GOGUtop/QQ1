// Role Memory Forge v0.4.5
// 这一版不再使用会直接炸掉插件的静态 import。
// SillyTavern 内部模块路径有时会随版本变化，静态 import 一旦失败，悬浮球和入口都会消失。
// 这里改为：先渲染 UI，再动态按需加载 ST API / WorldInfo API。

const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

let scriptModulePromise = null;
let worldInfoModulePromise = null;
let csrfTokenPromise = null;

async function importFirst(urls) {
    for (const url of urls) {
        try {
            return await import(url);
        } catch (error) {
            console.warn('[Role Memory Forge] dynamic import failed:', url, error);
        }
    }
    return null;
}

async function getScriptModule() {
    if (!scriptModulePromise) {
        scriptModulePromise = importFirst(['../../../../script.js', '/script.js']);
    }
    return await scriptModulePromise;
}

async function getWorldInfoModule() {
    if (!worldInfoModulePromise) {
        worldInfoModulePromise = importFirst(['../../../world-info.js', '/scripts/world-info.js']);
    }
    return await worldInfoModulePromise;
}

async function getFetchHeaders() {
    try {
        const script = await getScriptModule();
        if (typeof script?.getRequestHeaders === 'function') {
            return script.getRequestHeaders();
        }
    } catch (_) {}

    if (!csrfTokenPromise) {
        csrfTokenPromise = fetch('/csrf-token')
            .then((r) => r.ok ? r.json() : null)
            .then((data) => data?.token || '')
            .catch(() => '');
    }
    const token = await csrfTokenPromise;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-CSRF-Token'] = token;
    return headers;
}

async function generateQuietPrompt(args) {
    const ctx = context();
    if (typeof ctx.generateQuietPrompt === 'function') {
        return await ctx.generateQuietPrompt(args);
    }
    const script = await getScriptModule();
    if (typeof script?.generateQuietPrompt === 'function') {
        return await script.generateQuietPrompt(args);
    }
    throw new Error('当前 SillyTavern 没有暴露 generateQuietPrompt；请改用自填 OpenAI-compatible API。');
}

async function loadWorldInfo(name) {
    const wi = await getWorldInfoModule();
    if (typeof wi?.loadWorldInfo === 'function') {
        return await wi.loadWorldInfo(name);
    }
    const response = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: await getFetchHeaders(),
        body: JSON.stringify({ name }),
        cache: 'no-cache',
    });
    if (!response.ok) return null;
    return await response.json();
}

async function saveWorldInfo(name, data, immediately = true) {
    const wi = await getWorldInfoModule();
    if (typeof wi?.saveWorldInfo === 'function') {
        return await wi.saveWorldInfo(name, data, immediately);
    }
    await fetch('/api/worldinfo/edit', {
        method: 'POST',
        headers: await getFetchHeaders(),
        body: JSON.stringify({ name, data }),
    });
}

async function createNewWorldInfo(worldName, { interactive = false } = {}) {
    const wi = await getWorldInfoModule();
    if (typeof wi?.createNewWorldInfo === 'function') {
        return await wi.createNewWorldInfo(worldName, { interactive });
    }
    await saveWorldInfo(worldName, { entries: {} }, true);
    return true;
}

async function updateWorldInfoList() {
    const wi = await getWorldInfoModule();
    if (typeof wi?.updateWorldInfoList === 'function') {
        return await wi.updateWorldInfoList();
    }
    try {
        const response = await fetch('/api/settings/get', {
            method: 'POST',
            headers: await getFetchHeaders(),
            body: JSON.stringify({}),
        });
        if (!response.ok) return;
        const data = await response.json();
        const names = Array.isArray(data.world_names) ? data.world_names : [];
        const worldSelect = document.querySelector('#world_info');
        const editorSelect = document.querySelector('#world_editor_select');
        for (const select of [worldSelect, editorSelect]) {
            if (!select) continue;
            [...select.querySelectorAll('option')].forEach((opt) => { if (opt.value !== '') opt.remove(); });
            names.forEach((name, i) => select.append(new Option(name, String(i))));
        }
    } catch (error) {
        console.warn('[Role Memory Forge] updateWorldInfoList fallback failed', error);
    }
}

function createWorldInfoEntry(_name, data) {
    data.entries ||= {};
    const used = new Set(Object.keys(data.entries).map((x) => Number(x)));
    let uid = 0;
    while (used.has(uid)) uid += 1;
    const entry = {
        uid,
        key: [],
        keysecondary: [],
        comment: '',
        content: '',
        constant: true,
        selective: false,
        order: 100,
        position: 4,
        disable: false,
        addMemo: true,
    };
    data.entries[uid] = entry;
    return entry;
}

const MODULE_NAME = 'role_memory_forge';
const MODULE_TITLE = 'Role Memory Forge';
const MEMORY_KEY = `${MODULE_NAME}_state`;
const ENTRY_MARK = '[RMF]';
const RAW_ENTRY_COMMENT = `${ENTRY_MARK} 99 JSON_RAW_DO_NOT_EDIT`;
const DASHBOARD_ENTRY_COMMENT = `${ENTRY_MARK} 00 当前记忆总览`;
const RECORDS_ENTRY_COMMENT = `${ENTRY_MARK} 01 每层简记流水`;
const RELATION_ENTRY_COMMENT = `${ENTRY_MARK} 02 可视化关系表`;
const INDEX_ENTRY_COMMENT = `${ENTRY_MARK} 03 RMF_INDEX_DATABASE`;
const WORLD_ENTRY_COMMENT = `${ENTRY_MARK} 04 状态档案设定表`;
const WALKTHROUGH_MARK = '<!--RMF_WALKTHROUGH_START-->';
const WALKTHROUGH_END = '<!--RMF_WALKTHROUGH_END-->';
const WALKTHROUGH_ENTRY_COMMENT = `${ENTRY_MARK} 05 走马灯回顾`;
const ACU_INDEX_ENTRY_COMMENT = 'TavernDB-ACU-RMF-IndexData';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    keepAcrossNewChats: false,
    cleanupWhenDisabled: true,
    source: 'st', // st | openai
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    modelOptions: [],
    chunkSize: 20,
    megaEvery: 5,
    injectDepth: 4,
    injectMaxChars: 9000,
    recentRecordCount: 8,
    maxRecordsStored: 600,
    maxOutputTokens: 1200,
    temperature: 0.15,
    worldSyncMode: 'character', // character | selected | custom
    autoSyncWorldBook: true,
    allowCreateFallbackWorldBook: false,
    worldNameTemplate: 'RMF-{{char}}-记忆世界书',
    showToast: true,
    autoProcess: true,
    includeRawJsonEntry: true,
    appendBriefToMessage: true,
    autoHideSummarizedBriefs: true,
    shujukuAcuCompatibleIndex: true,
    shujukuAcuChatDataSync: true,
    autoFallbackRelationGraph: true,
    briefFoldTitle: '🧠 本轮记忆简记',
    showFloatingPanel: true,
    relationGraphMaxNodes: 10,
    historyBatchSaveEvery: 5,
    walkThroughChunkPairs: 18,
    walkThroughMaxPairs: 160,
    walkThroughAddToChat: true,
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
        .replace(/\n*<!--RMF_WALKTHROUGH_START-->[\s\S]*?<!--RMF_WALKTHROUGH_END-->\s*/gi, '')
        .trim();
}

function isRmfUtilityMessage(message) {
    const raw = String(message?.mes || '');
    return raw.includes('RMF_WALKTHROUGH_START')
        || raw.includes('RMF_WALKTHROUGH_END')
        || message?.extra?.type === 'rmf_walkthrough';
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

function getCustomWorldName() {
    const s = settings();
    const charName = getCharacterName();
    const chatId = context().chatId || 'chat';
    return sanitizeWorldName(
        (s.worldNameTemplate || DEFAULT_SETTINGS.worldNameTemplate)
            .replaceAll('{{char}}', charName)
            .replaceAll('{{chat}}', String(chatId))
    );
}

function addWorldCandidate(list, value) {
    if (!value) return;
    if (Array.isArray(value)) {
        value.forEach((item) => addWorldCandidate(list, item));
        return;
    }
    if (typeof value === 'object') {
        for (const key of ['name', 'world', 'worldName', 'world_info', 'worldInfo', 'book', 'lorebook', 'lore_book']) {
            if (value[key]) addWorldCandidate(list, value[key]);
        }
        return;
    }
    const name = sanitizeWorldName(String(value));
    if (name && !list.includes(name)) list.push(name);
}

function getCharacterWorldNames() {
    const ctx = context();
    const char = ctx.characters?.[ctx.characterId];
    const list = [];
    if (!char) return list;

    // 不同 ST 版本 / 不同导入来源对“角色卡绑定世界书”的字段命名不完全一致，这里做宽松兼容。
    addWorldCandidate(list, char.world);
    addWorldCandidate(list, char.worldInfo);
    addWorldCandidate(list, char.world_info);
    addWorldCandidate(list, char.lorebook);
    addWorldCandidate(list, char.lore_book);
    addWorldCandidate(list, char.extensions?.world);
    addWorldCandidate(list, char.extensions?.worldInfo);
    addWorldCandidate(list, char.extensions?.world_info);
    addWorldCandidate(list, char.data?.extensions?.world);
    addWorldCandidate(list, char.data?.extensions?.worldInfo);
    addWorldCandidate(list, char.data?.extensions?.world_info);
    addWorldCandidate(list, char.data?.extensions?.world_name);
    addWorldCandidate(list, char.data?.extensions?.book);
    addWorldCandidate(list, char.data?.extensions?.lorebook);
    addWorldCandidate(list, char.data?.extensions?.lore_book);
    addWorldCandidate(list, char.data?.extensions?.sillytavern?.world);
    addWorldCandidate(list, char.data?.extensions?.sillytavern?.worldInfo);
    addWorldCandidate(list, char.data?.extensions?.sillytavern?.world_info);
    addWorldCandidate(list, char.data?.character_book?.name);
    return list;
}

function getSelectedWorldName() {
    const selectors = ['#world_info', '#world_editor_select', '#character_world', '#rmf_world_target_select'];
    for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const option = el.selectedOptions?.[0];
        const text = option?.textContent?.trim();
        const value = option?.value?.trim();
        const candidate = text && text !== 'None' && text !== '---' ? text : value;
        if (candidate && candidate !== '0' && candidate !== '-1') return sanitizeWorldName(candidate);
    }
    const ctx = context();
    addWorldCandidate.__tmp = [];
    addWorldCandidate(addWorldCandidate.__tmp, ctx.chatMetadata?.world_info);
    addWorldCandidate(addWorldCandidate.__tmp, ctx.worldInfo);
    return addWorldCandidate.__tmp?.[0] || '';
}

function resolveWorldBookTarget({ allowFallback = true } = {}) {
    const s = settings();
    const mode = s.worldSyncMode || 'character';
    const charWorld = getCharacterWorldNames()[0] || '';
    const selectedWorld = getSelectedWorldName();

    if (mode === 'character') {
        if (charWorld) return { worldName: charWorld, mode, source: '角色卡自带世界书', canCreate: false };
        if (allowFallback && s.allowCreateFallbackWorldBook) return { worldName: getCustomWorldName(), mode: 'custom', source: '自定义 RMF 世界书', canCreate: true };
        return { worldName: '', mode, source: '未检测到角色卡自带世界书', canCreate: false };
    }

    if (mode === 'selected') {
        if (selectedWorld) return { worldName: selectedWorld, mode, source: '当前选中的世界书', canCreate: false };
        if (allowFallback && s.allowCreateFallbackWorldBook) return { worldName: getCustomWorldName(), mode: 'custom', source: '自定义 RMF 世界书', canCreate: true };
        return { worldName: '', mode, source: '未检测到当前选中的世界书', canCreate: false };
    }

    return { worldName: getCustomWorldName(), mode: 'custom', source: '自定义 RMF 世界书', canCreate: true };
}

function getWorldName() {
    const target = resolveWorldBookTarget({ allowFallback: true });
    return target.worldName || '未检测到角色卡自带世界书';
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
        relationIndexFormat: '',
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
        walkthrough: { content: '', totalPairs: 0, updatedAt: '' },
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
    state.walkthrough = { ...base.walkthrough, ...(state.walkthrough || {}) };
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
    return Object.values(entries).filter((entry) => String(entry.comment || '').startsWith(ENTRY_MARK) || String(entry.comment || '') === ACU_INDEX_ENTRY_COMMENT);
}

async function ensureWorldBook() {
    const state = getState();
    const target = resolveWorldBookTarget({ allowFallback: true });
    const worldName = target.worldName;
    if (!worldName) {
        throw new Error(`${target.source}。请先在角色卡里绑定世界书，或在插件里把同步目标改为“当前选中的世界书/自定义 RMF 世界书”。`);
    }
    state.worldName = worldName;
    state.worldSource = target.source;
    let data = await loadWorldInfo(worldName);
    if (!data && target.canCreate) {
        await createNewWorldInfo(worldName, { interactive: false });
        await updateWorldInfoList();
        data = await loadWorldInfo(worldName);
    }
    if (!data) {
        throw new Error(`无法读取世界书：${worldName}。当前模式为“${target.source}”，不会自动新建世界书。`);
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
        const target = resolveWorldBookTarget({ allowFallback: true });
        if (!target.worldName) throw new Error(target.source);
        empty.worldName = target.worldName;
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
    upsertEntry(data, INDEX_ENTRY_COMMENT, buildIndexDatabaseBook(state), 40);
    upsertEntry(data, WORLD_ENTRY_COMMENT, buildStateTablesBook(state), 50);
    upsertEntry(data, WALKTHROUGH_ENTRY_COMMENT, buildWalkthroughBook(state), 60);

    if (settings().includeRawJsonEntry) {
        upsertEntry(data, RAW_ENTRY_COMMENT, `\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``, 999);
    }

    if (settings().shujukuAcuCompatibleIndex) {
        upsertAcuIndexEntry(data, JSON.stringify(buildAcuCompatibleDatabase(state), null, 2));
    }

    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
}

async function clearWorldBookEntries({ silent = false, onlyGeneratedEntries = true } = {}) {
    try {
        const state = getState();
        const worldName = state.worldName || getWorldName();
        const data = await loadWorldInfo(worldName);
        if (!data?.entries) return;
        for (const [uid, entry] of Object.entries(data.entries)) {
            if (!onlyGeneratedEntries || String(entry.comment || '').startsWith(ENTRY_MARK) || String(entry.comment || '') === ACU_INDEX_ENTRY_COMMENT) {
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

function getCoveredRecordIdForHiding(state = getState()) {
    const summaryCovered = (Array.isArray(state.summaries) ? state.summaries : []).reduce((max, item) => Math.max(max, Number(item.endRecordId || 0)), 0);
    return Math.max(summaryCovered, Number(state.megaSummary?.coversRecordId || 0));
}

function visibleRecordsForDisplay(state = getState()) {
    const records = Array.isArray(state.records) ? state.records : [];
    if (!settings().autoHideSummarizedBriefs) return records;
    const covered = getCoveredRecordIdForHiding(state);
    return records.filter((record) => Number(record.id || 0) > covered);
}

function buildRecordsBook(state) {
    const visible = visibleRecordsForDisplay(state);
    const hiddenCount = Math.max(0, (state.records?.length || 0) - visible.length);
    const rows = visible.map((record) => `- #${record.id} ${record.brief}`).join('\n');
    return ['# 每层简略记录', hiddenCount ? `已自动隐藏 ${hiddenCount} 条已进入阶段总结/大总结的简记。` : '暂无隐藏简记。', '', rows || '暂无未总结简记。'].join('\n');
}

function buildRelationBook(state) {
    return [
        '# RMF 可视化关系网络',
        '说明：本条目不再使用 Markdown 文字表格，统一使用 RMF Index JSON 二维数组格式，方便插件界面和其他数据库插件读取。',
        '',
        '## 人物关系表 / RMF Index',
        toIndexTableText(buildRelationIndexTable(state)),
        '',
        '## 关系图节点 / RMF Index',
        toIndexTableText(buildGraphNodeIndexTable(state)),
        '',
        '## 关系图边 / RMF Index',
        toIndexTableText(buildGraphEdgeIndexTable(state)),
        '',
        '## Mermaid 兼容预览',
        '```mermaid',
        buildMermaid(state.tracker.relationships),
        '```',
    ].join('\n');
}

function buildIndexDatabaseBook(state) {
    return [
        '# RMF Index Database',
        'FORMAT: RMF_INDEX_TABLE / JSON_2D_ARRAY',
        '说明：每个表都以二维数组保存；第一行为字段名，后续为数据行。',
        '',
        ...buildAllIndexTables(state).map((table) => toIndexTableText(table)),
    ].join('\n\n');
}

function buildStateTablesBook(state) {
    return [
        '# RMF 状态档案设定表',
        toIndexTableText(buildCharacterStateIndexTable(state)),
        '',
        toIndexTableText(buildProfileIndexTable(state)),
        '',
        toIndexTableText(buildWorldSettingIndexTable(state)),
        '',
        toIndexTableText(buildInventoryIndexTable(state)),
        '',
        toIndexTableText(buildPromiseIndexTable(state)),
        '',
        toIndexTableText(buildPlotIndexTable(state)),
    ].join('\n');
}


function buildWalkthroughBook(state) {
    const last = state.walkthrough || {};
    return [
        '# RMF 走马灯回顾',
        `更新时间：${last.updatedAt || '暂无'}`,
        `覆盖轮数：${last.totalPairs || 0}`,
        '',
        last.content || '暂无。点击插件面板里的“走马灯回顾”后会生成完整剧情回顾。',
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


function safeCell(value, max = 600) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map((x) => safeCell(x, 120)).filter(Boolean).join('；');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function makeIndexTable(name, columns, rows = []) {
    return {
        name,
        mode: 'JSON_2D_ARRAY',
        columns,
        rows: rows.map((row) => columns.map((_, index) => safeCell(row[index] ?? ''))),
        updatedAt: nowIso(),
    };
}

function index2D(table) {
    return [table.columns, ...table.rows];
}

function toIndexTableText(table) {
    return [
        `<RMF_INDEX_TABLE name="${safeCell(table.name, 80)}" mode="${table.mode || 'JSON_2D_ARRAY'}" updated="${safeCell(table.updatedAt || nowIso(), 40)}">`,
        JSON.stringify(index2D(table), null, 2),
        '</RMF_INDEX_TABLE>',
    ].join('\n');
}

function collectRelationshipRows(state = getState()) {
    const direct = Array.isArray(state?.tracker?.relationships) ? state.tracker.relationships : [];
    const rows = [];
    const seen = new Map();
    const push = (item) => {
        const from = safeCell(item?.from || item?.人物A || item?.a || '', 80);
        const to = safeCell(item?.to || item?.人物B || item?.b || '', 80);
        if (!from || !to || from === to) return;
        const key = `${from}=>${to}`;
        const row = {
            from,
            to,
            relation: safeCell(item?.relation || item?.关系 || '互动', 120),
            attitude: safeCell(item?.attitude || item?.status || item?.当前状态 || '已有共同剧情记录', 240),
            tension: Number.isFinite(Number(item?.tension)) ? Number(item.tension) : '',
            evidence: safeCell(item?.evidence || item?.证据 || '', 360),
        };
        if (seen.has(key)) rows[seen.get(key)] = row;
        else {
            seen.set(key, rows.length);
            rows.push(row);
        }
    };
    direct.forEach(push);

    // 兜底：如果模型只给了“简记”但没填 relationships，仍然根据每轮 user/AI 自动生成基础关系线。
    if ((!rows.length || settings().autoFallbackRelationGraph) && Array.isArray(state?.records)) {
        const recentByPair = new Map();
        for (const r of state.records) {
            const from = safeCell(r.userName || '{{user}}', 80);
            const to = safeCell(r.aiName || state.characterName || getCharacterName(), 80);
            if (!from || !to || from === to) continue;
            recentByPair.set(`${from}=>${to}`, { from, to, brief: r.brief || fallbackBrief(r), id: r.id });
        }
        for (const item of recentByPair.values()) {
            push({
                from: item.from,
                to: item.to,
                relation: rows.length ? '持续互动' : '主线互动',
                attitude: `已有 ${state.records.length} 条简记；最近：#${item.id}`,
                tension: rows.length ? '' : 30,
                evidence: item.brief,
            });
        }
    }
    return rows;
}

function buildRelationIndexTable(state = getState()) {
    const rows = collectRelationshipRows(state).map((r, index) => [
        index + 1,
        r.from || '',
        r.to || '',
        r.relation || '',
        r.attitude || r.status || '',
        Number.isFinite(Number(r.tension)) ? Number(r.tension) : '',
        r.evidence || '',
    ]);
    return makeIndexTable('人物关系表', ['序号', '人物A', '人物B', '关系', '当前状态', '张力值', '证据'], rows);
}

function buildCharacterStateIndexTable(state = getState()) {
    const rows = Object.entries(state?.tracker?.characterStates || {}).map(([name, value], index) => [index + 1, name, value]);
    return makeIndexTable('角色状态表', ['序号', '角色', '状态'], rows);
}

function buildProfileIndexTable(state = getState()) {
    const rows = Object.entries(state?.tracker?.profiles || {}).map(([name, value], index) => [index + 1, name, value]);
    return makeIndexTable('人物档案表', ['序号', '人物', '档案'], rows);
}

function buildWorldSettingIndexTable(state = getState()) {
    const rows = (Array.isArray(state?.tracker?.worldSetting) ? state.tracker.worldSetting : []).map((value, index) => [index + 1, value]);
    return makeIndexTable('世界设定表', ['序号', '设定'], rows);
}

function buildInventoryIndexTable(state = getState()) {
    const inventory = state?.tracker?.inventory || {};
    const rows = Object.entries(inventory).flatMap(([owner, items]) => {
        const list = Array.isArray(items) ? items : [items];
        return list.map((item, i) => [owner, i + 1, item]);
    });
    return makeIndexTable('物品栏表', ['持有人', '序号', '物品/线索'], rows);
}

function buildPromiseIndexTable(state = getState()) {
    const rows = (Array.isArray(state?.tracker?.promises) ? state.tracker.promises : []).map((value, index) => [index + 1, value]);
    return makeIndexTable('约定表', ['序号', '约定/未完成事项'], rows);
}

function buildPlotIndexTable(state = getState()) {
    return makeIndexTable('剧情进度表', ['项目', '内容'], [
        ['当前剧情', state?.tracker?.currentPlot || ''],
        ['发展方向', state?.tracker?.development || ''],
        ['大总结覆盖到简记', state?.megaSummary?.coversRecordId || 0],
        ['世界书', state?.worldName || getWorldName()],
        ['同步来源', state?.worldSource || resolveWorldBookTarget({ allowFallback: true }).source],
    ]);
}

function buildRecordIndexTable(state = getState()) {
    const rows = visibleRecordsForDisplay(state).slice(-80).map((r) => [
        r.id,
        r.userName || '{{user}}',
        r.aiName || getCharacterName(),
        r.brief || '',
        r.createdAt || '',
    ]);
    return makeIndexTable('简记流水表', ['层号', '用户', 'AI', '简记', '时间'], rows);
}

function buildSummaryIndexTable(state = getState()) {
    const rows = (Array.isArray(state?.summaries) ? state.summaries : []).map((r) => [
        r.id,
        `${r.startRecordId || 0}-${r.endRecordId || 0}`,
        r.consolidated ? '已进入大总结' : '未合并',
        r.content || '',
        r.createdAt || '',
    ]);
    return makeIndexTable('阶段总结表', ['编号', '覆盖简记', '状态', '总结', '时间'], rows);
}

function buildGraphNodeIndexTable(state = getState()) {
    const graph = collectRelationGraph(state);
    const rows = graph.all.map((name, index) => [index + 1, name, name === graph.center ? '中心' : '外围', avatarUrlForName(name) || '']);
    return makeIndexTable('关系图节点表', ['序号', '人物', '节点类型', '头像'], rows);
}

function buildGraphEdgeIndexTable(state = getState()) {
    const graph = collectRelationGraph(state);
    const rows = graph.edges.map((r, index) => [
        index + 1,
        r.from || '',
        r.to || '',
        r.relation || '',
        r.attitude || r.status || '',
        Number.isFinite(Number(r.tension)) ? Number(r.tension) : '',
    ]);
    return makeIndexTable('关系图连线表', ['序号', '起点', '终点', '关系标签', '状态', '张力值'], rows);
}

function buildAllIndexTables(state = getState()) {
    return [
        buildRelationIndexTable(state),
        buildGraphNodeIndexTable(state),
        buildGraphEdgeIndexTable(state),
        buildCharacterStateIndexTable(state),
        buildProfileIndexTable(state),
        buildWorldSettingIndexTable(state),
        buildInventoryIndexTable(state),
        buildPromiseIndexTable(state),
        buildPlotIndexTable(state),
        buildRecordIndexTable(state),
        buildSummaryIndexTable(state),
    ];
}

function toAcuSheet(table, index) {
    return {
        name: table.name,
        content: [
            [null, ...table.columns],
            ...table.rows.map((row) => [null, ...table.columns.map((_, i) => safeCell(row[i] ?? '', 1200))]),
        ],
        sourceData: {
            note: 'Role Memory Forge 自动生成的数据库表；兼容 shujuku/TavernDB-ACU 的 content 二维表结构。',
            initNode: `初始化 ${table.name}`,
            insertNode: `新增 ${table.name}`,
            updateNode: `更新 ${table.name}`,
            deleteNode: `删除 ${table.name}`,
        },
        rmfIndex: index,
        updatedAt: table.updatedAt || nowIso(),
    };
}

function buildAcuCompatibleDatabase(state = getState(), { includeAllTables = true } = {}) {
    // shujuku / TavernDB-ACU 读取聊天内数据时，表 key 需要是 sheet_0、sheet_1……，并且 content 第一列保留 null。
    // 旧版 RMF 只写 0/1/2，ACU 不会当成有效表，所以这里改成真正的 sheet_* 结构。
    const result = {
        mate: {
            type: 'chatSheets',
            version: 1,
            source: 'Role Memory Forge',
            updatedAt: nowIso(),
        },
    };
    const tables = includeAllTables ? buildAllIndexTables(state) : [buildSummaryIndexTable(state), buildRecordIndexTable(state)];
    tables.forEach((table, index) => {
        result[`sheet_${index}`] = toAcuSheet(table, index);
    });
    return result;
}

function configureAcuIndexEntry(entry, content) {
    entry.comment = ACU_INDEX_ENTRY_COMMENT;
    entry.content = content || '{}';
    entry.key = ['__RMF_ACU_INDEX_DATA_DO_NOT_TRIGGER__'];
    entry.keysecondary = [];
    entry.disable = false;
    entry.enabled = true;
    entry.constant = false;
    entry.selective = true;
    entry.order = 10000;
    entry.position = 4;
    entry.depth = settings().injectDepth;
    entry.role = extension_prompt_roles.SYSTEM;
    entry.addMemo = true;
    entry.excludeRecursion = true;
    entry.preventRecursion = true;
    entry.matchWholeWords = false;
    entry.caseSensitive = false;
    entry.displayIndex = entry.displayIndex ?? 10000;
    return entry;
}

function upsertAcuIndexEntry(data, content) {
    let entry = Object.values(data.entries || {}).find((x) => x.comment === ACU_INDEX_ENTRY_COMMENT);
    if (!entry) entry = createWorldInfoEntry('', data);
    return configureAcuIndexEntry(entry, content);
}

function getLatestAssistantMessageForAcuSync() {
    const chat = context().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || msg.is_user || msg.is_system) continue;
        if (isRmfUtilityMessage(msg)) continue;
        return msg;
    }
    return null;
}

async function syncAcuDataToLatestAssistantMessage(state = getState()) {
    if (!settings().shujukuAcuChatDataSync) return false;
    const msg = getLatestAssistantMessageForAcuSync();
    if (!msg) return false;
    const allData = buildAcuCompatibleDatabase(state, { includeAllTables: true });
    const summaryData = buildAcuCompatibleDatabase(state, { includeAllTables: false });
    msg.TavernDB_ACU_IndependentData = allData;
    msg.TavernDB_ACU_Data = allData;
    msg.TavernDB_ACU_SummaryData = summaryData;
    msg.TavernDB_ACU_Identity = 'RMF';
    msg.TavernDB_ACU_RMF = true;
    msg.TavernDB_ACU_RMF_UpdatedAt = nowIso();
    await saveChatAfterMessagePatch();
    return true;
}


function compactIndexTableForPrompt(table, maxRows = 24) {
    const compact = { ...table, rows: table.rows.slice(0, maxRows) };
    return toIndexTableText(compact);
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
    const recentRecords = visibleRecordsForDisplay(state)
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
        compactIndexTableForPrompt(buildRelationIndexTable(state)),
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


function normalizeModelsUrl(baseUrl) {
    const url = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!url) throw new Error('API 地址为空');
    if (/\/models$/i.test(url)) return url;
    if (/\/chat\/completions$/i.test(url)) return url.replace(/\/chat\/completions$/i, '/models');
    if (/\/v1$/i.test(url)) return `${url}/models`;
    return `${url}/v1/models`;
}

function buildOpenAIHeaders(s) {
    const headers = { 'Content-Type': 'application/json' };
    const key = String(s?.apiKey || '').trim();
    if (key) headers.Authorization = `Bearer ${key}`;
    return headers;
}

async function fetchOpenAICompatibleModels() {
    const s = settings();
    const url = normalizeModelsUrl(s.baseUrl);
    const response = await fetch(url, {
        method: 'GET',
        headers: buildOpenAIHeaders(s),
        cache: 'no-cache',
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`模型列表拉取失败：${response.status} ${detail.slice(0, 220)}`);
    }
    const data = await response.json();
    const raw = Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.models) ? data.models
        : Array.isArray(data) ? data
        : [];
    const ids = raw.map((item) => {
        if (typeof item === 'string') return item;
        return item?.id || item?.name || item?.model || item?.root;
    }).filter(Boolean).map(String);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

function readApiSettingsFromPanel() {
    const s = settings();
    const val = (id) => document.querySelector(`#${id}`)?.value ?? '';
    s.source = val('rmf_source') || s.source || 'st';
    s.baseUrl = String(val('rmf_baseUrl') || '').trim();
    s.apiKey = String(val('rmf_apiKey') || '').trim();
    s.model = String(val('rmf_model') || '').trim();
    saveSettings();
    return s;
}

function populateModelSelectOptions() {
    const select = document.querySelector('#rmf_modelSelect');
    if (!select) return;
    const s = settings();
    const options = Array.isArray(s.modelOptions) ? s.modelOptions : [];
    const current = String(s.model || '').trim();
    select.innerHTML = '';
    select.append(new Option(options.length ? '请选择拉取到的模型' : '先点“拉取模型”', ''));
    if (current && !options.includes(current)) select.append(new Option(`当前：${current}`, current));
    for (const id of options) select.append(new Option(id, id));
    select.value = current && [...select.options].some((opt) => opt.value === current) ? current : '';
}

async function saveApiSettingsFromPanel({ silent = false } = {}) {
    const s = readApiSettingsFromPanel();
    populateModelSelectOptions();
    if (!silent) {
        toast(`API 配置已保存${s.model ? `：${s.model}` : ''}`, 'success');
        updateStatus('API 配置已保存');
    }
}

async function fetchModelsFromPanel() {
    try {
        updateStatus('正在拉取模型列表…');
        await saveApiSettingsFromPanel({ silent: true });
        const s = settings();
        if (s.source !== 'openai') {
            s.source = 'openai';
            const source = document.querySelector('#rmf_source');
            if (source) source.value = 'openai';
        }
        const models = await fetchOpenAICompatibleModels();
        if (!models.length) throw new Error('接口返回了空模型列表');
        s.modelOptions = models;
        if (!s.model || !models.includes(s.model)) s.model = models[0];
        saveSettings();
        refreshPanelValues();
        toast(`已拉取 ${models.length} 个模型`, 'success');
        updateStatus(`已拉取 ${models.length} 个模型`);
    } catch (error) {
        warn('fetch models failed', error);
        toast(error.message || '模型列表拉取失败', 'error');
        updateStatus(`模型拉取失败：${error.message || error}`);
    }
}

async function callOpenAICompatible(prompt, { json = true } = {}) {
    const s = settings();
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
        headers: buildOpenAIHeaders(s),
        body: JSON.stringify(body),
    });

    if (!response.ok && json) {
        delete body.response_format;
        response = await fetch(url, {
            method: 'POST',
            headers: buildOpenAIHeaders(s),
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
    return `你是 SillyTavern 角色扮演记忆插件的“实时填表器”。请根据【最新一轮对话】更新记忆。\n\n规则：\n1. 只记录已经发生、已经明确的信息；不要脑补，不要讨好 user，不要写“可能/似乎”。\n2. brief 用 1-2 句中文概括本轮，不写废话。\n3. tracker 必须返回“完整更新后的状态”，不是增量。\n4. 人物关系要保留矛盾、距离、亲密度变化、承诺、物品归属。\n5. 做爱/亲密行为只作为普通事件记录，不默认等于恋爱、告白或攻略成功，除非对话明确说明。
6. 不要返回 Markdown 表格；人物关系只放进 relationships 数组，插件会自动转成 RMF Index JSON 二维数组。\n\n【旧 tracker】\n${JSON.stringify(state.tracker || createEmptyTracker(), null, 2)}\n\n【最新一轮对话】\nUser：${userText}\nAI：${aiText}\n\n请只输出 JSON：\n{\n  "brief": "本轮简记",\n  "tracker": {\n    "characterStates": {"角色名":"当前身体/情绪/位置/目标等状态"},\n    "profiles": {"角色名":"稳定人物档案和已知事实"},\n    "relationships": [{"from":"人物A","to":"人物B","relation":"关系类型","attitude":"当前关系状态/张力","tension":0,"evidence":"证据"}],\n    "worldSetting": ["世界设定/地点/规则"],\n    "inventory": {"持有人":["物品/线索"]},\n    "promises": ["约定/未完成事项"],\n    "currentPlot": "当前剧情位置和正在发生的事",\n    "development": "自然的发展方向，不要替 user 决定行动"\n  }\n}`;
}

function buildChunkSummaryPrompt(records) {
    return `请把以下 ${records.length} 条“每轮简记”压缩成一段阶段总结。\n要求：中文；保留因果、人物关系变化、关键物品、约定、剧情推进；不要写分析废话；不要编造。\n\n${records.map((r) => `#${r.id} ${r.brief}`).join('\n')}\n\n只输出 JSON：{"summary":"阶段总结内容"}`;
}

function buildMegaSummaryPrompt({ oldMega, summaries }) {
    return `请把旧大总结和新的阶段总结合并成一个更稳定的大总结。\n要求：中文；保留长期有效事实、关系、世界设定、剧情主线、关键物品和承诺；删除重复；不要编造；不要过度细节化。\n\n【旧大总结】\n${oldMega || '暂无'}\n\n【新的阶段总结】\n${summaries.map((s, i) => `${i + 1}. ${s.content}`).join('\n')}\n\n只输出 JSON：{"megaSummary":"合并后的大总结"}`;
}


function makePairKey(userIndex, aiIndex, userText, aiText) {
    return `${userIndex}:${aiIndex}:${String(userText || '').slice(0, 80)}:${String(aiText || '').slice(0, 80)}`;
}

function pickFirstTextValue(...values) {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) {
            const nested = pickFirstTextValue(...value);
            if (nested) return nested;
            continue;
        }
        if (typeof value === 'object') continue;
        const text = String(value).trim();
        if (text) return text;
    }
    return '';
}

function collectNamedTextFields(obj, depth = 0, out = []) {
    if (!obj || typeof obj !== 'object' || depth > 3) return out;
    const wanted = /^(mes|message|content|text|body|value|display_text|displayText|raw|reply|response)$/i;
    for (const [key, value] of Object.entries(obj)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && wanted.test(key) && value.trim()) {
            out.push(value);
        } else if (Array.isArray(value)) {
            for (const item of value.slice(0, 4)) {
                if (typeof item === 'string' && wanted.test(key) && item.trim()) out.push(item);
                else if (item && typeof item === 'object') collectNamedTextFields(item, depth + 1, out);
            }
        } else if (typeof value === 'object' && !['extra', 'data', 'metadata', 'api_message', 'message', 'content', 'display'].includes(String(key)) && depth >= 2) {
            continue;
        } else if (typeof value === 'object') {
            collectNamedTextFields(value, depth + 1, out);
        }
    }
    return out;
}

function getDomMessageElement(index) {
    if (!Number.isFinite(Number(index))) return null;
    const escaped = globalThis.CSS?.escape ? CSS.escape(String(index)) : String(index).replace(/[\\"]/g, '\\$&');
    return document.querySelector(`.mes[mesid="${escaped}"], .mes[mesid='${escaped}'], [data-mes-id="${escaped}"], [data-message-id="${escaped}"]`);
}

function extractTextFromDomMessage(index) {
    const el = getDomMessageElement(index);
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script, style, .mes_buttons, .extraMesButtons, .mes_edit_buttons, .mes_timer, .timestamp, .rmf-brief-fold, [data-rmf-brief], .mesIDDisplay, .tokenCounterDisplay').forEach((x) => x.remove());
    const textEl = clone.querySelector('.mes_text, .mes_block .mes_text, .message_text, .swipe_text') || clone;
    return stripHtml(textEl.innerHTML || textEl.textContent || '');
}

function getDomMessageRole(index) {
    const el = getDomMessageElement(index);
    if (!el) return '';
    const raw = `${el.className || ''} ${el.getAttribute('is_user') || ''} ${el.dataset?.isUser || ''} ${el.getAttribute('data-is-user') || ''}`.toLowerCase();
    if (/user_mes|is_user[^a-z0-9]*true|true/.test(raw) && !/assistant|bot/.test(raw)) return 'user';
    if (/char_mes|assistant|bot|ai_mes|is_user[^a-z0-9]*false|false/.test(raw)) return 'assistant';
    const name = normalizeNameForScan(el.querySelector('.name_text, .ch_name, .mes_name')?.textContent || '');
    if (name && getKnownUserNamesForScan().has(name)) return 'user';
    if (name && getKnownAssistantNamesForScan().has(name)) return 'assistant';
    return '';
}

function getMessageRawContent(message, index = -1) {
    if (!message) return '';
    const swipeId = Number.isFinite(Number(message.swipe_id)) ? Number(message.swipe_id) : 0;
    const direct = pickFirstTextValue(
        message.mes,
        message.message,
        message.content,
        message.text,
        message.body,
        message.value,
        message.display_text,
        message.displayText,
        message.extra?.display_text,
        message.extra?.displayText,
        message.extra?.mes,
        message.extra?.message,
        message.extra?.content,
        message.extra?.text,
        message.data?.mes,
        message.data?.message,
        message.data?.content,
        message.data?.text,
        message.api_message?.content,
        message.extra?.api_message?.content,
        Array.isArray(message.swipes) ? (message.swipes[swipeId] || message.swipes[0]) : ''
    );
    if (direct) return direct;

    const named = collectNamedTextFields(message)
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)[0];
    if (named) return named;

    const idx = Number.isFinite(Number(index)) && Number(index) >= 0 ? Number(index) : (context().chat || []).indexOf(message);
    return extractTextFromDomMessage(idx);
}

function getMessageText(message, index = -1) {
    return stripHtml(getMessageRawContent(message, index));
}

function normalizeNameForScan(name = '') {
    return String(name || '')
        .replace(/[\s\u200b]+/g, '')
        .replace(/^@+/, '')
        .trim()
        .toLowerCase();
}

function getKnownUserNamesForScan() {
    const ctx = context();
    const names = new Set([
        ctx.name1,
        ctx.user?.name,
        ctx.userName,
        ctx.persona?.name,
        ctx.persona_description?.name,
        'user',
        '{{user}}',
        'you',
        '我',
        '你',
        '玩家',
        '用户',
    ].filter(Boolean).map(normalizeNameForScan));
    return names;
}

function getKnownAssistantNamesForScan() {
    const ctx = context();
    const char = ctx.characters?.[ctx.characterId];
    const names = new Set([
        getCharacterName(),
        ctx.name2,
        char?.name,
        char?.data?.name,
        'assistant',
        'ai',
    ].filter(Boolean).map(normalizeNameForScan));
    if (Array.isArray(ctx.groups) && ctx.groupId) {
        const group = ctx.groups.find((g) => String(g.id) === String(ctx.groupId));
        if (Array.isArray(group?.members)) {
            for (const member of group.members) {
                if (typeof member === 'string') names.add(normalizeNameForScan(member));
                if (member?.name) names.add(normalizeNameForScan(member.name));
            }
        }
    }
    return names;
}

function getMessageRole(message, index = -1) {
    if (!message) return 'empty';
    if (message.is_system || message.system || message.extra?.type === 'system') return 'system';
    if (isRmfUtilityMessage(message)) return 'system';

    const roleFields = [message.role, message.sender, message.type, message.extra?.role, message.extra?.sender, message.data?.role]
        .filter(Boolean).map((x) => String(x).toLowerCase());
    if (roleFields.some((x) => ['system', 'instruction'].includes(x))) return 'system';
    if (roleFields.some((x) => ['user', 'human', 'player'].includes(x))) return 'user';
    if (roleFields.some((x) => ['assistant', 'character', 'bot', 'ai', 'model'].includes(x))) return 'assistant';

    if (message.is_user === true || message.is_user === 'true' || message.isUser === true) return 'user';
    if (message.is_user === false || message.is_user === 'false' || message.isUser === false) return 'assistant';

    const domRole = getDomMessageRole(index);
    if (domRole) return domRole;

    const name = normalizeNameForScan(message.name || message.user || message.from || message.sender_name || message.extra?.name || message.data?.name || '');
    const userNames = getKnownUserNamesForScan();
    const assistantNames = getKnownAssistantNamesForScan();
    if (name && userNames.has(name)) return 'user';
    if (name && assistantNames.has(name)) return 'assistant';

    const text = getMessageText(message, index);
    if (!text) return 'empty';

    // 有些导入的 json/jsonl 没有 is_user，只保留 name。只要名字不是当前 user，就按角色/AI 处理。
    if (name && !userNames.has(name)) return 'assistant';
    return 'unknown';
}

function exchangeFromIndexes(chat, userIndex, aiIndex) {
    const userText = getMessageText(chat[userIndex], userIndex);
    const aiText = getMessageText(chat[aiIndex], aiIndex);
    if (!userText || !aiText) return null;
    return {
        pairKey: makePairKey(userIndex, aiIndex, userText, aiText),
        userIndex,
        aiIndex,
        userText,
        aiText,
        userName: chat[userIndex].name || context().name1 || '{{user}}',
        aiName: chat[aiIndex].name || getCharacterName(),
    };
}

function pushUniquePair(target, seen, exchange) {
    if (!exchange || seen.has(exchange.pairKey)) return;
    seen.add(exchange.pairKey);
    target.push(exchange);
}

function buildSequentialPairs(chat, roles) {
    const pairs = [];
    const seen = new Set();
    let waitingUserIndex = -1;

    for (let i = 0; i < chat.length; i++) {
        const role = roles[i];
        if (role === 'system' || role === 'empty') continue;
        if (role === 'user') {
            waitingUserIndex = i;
            continue;
        }
        if ((role === 'assistant' || role === 'unknown') && waitingUserIndex >= 0) {
            pushUniquePair(pairs, seen, exchangeFromIndexes(chat, waitingUserIndex, i));
            waitingUserIndex = -1;
        }
    }
    return pairs;
}

function buildNearestUserPairs(chat, roles) {
    const pairs = [];
    const seen = new Set();
    for (let aiIndex = 0; aiIndex < chat.length; aiIndex++) {
        const role = roles[aiIndex];
        if (role !== 'assistant' && role !== 'unknown') continue;
        if (!getMessageText(chat[aiIndex], aiIndex)) continue;
        let userIndex = -1;
        for (let j = aiIndex - 1; j >= 0; j--) {
            if (roles[j] === 'system' || roles[j] === 'empty') continue;
            if (roles[j] === 'user') {
                userIndex = j;
                break;
            }
            // 如果中间已经出现另一个 assistant，仍继续往前找 user，兼容多角色/旁白导入。
        }
        if (userIndex >= 0) pushUniquePair(pairs, seen, exchangeFromIndexes(chat, userIndex, aiIndex));
    }
    return pairs;
}

function buildAlternatingFallbackPairs(chat, roles) {
    // 最后兜底：某些外部 jsonl 导入会丢失 is_user/name，只剩纯文本顺序。
    // 这种情况下按“奇偶层”尝试成对，但只有在正常扫描很少时才会使用。
    const candidates = [];
    for (let i = 0; i < chat.length; i++) {
        if (roles[i] === 'system' || roles[i] === 'empty') continue;
        const text = getMessageText(chat[i], i);
        if (!text) continue;
        candidates.push(i);
    }
    const pairs = [];
    const seen = new Set();
    const start = roles[candidates[0]] === 'assistant' ? 1 : 0;
    for (let i = start; i < candidates.length - 1; i += 2) {
        const userIndex = candidates[i];
        const aiIndex = candidates[i + 1];
        pushUniquePair(pairs, seen, exchangeFromIndexes(chat, userIndex, aiIndex));
    }
    return pairs;
}

function buildLooseDomFallbackPairs(chat) {
    // 极限兜底：部分导入记录在 ctx.chat 里被标成 system/empty，但 DOM 里仍有完整聊天文本。
    // 这时不再信任 role，只按实际可读文本的楼层顺序两两配对。
    const candidates = [];
    for (let i = 0; i < chat.length; i++) {
        if (isRmfUtilityMessage(chat[i])) continue;
        const text = getMessageText(chat[i], i);
        if (!text) continue;
        // 跳过明显的 RMF 自身回顾或系统提示，避免污染历史补录。
        if (/Role Memory Forge|RMF_INDEX_TABLE|RMF_WALKTHROUGH_START|TavernDB-ACU-RMF/i.test(text)) continue;
        candidates.push(i);
    }
    const pairs = [];
    const seen = new Set();
    const firstRole = getDomMessageRole(candidates[0]) || getMessageRole(chat[candidates[0]], candidates[0]);
    const start = firstRole === 'assistant' ? 1 : 0;
    for (let i = start; i < candidates.length - 1; i += 2) {
        pushUniquePair(pairs, seen, exchangeFromIndexes(chat, candidates[i], candidates[i + 1]));
    }
    return pairs;
}

function getAllChatExchanges() {
    const chat = context().chat || [];
    const roles = chat.map((message, index) => getMessageRole(message, index));

    const sequential = buildSequentialPairs(chat, roles);
    const nearest = buildNearestUserPairs(chat, roles);
    const alternating = buildAlternatingFallbackPairs(chat, roles);
    const loose = buildLooseDomFallbackPairs(chat);

    let best = sequential;
    if (nearest.length > best.length) best = nearest;
    // 当正常识别明显过少时，用纯顺序兜底；避免你导入 200 多层却只识别到 3 轮。
    if ((best.length < 5 || alternating.length > best.length * 2) && alternating.length > best.length) best = alternating;
    if ((best.length < 10 || loose.length > best.length * 2) && loose.length > best.length) best = loose;

    best.sort((a, b) => a.aiIndex - b.aiIndex || a.userIndex - b.userIndex);
    const uniq = [];
    const seen = new Set();
    for (const pair of best) pushUniquePair(uniq, seen, pair);
    return uniq;
}

function getChatScanStats() {
    const chat = context().chat || [];
    const roles = chat.map((message, index) => getMessageRole(message, index));
    let domText = 0;
    let objectText = 0;
    chat.forEach((message, index) => {
        const direct = pickFirstTextValue(message?.mes, message?.message, message?.content, message?.text, message?.body, message?.value, Array.isArray(message?.swipes) ? message.swipes[0] : '');
        if (direct) objectText += 1;
        if (!direct && extractTextFromDomMessage(index)) domText += 1;
    });
    return {
        messages: chat.length,
        user: roles.filter((x) => x === 'user').length,
        assistant: roles.filter((x) => x === 'assistant').length,
        unknown: roles.filter((x) => x === 'unknown').length,
        system: roles.filter((x) => x === 'system').length,
        empty: roles.filter((x) => x === 'empty').length,
        objectText,
        domText,
        textMessages: chat.filter((message, index) => !!getMessageText(message, index)).length,
        pairs: getAllChatExchanges().length,
    };
}

function getLatestExchange() {
    const chat = context().chat || [];
    const roles = chat.map((message, index) => getMessageRole(message, index));
    let aiIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        const role = roles[i];
        if ((role === 'assistant' || role === 'unknown') && getMessageText(chat[i], i)) {
            aiIndex = i;
            break;
        }
    }
    if (aiIndex <= 0) return null;
    let userIndex = -1;
    for (let i = aiIndex - 1; i >= 0; i--) {
        if (roles[i] === 'user' && getMessageText(chat[i], i)) {
            userIndex = i;
            break;
        }
    }
    if (userIndex < 0) return null;
    return exchangeFromIndexes(chat, userIndex, aiIndex);
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
        const tracker = enrichTrackerWithExchange(normalizeTracker(json.tracker, state.tracker), exchange, brief);

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
        await hideSummarizedBriefFolds(state);
        await saveState();
        if (settings().autoSyncWorldBook) {
            await writeWorldBook();
        }
        await syncAcuDataToLatestAssistantMessage(state).catch((error) => warn('ACU chat data sync failed', error));
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

function normalizeRelationshipItem(item) {
    const from = safeCell(item?.from || item?.人物A || item?.a || '', 80);
    const to = safeCell(item?.to || item?.人物B || item?.b || '', 80);
    if (!from || !to || from === to) return null;
    return {
        from,
        to,
        relation: safeCell(item?.relation || item?.关系 || '互动', 120),
        attitude: safeCell(item?.attitude || item?.status || item?.当前状态 || '已有互动', 240),
        tension: Number.isFinite(Number(item?.tension)) ? Number(item.tension) : '',
        evidence: safeCell(item?.evidence || item?.证据 || '', 360),
    };
}

function mergeRelationshipLists(previous = [], next = []) {
    const rows = [];
    const seen = new Map();
    const push = (item) => {
        const r = normalizeRelationshipItem(item);
        if (!r) return;
        const key = `${r.from}=>${r.to}`;
        if (seen.has(key)) rows[seen.get(key)] = { ...rows[seen.get(key)], ...r };
        else {
            seen.set(key, rows.length);
            rows.push(r);
        }
    };
    (Array.isArray(previous) ? previous : []).forEach(push);
    (Array.isArray(next) ? next : []).forEach(push);
    return rows.slice(-80);
}

function makeFallbackTrackerFromExchange(exchange, brief = '') {
    const userName = safeCell(exchange?.userName || '{{user}}', 80);
    const aiName = safeCell(exchange?.aiName || getCharacterName(), 80);
    const evidence = safeCell(brief || fallbackBrief(exchange || {}), 360);
    const tracker = createEmptyTracker();
    if (userName) tracker.characterStates[userName] = `刚参与本轮互动：${evidence}`;
    if (aiName) tracker.characterStates[aiName] = `刚回应本轮互动：${evidence}`;
    if (userName) tracker.profiles[userName] = tracker.profiles[userName] || '当前聊天中的用户/主控角色。';
    if (aiName) tracker.profiles[aiName] = tracker.profiles[aiName] || '当前角色卡 AI 角色。';
    if (userName && aiName && userName !== aiName) {
        tracker.relationships.push({
            from: userName,
            to: aiName,
            relation: '主线互动',
            attitude: '已产生对话与剧情推进',
            tension: 30,
            evidence,
        });
    }
    tracker.currentPlot = evidence;
    tracker.development = '等待 user 下一步行动，AI 不替 user 做决定。';
    return tracker;
}

function enrichTrackerWithExchange(tracker, exchange, brief = '') {
    const fallback = makeFallbackTrackerFromExchange(exchange, brief);
    const merged = normalizeTracker(fallback, tracker);
    if (!merged.currentPlot) merged.currentPlot = fallback.currentPlot;
    if (!merged.development) merged.development = fallback.development;
    merged.relationships = mergeRelationshipLists(tracker?.relationships || [], fallback.relationships || []);
    return merged;
}

function normalizeTracker(next, previous) {
    const base = createEmptyTracker();
    const merged = { ...base, ...(previous || {}), ...(next || {}) };
    merged.characterStates = typeof merged.characterStates === 'object' && !Array.isArray(merged.characterStates) ? merged.characterStates : {};
    merged.profiles = typeof merged.profiles === 'object' && !Array.isArray(merged.profiles) ? merged.profiles : {};
    merged.relationships = mergeRelationshipLists(previous?.relationships || [], Array.isArray(merged.relationships) ? merged.relationships : []);
    merged.worldSetting = Array.isArray(merged.worldSetting) ? merged.worldSetting : [];
    merged.inventory = typeof merged.inventory === 'object' && !Array.isArray(merged.inventory) ? merged.inventory : {};
    merged.promises = Array.isArray(merged.promises) ? merged.promises : [];
    merged.currentPlot = String(merged.currentPlot || '');
    merged.development = String(merged.development || '');
    merged.relationIndexFormat = 'RMF_INDEX_TABLE/JSON_2D_ARRAY + TavernDB_ACU sheet_*';
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
    let content = '';
    try {
        const raw = await callMemoryModel(buildChunkSummaryPrompt(chunk), { json: true });
        const json = parseJsonLoose(raw);
        content = String(json.summary || raw || '').trim();
    } catch (error) {
        warn('chunk summary fallback used', error);
        content = chunk.map((r) => `#${r.id} ${r.brief}`).join('；').slice(0, 3000);
    }
    state.summaries.push({
        id: (state.summaries.at(-1)?.id || 0) + 1,
        startRecordId: chunk[0].id,
        endRecordId: chunk.at(-1).id,
        content,
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
    let content = '';
    try {
        const raw = await callMemoryModel(buildMegaSummaryPrompt({ oldMega: state.megaSummary.content, summaries: batch }), { json: true });
        const json = parseJsonLoose(raw);
        content = String(json.megaSummary || raw || '').trim();
    } catch (error) {
        warn('mega summary fallback used', error);
        content = [state.megaSummary.content || '', ...batch.map((x) => x.content)].filter(Boolean).join('\n').slice(0, 6000);
    }
    state.megaSummary = {
        content,
        coversRecordId: batch.at(-1).endRecordId,
        coversSummaryCount: (state.megaSummary.coversSummaryCount || 0) + batch.length,
        updatedAt: nowIso(),
    };
    for (const summary of batch) {
        summary.consolidated = true;
    }
}

async function hideSummarizedBriefFolds(state = getState()) {
    if (!settings().autoHideSummarizedBriefs) return;
    const covered = getCoveredRecordIdForHiding(state);
    if (!covered) return;
    const chat = context().chat || [];
    let changed = false;
    for (const record of state.records || []) {
        if (Number(record.id || 0) > covered || record.foldHidden) continue;
        const msg = chat[record.aiIndex];
        if (msg?.mes && String(msg.mes).includes('RMF_BRIEF_START')) {
            msg.mes = stripRmfFoldHtml(msg.mes);
            changed = true;
        }
        record.foldHidden = true;
    }
    if (changed) await saveChatAfterMessagePatch();
}

function scheduleProcessLatest() {
    if (!settings().enabled || !settings().autoProcess) return;
    setTimeout(() => processLatestExchange(), 500);
}

function updateStatus(text) {
    const el = document.querySelector('#rmf_status');
    if (el) el.textContent = text;
}


async function rescanCurrentChat({ confirmFirst = true, clearFirst = true, label = '历史聊天记录' } = {}) {
    const s = settings();
    if (!s.enabled) return toast('请先启用插件。', 'warning');
    const pairs = getAllChatExchanges();
    const scan = getChatScanStats();
    if (!pairs.length) {
        toast('没有找到可补录的 user/AI 对话轮。', 'warning');
        updateStatus(`扫描结果：消息 ${scan.messages}，user ${scan.user}，AI ${scan.assistant}，未知 ${scan.unknown}，DOM补文 ${scan.domText}，成对 0`);
        return;
    }
    if (confirmFirst) {
        const ok = confirm(`即将从 0 层开始一键记忆 ${pairs.length} 轮${label}。\n\n扫描到：总消息 ${scan.messages} 条；user ${scan.user} 条；AI ${scan.assistant} 条；未知 ${scan.unknown} 条；系统/空消息 ${scan.system + scan.empty} 条；对象文本 ${scan.objectText} 条；DOM补全文本 ${scan.domText} 条；可读文本楼层 ${scan.textMessages} 条。\n\n这会调用总结模型逐轮补录，聊天越长耗时越久。是否开始？`);
        if (!ok) return;
    }

    if (clearFirst) await clearCurrentMemory({ clearWorld: true, silent: true });
    toast(`开始一键记忆 ${pairs.length} 轮${label}。`, 'info');
    updateStatus(`历史补录准备中：0/${pairs.length}`);

    const saveEvery = clampNumber(s.historyBatchSaveEvery, 1, 25, DEFAULT_SETTINGS.historyBatchSaveEvery);
    let okCount = 0;
    let failCount = 0;

    for (let i = 0; i < pairs.length; i++) {
        const exchange = pairs[i];
        const state = getState();
        if (state.processedPairs.includes(exchange.pairKey)) continue;
        try {
            updateStatus(`一键记忆历史聊天：${i + 1}/${pairs.length}`);
            let json = {};
            let usedFallback = false;
            try {
                const raw = await callMemoryModel(buildPairPrompt({ ...exchange, state }), { json: true });
                json = parseJsonLoose(raw);
            } catch (innerError) {
                // 历史补录时经常会遇到旧记录过长、模型空回复、非 JSON 等情况。
                // 不让整段补录失败，先用可读文本生成兜底简记，后续阶段总结仍会继续压缩。
                usedFallback = true;
                warn('history pair used fallback brief', innerError);
            }
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
                fallback: usedFallback,
                createdAt: nowIso(),
            });
            state.tracker = enrichTrackerWithExchange(normalizeTracker(json.tracker, state.tracker), exchange, String(json.brief || '').trim() || fallbackBrief(exchange));
            state.processedPairs.push(exchange.pairKey);
            state.processedPairs = state.processedPairs.slice(-Math.max(200, s.maxRecordsStored));
            state.records = state.records.slice(-clampNumber(s.maxRecordsStored, 50, 5000, DEFAULT_SETTINGS.maxRecordsStored));
            await maybeCreateChunkSummary(state);
            await maybeCreateMegaSummary(state);
            await hideSummarizedBriefFolds(state);
            okCount += 1;
            if (okCount % saveEvery === 0) {
                await saveState();
                if (settings().autoSyncWorldBook) await writeWorldBook().catch((error) => warn('history sync failed', error));
                await syncAcuDataToLatestAssistantMessage(state).catch((error) => warn('history ACU chat data sync failed', error));
            }
        } catch (error) {
            failCount += 1;
            warn('history rescan pair failed', exchange, error);
        }
    }

    await saveState();
    if (settings().autoSyncWorldBook) await writeWorldBook().catch((error) => warn('history final sync failed', error));
    await syncAcuDataToLatestAssistantMessage(getState()).catch((error) => warn('history final ACU sync failed', error));
    refreshDashboard();
    updateStatus(`历史补录完成：成功 ${okCount}，失败 ${failCount}`);
    toast(`历史聊天记忆完成：成功 ${okCount} 轮，失败 ${failCount} 轮。`, failCount ? 'warning' : 'success');
}

async function oneClickRememberHistory() {
    return await rescanCurrentChat({ confirmFirst: true, clearFirst: true, label: '导入/历史聊天记录' });
}

function buildTranscriptForPrompt(exchanges) {
    return exchanges.map((ex, index) => [
        `【第 ${index + 1} 轮｜chat ${ex.userIndex}->${ex.aiIndex}】`,
        `${ex.userName || 'User'}：${ex.userText}`,
        `${ex.aiName || getCharacterName()}：${ex.aiText}`,
    ].join('\n')).join('\n\n');
}

function chunkExchanges(exchanges, chunkPairs) {
    const size = clampNumber(chunkPairs, 4, 60, DEFAULT_SETTINGS.walkThroughChunkPairs);
    const chunks = [];
    for (let i = 0; i < exchanges.length; i += size) {
        chunks.push(exchanges.slice(i, i + size));
    }
    return chunks;
}

function buildWalkthroughChunkPrompt({ chunk, part, total }) {
    return `你是 SillyTavern 角色卡聊天记录“走马灯回顾”整理器。请根据下面第 ${part}/${total} 段聊天，提取详细但不啰嗦的剧情概况。\n\n要求：\n1. 按时间顺序写清楚发生了什么。\n2. 保留人物关系变化、情绪变化、重要物品、承诺、世界设定、冲突和伏笔。\n3. 不要替 user 编造没说过的话，不要把推测写成事实。\n4. 输出 JSON。\n\n【聊天片段】\n${buildTranscriptForPrompt(chunk)}\n\n只输出 JSON：{\"overview\":\"这一段的详细概况\",\"keyFacts\":[\"关键事实1\"],\"relationships\":[\"关系变化1\"],\"openThreads\":[\"未解决事项1\"]}`;
}

function buildWalkthroughFinalPrompt({ state, overviews, totalPairs }) {
    const memorySnapshot = JSON.stringify({
        megaSummary: state.megaSummary,
        summaries: state.summaries,
        tracker: state.tracker,
        recentRecords: state.records.slice(-20).map((r) => `#${r.id} ${r.brief}`),
    }, null, 2);
    const overviewText = overviews.map((x, i) => `## 第 ${i + 1} 段\n${x}`).join('\n\n');
    return `你是 SillyTavern 角色卡聊天记录“走马灯回顾”整理器。请把下面的分段概况整合成一条可以直接作为 AI 回复发到聊天里的“完整走马灯回顾”。\n\n写法要求：\n- 中文，详细、清晰、有时间线。\n- 像在回放这张角色卡从第 0 层到现在的全部剧情。\n- 分成：总览、时间线、人物关系变化、角色状态/人物档案、世界设定/物品栏/约定、当前剧情停留点、后续可能发展、插件记忆测试点。\n- 不要写成 Markdown 表格。\n- 不要替 user 决定后续行动。\n- 可以用小标题和编号。\n\n【当前插件记忆状态】\n${memorySnapshot}\n\n【分段概况，共 ${totalPairs} 轮】\n${overviewText}\n\n请直接输出最终走马灯回顾正文。`;
}

function normalizeOverviewJson(raw) {
    try {
        const json = parseJsonLoose(raw);
        const parts = [];
        if (json.overview) parts.push(String(json.overview));
        if (Array.isArray(json.keyFacts) && json.keyFacts.length) parts.push(`关键事实：${json.keyFacts.join('；')}`);
        if (Array.isArray(json.relationships) && json.relationships.length) parts.push(`关系变化：${json.relationships.join('；')}`);
        if (Array.isArray(json.openThreads) && json.openThreads.length) parts.push(`未解决事项：${json.openThreads.join('；')}`);
        return parts.join('\n') || String(raw || '').trim();
    } catch (_) {
        return String(raw || '').trim();
    }
}

async function addAssistantMessageToChat(content) {
    const ctx = context();
    const message = {
        name: getCharacterName(),
        is_user: false,
        is_system: false,
        mes: `${WALKTHROUGH_MARK}\n${content}\n${WALKTHROUGH_END}`,
        send_date: Date.now(),
        extra: { type: 'rmf_walkthrough', title: 'Role Memory Forge 走马灯回顾' },
    };
    if (typeof ctx.addOneMessage === 'function') {
        await ctx.addOneMessage(message);
    } else {
        ctx.chat ||= [];
        ctx.chat.push(message);
        await saveChatAfterMessagePatch();
        ctx.reloadCurrentChat?.();
    }
    await saveChatAfterMessagePatch();
}

async function generateWalkthrough() {
    const s = settings();
    if (!s.enabled) return toast('请先启用插件。', 'warning');
    const allPairs = getAllChatExchanges();
    if (!allPairs.length) return toast('没有找到可生成走马灯的聊天记录。', 'warning');
    const maxPairs = clampNumber(s.walkThroughMaxPairs, 20, 1000, DEFAULT_SETTINGS.walkThroughMaxPairs);
    const pairs = allPairs.length > maxPairs ? allPairs.slice(-maxPairs) : allPairs;
    const skipped = allPairs.length - pairs.length;
    const chunks = chunkExchanges(pairs, s.walkThroughChunkPairs);
    const overviews = [];

    const ok = confirm(`将生成“走马灯回顾”。\n\n检测到 ${allPairs.length} 轮聊天，本次会回顾 ${pairs.length} 轮${skipped > 0 ? `（前面 ${skipped} 轮因上限略过，可在设置里调高上限）` : ''}。\n这会调用模型 ${chunks.length + 1} 次。是否开始？`);
    if (!ok) return;

    updateStatus(`走马灯生成中：0/${chunks.length}`);
    toast('开始生成走马灯回顾。', 'info');
    for (let i = 0; i < chunks.length; i++) {
        updateStatus(`走马灯分段整理：${i + 1}/${chunks.length}`);
        const raw = await callMemoryModel(buildWalkthroughChunkPrompt({ chunk: chunks[i], part: i + 1, total: chunks.length }), { json: true });
        overviews.push(normalizeOverviewJson(raw));
    }

    const state = getState();
    updateStatus('走马灯最终整合中……');
    let content = await callMemoryModel(buildWalkthroughFinalPrompt({ state, overviews, totalPairs: pairs.length }), { json: false });
    content = String(content || '').trim();
    if (!content) throw new Error('模型没有返回走马灯正文');
    if (skipped > 0) {
        content = `> 注：当前设置最多回顾 ${maxPairs} 轮，本次从较新的 ${pairs.length} 轮开始生成；想从最早 0 层完整回顾，请调高“走马灯最多回顾轮数”。\n\n${content}`;
    }

    state.walkthrough = { content, totalPairs: pairs.length, updatedAt: nowIso() };
    await saveState();
    if (settings().autoSyncWorldBook) await writeWorldBook().catch((error) => warn('walkthrough sync failed', error));
    if (settings().walkThroughAddToChat) {
        await addAssistantMessageToChat(content);
    }
    refreshDashboard();
    updateStatus('走马灯回顾已生成。');
    toast('走马灯回顾已生成。', 'success');
}


function openRmfPanel() {
    renderSettingsPanel();
    const modal = document.querySelector('#rmf_modal');
    modal?.classList.remove('rmf-hidden');
    modal?.setAttribute('aria-hidden', 'false');
    refreshPanelValues();
    refreshDashboard();
}

function closeRmfPanel() {
    const modal = document.querySelector('#rmf_modal');
    modal?.classList.add('rmf-hidden');
    modal?.setAttribute('aria-hidden', 'true');
}

function renderInlineEntry() {
    if (document.querySelector('#rmf_extension_drawer')) return;
    const host = document.querySelector('#extensions_settings2')
        || document.querySelector('#extensions_settings')
        || document.querySelector('.extensions_settings')
        || document.querySelector('#extensions_panel');
    if (!host) return;

    const html = `
    <div id="rmf_extension_drawer" class="rmf-extension-drawer inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header rmf-extension-header">
            <div class="rmf-extension-header-title">
                <span class="rmf-mini-orb">🧠</span>
                <b>Role Memory Forge</b>
                <small>记忆插件</small>
            </div>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content rmf-extension-content">
            <div class="rmf-extension-row">
                <label class="checkbox_label"><input id="rmf_inline_enabled" type="checkbox"> 启用记忆</label>
                <label class="checkbox_label"><input id="rmf_inline_autoSync" type="checkbox"> 自动同步世界书</label>
                <label class="checkbox_label"><input id="rmf_inline_append" type="checkbox"> 回复结尾折叠简记</label>
            </div>
            <div class="rmf-extension-buttons">
                <button id="rmf_inline_open" class="menu_button">打开记忆面板</button>
                <button id="rmf_inline_process" class="menu_button">手动记录最新一轮</button>
                <button id="rmf_inline_history" class="menu_button">一键记忆历史</button>
                <button id="rmf_inline_walkthrough" class="menu_button">走马灯回顾</button>
                <button id="rmf_inline_sync" class="menu_button">同步世界书</button>
            </div>
            <div id="rmf_inline_status" class="rmf-inline-status">悬浮球消失时，也可以从这里打开。</div>
        </div>
    </div>`;
    host.insertAdjacentHTML('beforeend', html);

    document.querySelector('#rmf_inline_open')?.addEventListener('click', openRmfPanel);
    document.querySelector('#rmf_inline_process')?.addEventListener('click', () => processLatestExchange({ force: true }));
    document.querySelector('#rmf_inline_history')?.addEventListener('click', () => oneClickRememberHistory());
    document.querySelector('#rmf_inline_walkthrough')?.addEventListener('click', () => generateWalkthrough().catch((error) => { warn('walkthrough failed', error); toast(`走马灯失败：${error.message}`, 'error'); updateStatus(`走马灯失败：${error.message}`); }));
    document.querySelector('#rmf_inline_sync')?.addEventListener('click', async () => {
        await writeWorldBook();
        toast('已同步到世界书。', 'success');
    });
    document.querySelector('#rmf_inline_enabled')?.addEventListener('change', async (event) => {
        const s = settings();
        s.enabled = Boolean(event.target.checked);
        saveSettings();
        if (s.enabled) {
            await restoreStateFromWorldBookIfNeeded();
            refreshPromptInjection();
            await writeWorldBook().catch((error) => warn('inline writeWorldBook failed', error));
        } else {
            refreshPromptInjection();
        }
        refreshPanelValues();
        refreshDashboard();
    });
    document.querySelector('#rmf_inline_autoSync')?.addEventListener('change', (event) => {
        settings().autoSyncWorldBook = Boolean(event.target.checked);
        saveSettings();
        refreshPanelValues();
    });
    document.querySelector('#rmf_inline_append')?.addEventListener('change', (event) => {
        settings().appendBriefToMessage = Boolean(event.target.checked);
        saveSettings();
        refreshPanelValues();
    });
    refreshInlineValues();
}

function refreshInlineValues() {
    const s = settings();
    const enabled = document.querySelector('#rmf_inline_enabled');
    const append = document.querySelector('#rmf_inline_append');
    const autoSync = document.querySelector('#rmf_inline_autoSync');
    const status = document.querySelector('#rmf_inline_status');
    if (enabled) enabled.checked = !!s.enabled;
    if (append) append.checked = !!s.appendBriefToMessage;
    if (autoSync) autoSync.checked = !!s.autoSyncWorldBook;
    if (status) {
        const state = getStateSafe();
        const target = getWorldTargetLabel();
        status.textContent = `状态：${s.enabled ? '已启用' : '未启用'}｜简记 ${state?.records?.length || 0} 条｜同步目标：${target}`;
    }
}

function getStateSafe() {
    try { return getState(); } catch (_) { return null; }
}

function getWorldNameSafe() {
    try { return getWorldName(); } catch (_) { return '未检测到角色卡自带世界书'; }
}

function getWorldTargetLabel() {
    try {
        const target = resolveWorldBookTarget({ allowFallback: true });
        return target.worldName ? `${target.source}：${target.worldName}` : target.source;
    } catch (_) {
        return getWorldNameSafe();
    }
}

function renderSettingsPanel() {
    renderInlineEntry();
    // 旧版因为只判断 #rmf_settings，导致扩展面板没有入口；这里保证悬浮球、弹窗、扩展入口都能被补建。
    if (document.querySelector('#rmf_settings') && document.querySelector('#rmf_float_button')) {
        refreshPanelValues();
        refreshDashboard();
        return;
    }
    document.querySelector('#rmf_float_button')?.remove();
    document.querySelector('#rmf_modal')?.remove();
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
                    <small>分层总结 / 实时填表 / RMF Index 数据库 / 世界书记忆</small>
                </div>
                <span id="rmf_status" class="rmf-status">待机</span>
                <button id="rmf_close" class="rmf-icon-btn" title="关闭">×</button>
            </div>

            <div class="rmf-quick-row">
                <label class="rmf-switch"><input id="rmf_enabled" type="checkbox"><span></span><b>启用记忆</b></label>
                <label class="rmf-switch"><input id="rmf_auto" type="checkbox"><span></span><b>AI 回复后实时填表</b></label>
                <label class="rmf-switch"><input id="rmf_autoSyncWorldBook" type="checkbox"><span></span><b>自动同步到世界书</b></label>
                <label class="rmf-switch"><input id="rmf_appendBrief" type="checkbox"><span></span><b>回复结尾折叠简记</b></label>
                <label class="rmf-switch"><input id="rmf_autoHideSummarizedBriefs" type="checkbox"><span></span><b>总结后隐藏旧简记</b></label>
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
                                <input id="rmf_apiKey" type="password" autocomplete="off" placeholder="sk-...；本地接口可留空">
                            </label>
                            <label>模型选择
                                <select id="rmf_modelSelect">
                                    <option value="">先点“拉取模型”</option>
                                </select>
                            </label>
                            <label>模型名 / 手动填写
                                <input id="rmf_model" type="text" placeholder="gpt-4o-mini / deepseek-chat / Qwen...">
                            </label>
                            <div class="rmf-api-actions">
                                <button id="rmf_saveApi" class="menu_button" type="button">保存 API 配置</button>
                                <button id="rmf_fetchModels" class="menu_button rmf-primary-action" type="button">拉取模型</button>
                            </div>
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
                        <summary>历史补录与走马灯</summary>
                        <div class="rmf-grid">
                            <label>历史补录每几轮保存一次
                                <input id="rmf_historyBatchSaveEvery" type="number" min="1" max="25">
                            </label>
                            <label>走马灯每段处理轮数
                                <input id="rmf_walkThroughChunkPairs" type="number" min="4" max="60">
                            </label>
                            <label>走马灯最多回顾轮数
                                <input id="rmf_walkThroughMaxPairs" type="number" min="20" max="1000">
                            </label>
                            <label class="rmf-checkline"><input id="rmf_walkThroughAddToChat" type="checkbox"> 走马灯生成后作为 AI 回复写入聊天</label>
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
                            <label>世界书同步目标
                                <select id="rmf_worldSyncMode">
                                    <option value="character">角色卡自带世界书（推荐，不新建）</option>
                                    <option value="selected">当前选中的世界书（不新建）</option>
                                    <option value="custom">自定义 RMF 世界书（允许新建）</option>
                                </select>
                            </label>
                            <label>自定义世界书模板
                                <input id="rmf_worldNameTemplate" type="text" placeholder="仅在自定义模式使用：RMF-{{char}}-记忆世界书">
                            </label>
                            <label class="rmf-checkline"><input id="rmf_allowCreateFallbackWorldBook" type="checkbox"> 找不到角色卡世界书时允许新建 RMF 世界书</label>
                            <label class="rmf-checkline"><input id="rmf_cleanup" type="checkbox"> 关闭插件时清理当前记忆</label>
                            <label class="rmf-checkline"><input id="rmf_toast" type="checkbox"> 显示提示消息</label>
                            <label class="rmf-checkline"><input id="rmf_raw" type="checkbox"> 保存 JSON_RAW 世界书条目</label>
                            <label class="rmf-checkline"><input id="rmf_shujukuAcuCompatibleIndex" type="checkbox"> 同步 shujuku/TavernDB-ACU 兼容 Index 数据表</label>
                            <label class="rmf-checkline"><input id="rmf_shujukuAcuChatDataSync" type="checkbox"> 同步到聊天楼层 ACU sheet_* 数据</label>
                            <label class="rmf-checkline"><input id="rmf_autoFallbackRelationGraph" type="checkbox"> 关系图没数据时自动兜底建图</label>
                        </div>
                    </details>

                    <div class="rmf-actions">
                        <button id="rmf_process" class="menu_button">手动记录最新一轮</button>
                        <button id="rmf_history" class="menu_button rmf-primary-action">一键记忆历史聊天记录</button>
                        <button id="rmf_walkthrough" class="menu_button rmf-primary-action">走马灯回顾</button>
                        <button id="rmf_rescan" class="menu_button">重新补录当前聊天</button>
                        <button id="rmf_sync" class="menu_button">同步到世界书</button>
                        <button id="rmf_export" class="menu_button">导出 JSON</button>
                        <button id="rmf_clear" class="menu_button danger">清空当前记忆</button>
                    </div>

                    <div class="rmf-note">提示：默认直接写入“角色卡自带世界书”，不会额外新开 RMF 世界书；API 可以先保存再拉取模型；导入别人的旧聊天记录后，点“一键记忆历史聊天记录”即可从 0 层补录到当前；向量化记忆暂不默认启用，当前版本优先使用分层总结 + 世界书注入，稳定后再做 embedding 召回。</div>
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
    document.querySelector('#rmf_float_button')?.addEventListener('click', openRmfPanel);
    document.querySelector('#rmf_backdrop')?.addEventListener('click', closeRmfPanel);
    document.querySelector('#rmf_close')?.addEventListener('click', closeRmfPanel);
    if (!globalThis.__rmfEscBound) {
        globalThis.__rmfEscBound = true;
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeRmfPanel();
        });
    }
}

function bindPanelEvents() {
    const map = {
        rmf_enabled: ['enabled', 'checked'],
        rmf_keep: ['keepAcrossNewChats', 'checked'],
        rmf_cleanup: ['cleanupWhenDisabled', 'checked'],
        rmf_auto: ['autoProcess', 'checked'],
        rmf_autoSyncWorldBook: ['autoSyncWorldBook', 'checked'],
        rmf_appendBrief: ['appendBriefToMessage', 'checked'],
        rmf_autoHideSummarizedBriefs: ['autoHideSummarizedBriefs', 'checked'],
        rmf_toast: ['showToast', 'checked'],
        rmf_raw: ['includeRawJsonEntry', 'checked'],
        rmf_shujukuAcuCompatibleIndex: ['shujukuAcuCompatibleIndex', 'checked'],
        rmf_shujukuAcuChatDataSync: ['shujukuAcuChatDataSync', 'checked'],
        rmf_autoFallbackRelationGraph: ['autoFallbackRelationGraph', 'checked'],
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
        rmf_historyBatchSaveEvery: ['historyBatchSaveEvery', 'value'],
        rmf_walkThroughChunkPairs: ['walkThroughChunkPairs', 'value'],
        rmf_walkThroughMaxPairs: ['walkThroughMaxPairs', 'value'],
        rmf_walkThroughAddToChat: ['walkThroughAddToChat', 'checked'],
        rmf_worldSyncMode: ['worldSyncMode', 'value'],
        rmf_allowCreateFallbackWorldBook: ['allowCreateFallbackWorldBook', 'checked'],
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
                if (['worldSyncMode', 'worldNameTemplate', 'allowCreateFallbackWorldBook'].includes(key)) {
                    const target = resolveWorldBookTarget({ allowFallback: true });
                    const state = getState();
                    state.worldName = target.worldName || '';
                    state.worldSource = target.source;
                    await saveState();
                    if (settings().autoSyncWorldBook && target.worldName) await writeWorldBook().catch((error) => warn('writeWorldBook after target change failed', error));
                }
                refreshPromptInjection();
            }
            refreshDashboard();
        });
    }

    document.querySelector('#rmf_saveApi')?.addEventListener('click', () => saveApiSettingsFromPanel());
    document.querySelector('#rmf_fetchModels')?.addEventListener('click', () => fetchModelsFromPanel());
    document.querySelector('#rmf_modelSelect')?.addEventListener('change', (event) => {
        const value = String(event.target.value || '').trim();
        if (!value) return;
        const input = document.querySelector('#rmf_model');
        if (input) input.value = value;
        settings().model = value;
        saveSettings();
        toast(`已选择模型：${value}`, 'success');
        updateStatus(`已选择模型：${value}`);
    });


    document.querySelector('#rmf_process')?.addEventListener('click', () => processLatestExchange({ force: true }));
    document.querySelector('#rmf_history')?.addEventListener('click', () => oneClickRememberHistory());
    document.querySelector('#rmf_walkthrough')?.addEventListener('click', () => generateWalkthrough().catch((error) => { warn('walkthrough failed', error); toast(`走马灯失败：${error.message}`, 'error'); updateStatus(`走马灯失败：${error.message}`); }));
    document.querySelector('#rmf_rescan')?.addEventListener('click', () => rescanCurrentChat());
    document.querySelector('#rmf_sync')?.addEventListener('click', async () => {
        await writeWorldBook();
        await syncAcuDataToLatestAssistantMessage(getState()).catch((error) => warn('manual ACU sync failed', error));
        toast('已同步到世界书和 ACU 数据。', 'success');
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
    set('rmf_autoSyncWorldBook', !!s.autoSyncWorldBook, 'checked');
    set('rmf_appendBrief', !!s.appendBriefToMessage, 'checked');
    set('rmf_autoHideSummarizedBriefs', !!s.autoHideSummarizedBriefs, 'checked');
    set('rmf_toast', !!s.showToast, 'checked');
    set('rmf_raw', !!s.includeRawJsonEntry, 'checked');
    set('rmf_shujukuAcuCompatibleIndex', !!s.shujukuAcuCompatibleIndex, 'checked');
    set('rmf_shujukuAcuChatDataSync', !!s.shujukuAcuChatDataSync, 'checked');
    set('rmf_autoFallbackRelationGraph', !!s.autoFallbackRelationGraph, 'checked');
    set('rmf_source', s.source);
    set('rmf_baseUrl', s.baseUrl);
    set('rmf_apiKey', s.apiKey);
    set('rmf_model', s.model);
    populateModelSelectOptions();
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
    set('rmf_historyBatchSaveEvery', s.historyBatchSaveEvery);
    set('rmf_walkThroughChunkPairs', s.walkThroughChunkPairs);
    set('rmf_walkThroughMaxPairs', s.walkThroughMaxPairs);
    set('rmf_walkThroughAddToChat', !!s.walkThroughAddToChat, 'checked');
    set('rmf_worldSyncMode', s.worldSyncMode || 'character');
    set('rmf_allowCreateFallbackWorldBook', !!s.allowCreateFallbackWorldBook, 'checked');
    set('rmf_worldNameTemplate', s.worldNameTemplate);
    refreshInlineValues();
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
    const relationships = collectRelationshipRows(state);
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
    const relationships = collectRelationshipRows(state);
    if (!relationships.length) return '<div class="rmf-muted">暂无关系记录。</div>';
    return relationships.slice(0, 18).map((r) => `
        <div class="rmf-relation-card">
            <b>${escapeForHtml(r.from || '未知')}</b>
            <span>${escapeForHtml(r.relation || '关系')}</span>
            <b>${escapeForHtml(r.to || '未知')}</b>
            <small>${escapeForHtml(r.attitude || r.status || r.evidence || '')}</small>
        </div>`).join('');
}


function renderIndexTableHtml(table, { compact = true } = {}) {
    const rows = compact ? table.rows.slice(0, 12) : table.rows;
    const header = table.columns.map((c) => `<th>${escapeForHtml(c)}</th>`).join('');
    const body = rows.map((row) => `<tr>${table.columns.map((_, i) => `<td>${escapeForHtml(row[i] ?? '')}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${table.columns.length}">暂无数据</td></tr>`;
    const more = table.rows.length > rows.length ? `<div class="rmf-index-more">已显示 ${rows.length}/${table.rows.length} 行，完整内容会同步到世界书。</div>` : '';
    return `<div class="rmf-index-table-card">
        <div class="rmf-index-title"><b>${escapeForHtml(table.name)}</b><span>${escapeForHtml(table.mode || 'JSON_2D_ARRAY')}</span></div>
        <div class="rmf-index-scroll"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>
        ${more}
    </div>`;
}

function buildIndexTablesHtml(state) {
    const tables = [
        buildRelationIndexTable(state),
        buildGraphNodeIndexTable(state),
        buildGraphEdgeIndexTable(state),
        buildCharacterStateIndexTable(state),
        buildProfileIndexTable(state),
        buildInventoryIndexTable(state),
        buildPlotIndexTable(state),
        buildRecordIndexTable(state),
        buildSummaryIndexTable(state),
    ];
    return `<div class="rmf-index-stack">${tables.map((table) => renderIndexTableHtml(table)).join('')}</div>`;
}

function refreshDashboard() {
    const el = document.querySelector('#rmf_dashboard');
    const badge = document.querySelector('#rmf_float_badge');
    const floatButton = document.querySelector('#rmf_float_button');
    if (!el && !badge && !floatButton) return;
    const state = getState();
    const pending = state.summaries.filter((s) => !s.consolidated).length;
    if (badge) badge.textContent = String(state.records.length || 0);
    refreshInlineValues();
    if (floatButton) {
        floatButton.classList.toggle('is-disabled', !settings().enabled);
        floatButton.title = settings().enabled ? 'Role Memory Forge 已启用' : 'Role Memory Forge 未启用';
    }
    if (!el) return;
    el.innerHTML = `
        <div class="rmf-statline">
            <span>同步目标 <b>${escapeForHtml(getWorldTargetLabel())}</b></span>
            <span>简记 <b>${state.records.length}</b> / 显示 <b>${visibleRecordsForDisplay(state).length}</b></span>
            <span>阶段总结 <b>${state.summaries.length}</b> / 未合并 <b>${pending}</b></span>
            <span>大总结 <b>${state.megaSummary.content ? '有' : '无'}</b></span>
            <span>走马灯 <b>${state.walkthrough?.content ? '有' : '无'}</b></span>
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
            <summary>走马灯回顾</summary>
            <div class="rmf-text-box">${escapeForHtml(state.walkthrough?.content || '暂无。点击“走马灯回顾”后会生成。')}</div>
        </details>
        <details class="rmf-dash-block">
            <summary>最近简记</summary>
            <ol class="rmf-record-list">${visibleRecordsForDisplay(state).slice(-8).map((r) => `<li><b>#${r.id}</b> ${escapeForHtml(r.brief)}</li>`).join('') || '<li>暂无未总结简记</li>'}</ol>
        </details>
        <details open class="rmf-dash-block">
            <summary>Index 数据表</summary>
            ${buildIndexTablesHtml(state)}
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

let eventsRegistered = false;
let fallbackWatchStarted = false;
let lastChatIdentity = '';

function onEventSafe(events, source, name, handler) {
    const eventName = events?.[name];
    if (!source || !eventName || typeof source.on !== 'function') {
        warn(`事件 ${name} 不存在，已交给兜底轮询处理。`);
        return;
    }
    source.on(eventName, async (...args) => {
        try {
            await handler(...args);
        } catch (error) {
            warn(`event handler ${name} failed`, error);
        }
    });
}

function registerEvents() {
    if (eventsRegistered) return;
    const ctx = context();
    const events = ctx.eventTypes || ctx.event_types;
    const source = ctx.eventSource;
    if (!events || !source) {
        warn('SillyTavern eventSource 尚未就绪，使用兜底轮询。');
        return;
    }
    eventsRegistered = true;

    onEventSafe(events, source, 'APP_READY', async () => {
        renderSettingsPanel();
        await restoreStateFromWorldBookIfNeeded();
        refreshPromptInjection();
    });
    onEventSafe(events, source, 'APP_INITIALIZED', async () => {
        renderSettingsPanel();
        refreshPromptInjection();
    });
    onEventSafe(events, source, 'CHAT_CHANGED', async () => {
        await restoreStateFromWorldBookIfNeeded();
        refreshPromptInjection();
        refreshPanelValues();
        refreshDashboard();
    });
    onEventSafe(events, source, 'CHAT_CREATED', async () => {
        if (!settings().keepAcrossNewChats) {
            await clearCurrentMemory({ clearWorld: true, silent: true });
        } else {
            await restoreStateFromWorldBookIfNeeded();
        }
    });
    onEventSafe(events, source, 'MESSAGE_RECEIVED', scheduleProcessLatest);
    onEventSafe(events, source, 'MESSAGE_SWIPED', scheduleProcessLatest);
    onEventSafe(events, source, 'MESSAGE_EDITED', async () => {
        const state = getState();
        state.lastError = '消息被编辑过：建议点击“补录当前聊天”重建记忆，避免旧简记不一致。';
        await saveState();
    });
    onEventSafe(events, source, 'MESSAGE_DELETED', async () => {
        const state = getState();
        state.lastError = '消息被删除过：建议点击“补录当前聊天”重建记忆，避免旧简记不一致。';
        await saveState();
    });
}

function startFallbackWatch() {
    if (fallbackWatchStarted) return;
    fallbackWatchStarted = true;
    setInterval(async () => {
        try {
            if (!globalThis.SillyTavern?.getContext) return;
            renderInlineEntry();
            if (!document.querySelector('#rmf_float_button') || !document.querySelector('#rmf_settings')) {
                renderSettingsPanel();
            }
            const ctx = context();
            const identity = `${ctx.characterId ?? ''}|${ctx.groupId ?? ''}|${ctx.chatId ?? ''}|${ctx.chat?.length ?? 0}`;
            if (identity !== lastChatIdentity) {
                lastChatIdentity = identity;
                refreshPanelValues();
                refreshDashboard();
                refreshPromptInjection();
            }
            if (settings().enabled && settings().autoProcess) {
                scheduleProcessLatest();
            }
        } catch (error) {
            warn('fallback watch failed', error);
        }
    }, 4500);
}

let initialized = false;
let initRunning = false;

async function init() {
    if (initRunning) return;
    initRunning = true;
    try {
        if (!globalThis.SillyTavern?.getContext) {
            setTimeout(() => init().catch((error) => warn('delayed init failed', error)), 600);
            return;
        }
        settings();
        renderSettingsPanel();
        registerEvents();
        startFallbackWatch();
        initialized = true;
        setTimeout(async () => {
            try {
                await restoreStateFromWorldBookIfNeeded();
                refreshPromptInjection();
                refreshPanelValues();
                refreshDashboard();
            } catch (error) {
                warn('post init restore failed', error);
            }
        }, 100);
        log('loaded');
    } catch (error) {
        warn('init failed', error);
        setTimeout(() => init().catch((e) => warn('retry init failed', e)), 1000);
    } finally {
        initRunning = false;
    }
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
