import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import cors from 'cors';
import JSON5 from 'json5';
import { pathToFileURL } from 'url';

const app = express();
const PORT = process.env.PORT || 8080;

const COOKIE_NAME = 'clawboard_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AUTH_ITERATIONS = 64;

const PROVIDER_META = {
    'openai-codex': { access: 'Direct', upstream: 'OpenAI', docsUrl: 'https://platform.openai.com/docs/models' },
    'openai-ll': { access: 'LiteLLM', upstream: 'OpenAI', docsUrl: 'https://platform.openai.com/docs/models' },
    'anthropic-ll': { access: 'LiteLLM', upstream: 'Anthropic', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models' },
    'google-ll': { access: 'LiteLLM', upstream: 'Google', docsUrl: 'https://ai.google.dev/docs/model_versions' },
    'google-gemini-cli': { access: 'Direct', upstream: 'Google', docsUrl: 'https://ai.google.dev/docs/model_versions' },
    'nvidia-ll': { access: 'LiteLLM', upstream: 'NVIDIA', docsUrl: 'https://build.nvidia.com/explore/llm' },
    'openrouter-ll': { access: 'LiteLLM', upstream: 'OpenRouter', docsUrl: 'https://openrouter.ai/models' },
    bailian: { access: 'Direct', upstream: 'Alibaba', docsUrl: 'https://help.aliyun.com/zh/model-list/bailian' }
};

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public', {
    etag: false,
    lastModified: false,
    maxAge: 0
}));

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

const getOpenClawDir = () => path.join(os.homedir(), '.openclaw');
const getClawboardDir = () => path.join(getOpenClawDir(), 'clawboard');
const getConfigPath = () => path.join(getOpenClawDir(), 'openclaw.json');
const getPresetsPath = () => path.join(getOpenClawDir(), 'clawboard-presets.json');
const getLiteLLMConfigPath = () => path.join(getOpenClawDir(), 'litellm', 'config.yaml');
const getAuthPath = () => path.join(getClawboardDir(), 'auth.json');
const getAvatarDir = () => path.join(getClawboardDir(), 'avatars');

const hostToContainerPath = (hostPath) => {
    const homeDir = os.homedir();
    const hostHome = process.env.HOST_HOME || '/Users/alexwang';
    return hostPath.startsWith(hostHome) ? hostPath.replace(hostHome, homeDir) : hostPath;
};

const normalizeFallbacks = (fallbacks = []) => [
    fallbacks?.[0] || '',
    fallbacks?.[1] || ''
].filter(Boolean);

const parseModelRef = (value = '') => {
    if (!value || !value.includes('/')) {
        return { provider: '', modelId: value || '' };
    }

    const [provider, ...rest] = value.split('/');
    return {
        provider,
        modelId: rest.join('/')
    };
};

const sanitizeAgentId = (value = '') => value.replace(/[^a-zA-Z0-9_-]/g, '_');

const parseCookies = (cookieHeader = '') => Object.fromEntries(
    cookieHeader
        .split(';')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const index = entry.indexOf('=');
            if (index === -1) {
                return [entry, ''];
            }
            return [entry.slice(0, index), decodeURIComponent(entry.slice(index + 1))];
        })
);

const getSessionCookieOptions = () => [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
].join('; ');

const clearSessionCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const extForMimeType = (mimeType) => ({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg'
}[mimeType] || null);

const ensureDir = async (dirPath) => {
    await fs.mkdir(dirPath, { recursive: true });
};

const collectJsonModelRefs = (value, refs) => {
    if (Array.isArray(value)) {
        value.forEach((entry) => collectJsonModelRefs(entry, refs));
        return;
    }

    if (!value || typeof value !== 'object') {
        return;
    }

    if (typeof value.primary === 'string' && value.primary.includes('/')) {
        refs.add(value.primary);
    }

    if (Array.isArray(value.fallbacks)) {
        value.fallbacks.filter(Boolean).forEach((entry) => refs.add(entry));
    }

    if (typeof value.model === 'string' && value.model.includes('/')) {
        refs.add(value.model);
    }

    Object.values(value).forEach((entry) => collectJsonModelRefs(entry, refs));
};

const collectModelRegistryRefs = (config, refs) => {
    const registry = config?.agents?.defaults?.models || {};
    Object.keys(registry).forEach((key) => {
        if (typeof key === 'string' && key.includes('/')) {
            refs.add(key);
        }
    });
};

const inferProviderMeta = (providerId) => {
    if (PROVIDER_META[providerId]) {
        return PROVIDER_META[providerId];
    }

    if (providerId.includes('openai')) {
        return { access: providerId.includes('-ll') ? 'LiteLLM' : 'Direct', upstream: 'OpenAI', docsUrl: 'https://platform.openai.com/docs/models' };
    }
    if (providerId.includes('anthropic')) {
        return { access: providerId.includes('-ll') ? 'LiteLLM' : 'Direct', upstream: 'Anthropic', docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models' };
    }
    if (providerId.includes('google') || providerId.includes('gemini')) {
        return { access: providerId.includes('-ll') ? 'LiteLLM' : 'Direct', upstream: 'Google', docsUrl: 'https://ai.google.dev/docs/model_versions' };
    }
    if (providerId.includes('nvidia')) {
        return { access: 'LiteLLM', upstream: 'NVIDIA', docsUrl: 'https://build.nvidia.com/explore/llm' };
    }
    if (providerId.includes('openrouter')) {
        return { access: 'LiteLLM', upstream: 'OpenRouter', docsUrl: 'https://openrouter.ai/models' };
    }

    return { access: 'Unknown', upstream: 'Unknown', docsUrl: '' };
};

const readJson = async (filePath, fallbackValue) => {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON5.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return fallbackValue;
        }
        throw error;
    }
};

const writeJson = async (filePath, value) => {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
};

const hashPassword = async (password, salt = crypto.randomBytes(16).toString('hex')) => {
    const derivedKey = await new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (error, key) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(key);
        });
    });

    return `scrypt$${AUTH_ITERATIONS}$${salt}$${derivedKey.toString('hex')}`;
};

const verifyPassword = async (password, storedHash = '') => {
    const [algorithm, iterations, salt, expectedHex] = storedHash.split('$');
    if (algorithm !== 'scrypt' || !iterations || !salt || !expectedHex) {
        return false;
    }

    const derivedKey = await new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, Number(iterations), (error, key) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(key);
        });
    });

    const expected = Buffer.from(expectedHex, 'hex');
    return expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey);
};

const readAuthConfig = async () => {
    const authPath = getAuthPath();
    const existing = await readJson(authPath, null);

    if (existing?.username && existing?.passwordHash && existing?.sessionSecret) {
        return existing;
    }

    const defaultConfig = {
        username: 'admin',
        passwordHash: await hashPassword('password'),
        sessionSecret: crypto.randomBytes(32).toString('hex'),
        updatedAt: new Date().toISOString()
    };

    await writeJson(authPath, defaultConfig);
    return defaultConfig;
};

const writeAuthConfig = async (authConfig) => {
    await writeJson(getAuthPath(), {
        ...authConfig,
        updatedAt: new Date().toISOString()
    });
};

const createSessionToken = (username, sessionSecret) => {
    const payload = JSON.stringify({
        username,
        exp: Date.now() + SESSION_TTL_MS
    });
    const encodedPayload = Buffer.from(payload, 'utf-8').toString('base64url');
    const signature = crypto.createHmac('sha256', sessionSecret).update(encodedPayload).digest('base64url');
    return `${encodedPayload}.${signature}`;
};

const verifySessionToken = (token, sessionSecret) => {
    if (!token || !token.includes('.')) {
        return null;
    }

    const [encodedPayload, providedSignature] = token.split('.');
    const expectedSignature = crypto.createHmac('sha256', sessionSecret).update(encodedPayload).digest('base64url');

    const provided = Buffer.from(providedSignature);
    const expected = Buffer.from(expectedSignature);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf-8'));
        if (!payload.username || !payload.exp || payload.exp < Date.now()) {
            return null;
        }
        return payload;
    } catch {
        return null;
    }
};

const getAvatarFile = async (agentId) => {
    const safeAgentId = sanitizeAgentId(agentId);
    const avatarDir = getAvatarDir();

    try {
        const entries = await fs.readdir(avatarDir);
        const match = entries.find((entry) => entry.startsWith(`${safeAgentId}.`));
        if (!match) {
            return null;
        }

        const fullPath = path.join(avatarDir, match);
        const stats = await fs.stat(fullPath);
        return {
            fullPath,
            fileName: match,
            ext: path.extname(match).slice(1).toLowerCase(),
            updatedAtMs: stats.mtimeMs
        };
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
};

const writeAvatar = async (agentId, mimeType, dataBuffer) => {
    const ext = extForMimeType(mimeType);
    if (!ext) {
        throw new Error('Unsupported avatar image type');
    }

    await ensureDir(getAvatarDir());

    const safeAgentId = sanitizeAgentId(agentId);
    const existing = await getAvatarFile(agentId);
    if (existing) {
        await fs.rm(existing.fullPath, { force: true });
    }

    const targetPath = path.join(getAvatarDir(), `${safeAgentId}.${ext}`);
    await fs.writeFile(targetPath, dataBuffer);
    const stats = await fs.stat(targetPath);

    return {
        fullPath: targetPath,
        updatedAtMs: stats.mtimeMs
    };
};

const deleteAvatar = async (agentId) => {
    const existing = await getAvatarFile(agentId);
    if (existing) {
        await fs.rm(existing.fullPath, { force: true });
    }
};

const buildDefaultAvatarSvg = (label) => {
    const initials = (label || '?')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || '')
        .join('') || '?';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="${initials}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#d3e3fd"/><stop offset="100%" stop-color="#b7d0fb"/></linearGradient></defs><rect width="96" height="96" rx="48" fill="url(#bg)"/><text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#0b57d0">${initials}</text></svg>`;
};

const readPresets = async () => {
    try {
        const parsed = await readJson(getPresetsPath(), { presets: {} });
        return parsed.presets || {};
    } catch (error) {
        console.error('Error reading presets:', error.message);
        throw new Error('Failed to read presets file');
    }
};

const writePresets = async (presetsData) => {
    try {
        await writeJson(getPresetsPath(), { presets: presetsData });
    } catch (error) {
        console.error('Error writing presets:', error.message);
        throw new Error('Failed to write presets file');
    }
};

const readConfig = async () => {
    try {
        return await readJson(getConfigPath(), { agents: {} });
    } catch (error) {
        console.error('Error reading config:', error.message);
        throw new Error('Failed to read config file');
    }
};

const writeConfig = async (config, createBackup = true) => {
    try {
        const configPath = getConfigPath();

        if (createBackup) {
            try {
                await fs.access(configPath);
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const backupPath = configPath.replace('.json', `-${timestamp}.json.bak`);
                await fs.copyFile(configPath, backupPath);
                console.log(`Backup created: ${backupPath}`);
            } catch (error) {
                console.warn('No existing config to backup:', error.message);
            }
        }

        await ensureDir(path.dirname(configPath));
        await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
        console.error('Error writing config:', error.message);
        throw new Error('Failed to write config file');
    }
};

const readLiteLLMModelNames = async () => {
    try {
        const raw = await fs.readFile(getLiteLLMConfigPath(), 'utf-8');
        return raw
            .split('\n')
            .map((line) => line.match(/^\s*-\s*model_name:\s*(.+?)\s*$/)?.[1])
            .filter(Boolean);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }

        console.warn('Failed to read LiteLLM config:', error.message);
        return [];
    }
};

const buildModelCatalog = async (config, presets = {}) => {
    const providers = config.models?.providers || {};
    const litellmNames = await readLiteLLMModelNames();
    const litellmSet = new Set(litellmNames);
    const refs = new Set();
    collectJsonModelRefs(config.agents, refs);
    collectJsonModelRefs({ presets }, refs);
    collectModelRegistryRefs(config, refs);

    const providerIds = new Set([
        ...Object.keys(providers),
        ...Object.keys(config.auth?.order || {})
    ]);

    for (const ref of refs) {
        const parsed = parseModelRef(ref);
        if (parsed.provider) {
            providerIds.add(parsed.provider);
        }
    }

    const optionMap = new Map();

    for (const providerId of providerIds) {
        const providerConfig = providers[providerId] || {};
        const meta = inferProviderMeta(providerId);

        for (const model of providerConfig.models || []) {
            const modelId = model.id;
            const value = `${providerId}/${modelId}`;
            const sources = new Set(['openclaw']);

            if (litellmSet.has(modelId)) {
                sources.add('litellm');
            }

            optionMap.set(value, {
                value,
                label: model.name || modelId,
                provider: providerId,
                modelId,
                modelName: model.name || modelId,
                access: meta.access,
                upstream: meta.upstream,
                docsUrl: meta.docsUrl,
                contextWindow: model.contextWindow || null,
                maxTokens: model.maxTokens || null,
                reasoning: Boolean(model.reasoning),
                sources: Array.from(sources),
                selectable: true
            });
        }
    }

    for (const ref of refs) {
        const { provider, modelId } = parseModelRef(ref);
        if (!provider || !modelId) {
            continue;
        }

        const meta = inferProviderMeta(provider);
        const sources = new Set(['openclaw']);
        if (litellmSet.has(modelId)) {
            sources.add('litellm');
        }

        if (!optionMap.has(ref)) {
            optionMap.set(ref, {
                value: ref,
                label: modelId,
                provider,
                modelId,
                modelName: modelId,
                access: meta.access,
                upstream: meta.upstream,
                docsUrl: meta.docsUrl,
                contextWindow: null,
                maxTokens: null,
                reasoning: false,
                sources: Array.from(sources),
                selectable: true
            });
        } else {
            const option = optionMap.get(ref);
            option.sources = Array.from(new Set([...(option.sources || []), ...sources]));
        }
    }

    const options = Array.from(optionMap.values()).sort((left, right) => {
        if (left.provider !== right.provider) {
            return left.provider.localeCompare(right.provider);
        }
        return left.modelId.localeCompare(right.modelId);
    });

    const openclawModelIdSet = new Set(options.map((option) => option.modelId));
    const litellmOnly = litellmNames
        .filter((name) => !openclawModelIdSet.has(name))
        .map((name) => ({
            value: name,
            label: name,
            provider: '',
            modelId: name,
            modelName: name,
            access: 'LiteLLM',
            upstream: 'LiteLLM',
            docsUrl: '',
            contextWindow: null,
            maxTokens: null,
            reasoning: false,
            sources: ['litellm'],
            selectable: false
        }));

    const providersList = Array.from(
        new Map(
            options.map((option) => [
                option.provider,
                {
                    id: option.provider,
                    access: option.access,
                    upstream: option.upstream,
                    docsUrl: option.docsUrl
                }
            ])
        ).values()
    );

    return {
        options,
        providers: providersList,
        litellmOnly
    };
};

const getWorkspaceSkills = async (agentsList) => {
    const workspaceSkills = {};

    for (const agent of agentsList) {
        const workspace = agent.workspace || '';

        if (!workspace) {
            workspaceSkills[agent.id] = [];
            continue;
        }

        try {
            const containerPath = hostToContainerPath(workspace);
            const skillsPath = path.join(containerPath, 'skills');
            await fs.access(skillsPath);
            const entries = await fs.readdir(skillsPath, { withFileTypes: true });
            workspaceSkills[agent.id] = entries
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort();
        } catch {
            workspaceSkills[agent.id] = [];
        }
    }

    return workspaceSkills;
};

const requireAuth = async (req, res, next) => {
    try {
        const authConfig = await readAuthConfig();
        const cookies = parseCookies(req.headers.cookie || '');
        const token = cookies[COOKIE_NAME];
        const session = verifySessionToken(token, authConfig.sessionSecret);

        if (!session || session.username !== authConfig.username) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }

        req.auth = session;
        next();
    } catch (error) {
        res.status(500).json({ error: 'Failed to validate session' });
    }
};

app.get('/api/auth/status', async (req, res) => {
    try {
        const authConfig = await readAuthConfig();
        const cookies = parseCookies(req.headers.cookie || '');
        const token = cookies[COOKIE_NAME];
        const session = verifySessionToken(token, authConfig.sessionSecret);

        res.json({
            authenticated: Boolean(session && session.username === authConfig.username),
            username: session?.username || null
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to read auth status' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const authConfig = await readAuthConfig();
        const validPassword = await verifyPassword(password, authConfig.passwordHash);

        if (username !== authConfig.username || !validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = createSessionToken(username, authConfig.sessionSecret);
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; ${getSessionCookieOptions()}`);
        res.json({ success: true, username });
    } catch (error) {
        res.status(500).json({ error: 'Failed to log in' });
    }
});

app.post('/api/auth/logout', async (req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ success: true });
});

app.use('/api', requireAuth);

app.post('/api/auth/change', async (req, res) => {
    try {
        const { currentPassword, newUsername, newPassword } = req.body || {};
        if (!currentPassword) {
            return res.status(400).json({ error: 'Current password is required' });
        }
        if (!newUsername && !newPassword) {
            return res.status(400).json({ error: 'Provide a new username or password' });
        }

        const authConfig = await readAuthConfig();
        const validPassword = await verifyPassword(currentPassword, authConfig.passwordHash);

        if (!validPassword) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        authConfig.username = (newUsername || authConfig.username).trim();
        if (!authConfig.username) {
            return res.status(400).json({ error: 'Username cannot be empty' });
        }

        if (newPassword) {
            authConfig.passwordHash = await hashPassword(newPassword);
        }

        await writeAuthConfig(authConfig);
        const token = createSessionToken(authConfig.username, authConfig.sessionSecret);
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; ${getSessionCookieOptions()}`);
        res.json({ success: true, username: authConfig.username, message: 'Credentials updated.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update credentials' });
    }
});

app.get('/api/model-options', async (req, res) => {
    try {
        const [config, presets] = await Promise.all([readConfig(), readPresets()]);
        const catalog = await buildModelCatalog(config, presets);
        res.json(catalog);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/agents', async (req, res) => {
    try {
        const config = await readConfig();
        const agentsList = config.agents?.list || [];
        const installedSkills = config.skills?.entries ? Object.keys(config.skills.entries).sort() : [];
        const workspaceSkills = await getWorkspaceSkills(agentsList);

        const agents = await Promise.all(agentsList.map(async (agent) => {
            const avatar = await getAvatarFile(agent.id);
            return {
                id: agent.id,
                name: agent.name || agent.id,
                primary: agent.model?.primary || '',
                fallbacks: normalizeFallbacks(agent.model?.fallbacks || []),
                installedSkills,
                workspaceSkills: workspaceSkills[agent.id] || [],
                avatarUrl: `/api/agents/${encodeURIComponent(agent.id)}/avatar${avatar ? `?v=${Math.floor(avatar.updatedAtMs)}` : ''}`,
                hasCustomAvatar: Boolean(avatar)
            };
        }));

        res.json({ agents });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/agents/:agentId/avatar', async (req, res) => {
    try {
        const { agentId } = req.params;
        const avatar = await getAvatarFile(agentId);

        if (avatar) {
            const ext = avatar.ext === 'jpg' ? 'jpeg' : avatar.ext;
            res.type(`image/${ext}`);
            res.sendFile(avatar.fullPath);
            return;
        }

        const config = await readConfig();
        const agent = (config.agents?.list || []).find((entry) => entry.id === agentId);
        res.type('image/svg+xml');
        res.send(buildDefaultAvatarSvg(agent?.name || agentId));
    } catch (error) {
        res.status(500).json({ error: 'Failed to load avatar' });
    }
});

app.post('/api/agents/:agentId/avatar', async (req, res) => {
    try {
        const { agentId } = req.params;
        const { dataUrl } = req.body || {};
        if (!dataUrl || typeof dataUrl !== 'string') {
            return res.status(400).json({ error: 'Missing avatar payload' });
        }

        const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (!match) {
            return res.status(400).json({ error: 'Invalid avatar payload' });
        }

        const [, mimeType, base64Data] = match;
        const dataBuffer = Buffer.from(base64Data, 'base64');
        if (dataBuffer.byteLength > MAX_AVATAR_BYTES) {
            return res.status(400).json({ error: 'Avatar exceeds 2 MB limit' });
        }

        const saved = await writeAvatar(agentId, mimeType, dataBuffer);
        res.json({
            success: true,
            message: 'Avatar uploaded.',
            avatarUrl: `/api/agents/${encodeURIComponent(agentId)}/avatar?v=${Math.floor(saved.updatedAtMs)}`
        });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to save avatar' });
    }
});

app.delete('/api/agents/:agentId/avatar', async (req, res) => {
    try {
        await deleteAvatar(req.params.agentId);
        res.json({ success: true, message: 'Avatar reset to default.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reset avatar' });
    }
});

app.post('/api/agents/apply', async (req, res) => {
    try {
        const newAgents = req.body.agents;
        if (!Array.isArray(newAgents)) {
            return res.status(400).json({ error: 'Missing agents payload' });
        }

        const config = await readConfig();

        if (Array.isArray(config.agents?.list)) {
            for (const agentUpdate of newAgents) {
                const agent = config.agents.list.find((entry) => entry.id === agentUpdate.id);
                if (!agent) {
                    continue;
                }

                agent.model = {
                    primary: agentUpdate.primary || '',
                    fallbacks: normalizeFallbacks(agentUpdate.fallbacks || [])
                };
            }
        }

        await writeConfig(config, true);
        res.json({ success: true, message: 'Agent config saved and hot-applied. No restart needed.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/defaults', async (req, res) => {
    try {
        const config = await readConfig();
        const defaults = config.agents?.defaults || {};
        res.json({
            model: defaults.model || { primary: '', fallbacks: [] },
            imageModel: defaults.imageModel || { primary: '', fallbacks: [] },
            heartbeatModel: defaults.heartbeat?.model || '',
            thinkingDefault: defaults.thinkingDefault || 'adaptive'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/defaults/apply', async (req, res) => {
    try {
        const { model, imageModel, heartbeatModel, thinkingDefault } = req.body;
        const config = await readConfig();

        if (!config.agents) {
            config.agents = {};
        }
        if (!config.agents.defaults) {
            config.agents.defaults = {};
        }

        if (model) {
            config.agents.defaults.model = {
                primary: model.primary || '',
                fallbacks: normalizeFallbacks(model.fallbacks || [])
            };
        }

        if (imageModel) {
            config.agents.defaults.imageModel = {
                primary: imageModel.primary || '',
                fallbacks: normalizeFallbacks(imageModel.fallbacks || [])
            };
        }

        config.agents.defaults.heartbeat = config.agents.defaults.heartbeat || {};
        config.agents.defaults.heartbeat.model = heartbeatModel || '';
        config.agents.defaults.thinkingDefault = thinkingDefault || 'adaptive';

        await writeConfig(config, true);
        res.json({ success: true, message: 'Default model config saved and hot-applied. No restart needed.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/presets', async (req, res) => {
    try {
        const presets = await readPresets();
        res.json({ presets });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/presets', async (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'Missing preset name' });
        }

        const config = await readConfig();
        const presets = await readPresets();

        presets[name] = {
            name,
            description: description || '',
            defaults: config.agents?.defaults ? {
                model: config.agents.defaults.model,
                imageModel: config.agents.defaults.imageModel,
                heartbeatModel: config.agents.defaults.heartbeat?.model,
                thinkingDefault: config.agents.defaults.thinkingDefault
            } : {},
            agents: (config.agents?.list || []).reduce((acc, agent) => {
                acc[agent.id] = {
                    primary: agent.model?.primary || '',
                    fallbacks: normalizeFallbacks(agent.model?.fallbacks || [])
                };
                return acc;
            }, {}),
            createdAt: new Date().toISOString()
        };

        await writePresets(presets);
        res.json({ success: true, message: `Preset "${name}" saved.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/presets/:name', async (req, res) => {
    try {
        const { name } = req.params;
        const presets = await readPresets();

        if (!presets[name]) {
            return res.status(404).json({ error: 'Preset not found' });
        }

        delete presets[name];
        await writePresets(presets);
        res.json({ success: true, message: `Preset "${name}" deleted.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/presets/:name/apply', async (req, res) => {
    try {
        const { name } = req.params;
        const presets = await readPresets();
        const preset = presets[name];

        if (!preset) {
            return res.status(404).json({ error: 'Preset not found' });
        }

        const config = await readConfig();

        if (!config.agents) {
            config.agents = {};
        }
        if (!config.agents.defaults) {
            config.agents.defaults = {};
        }

        if (preset.defaults) {
            if (preset.defaults.model) {
                config.agents.defaults.model = {
                    primary: preset.defaults.model.primary || '',
                    fallbacks: normalizeFallbacks(preset.defaults.model.fallbacks || [])
                };
            }

            if (preset.defaults.imageModel) {
                config.agents.defaults.imageModel = {
                    primary: preset.defaults.imageModel.primary || '',
                    fallbacks: normalizeFallbacks(preset.defaults.imageModel.fallbacks || [])
                };
            }

            config.agents.defaults.heartbeat = config.agents.defaults.heartbeat || {};
            if ('heartbeatModel' in preset.defaults) {
                config.agents.defaults.heartbeat.model = preset.defaults.heartbeatModel || '';
            }
            if ('thinkingDefault' in preset.defaults) {
                config.agents.defaults.thinkingDefault = preset.defaults.thinkingDefault || 'adaptive';
            }
        }

        if (preset.agents && Array.isArray(config.agents.list)) {
            for (const [agentId, agentConfig] of Object.entries(preset.agents)) {
                const agent = config.agents.list.find((entry) => entry.id === agentId);
                if (!agent) {
                    continue;
                }

                agent.model = {
                    primary: agentConfig.primary || '',
                    fallbacks: normalizeFallbacks(agentConfig.fallbacks || [])
                };
            }
        }

        await writeConfig(config, true);
        res.json({ success: true, message: `Preset "${name}" applied and hot-reloaded. No restart needed.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/cron', async (req, res) => {
    try {
        const cronJobsPath = path.join(getOpenClawDir(), 'cron', 'jobs.json');
        const data = await fs.readFile(cronJobsPath, 'utf-8');
        const cronData = JSON.parse(data);

        const jobs = (cronData.jobs || []).map((job) => ({
            id: job.id,
            name: job.name,
            agentId: job.agentId,
            enabled: job.enabled,
            schedule: job.schedule?.expr || '',
            nextRun: job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : null,
            lastRun: job.state?.lastRunAtMs ? new Date(job.state.lastRunAtMs).toISOString() : null,
            next: job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : null,
            last: job.state?.lastRunAtMs ? new Date(job.state.lastRunAtMs).toISOString() : null,
            nextRunAtMs: job.state?.nextRunAtMs || null,
            lastRunAtMs: job.state?.lastRunAtMs || null,
            status: job.state?.lastStatus || 'idle',
            target: job.sessionTarget || '',
            model: job.payload?.model || ''
        }));

        res.json({ jobs });
    } catch (error) {
        console.error('Error reading cron jobs:', error.message);
        res.status(500).json({ error: error.message, jobs: [] });
    }
});

app.get('/api/skills', async (req, res) => {
    try {
        const config = await readConfig();
        const agentsList = config.agents?.list || [];
        const installed = config.skills?.entries ? Object.keys(config.skills.entries).sort() : [];
        const workspace = await getWorkspaceSkills(agentsList);
        res.json({ installed, workspace });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/models', async (req, res) => {
    try {
        const [config, presets] = await Promise.all([readConfig(), readPresets()]);
        const catalog = await buildModelCatalog(config, presets);

        const models = catalog.options.map((option) => ({
            provider: option.provider,
            modelId: option.modelId,
            modelName: option.modelName,
            access: option.access,
            upstream: option.upstream,
            docsUrl: option.docsUrl,
            contextWindow: option.contextWindow,
            maxTokens: option.maxTokens,
            reasoning: option.reasoning,
            sourceStatus: option.sources.includes('litellm') ? 'openclaw+litellm' : 'openclaw-only'
        }));

        res.json({
            models,
            litellmOnly: catalog.litellmOnly.map((entry) => entry.modelId)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/status', async (req, res) => {
    res.json({ status: 'online', color: 'green' });
});

const startServer = () => app.listen(PORT, () => {
    console.log(`Clawboard API Server running on port ${PORT}`);
    console.log(`Watching config at: ${getConfigPath()}`);
    console.log(`Auth config at: ${getAuthPath()}`);
    console.log(`Avatar storage at: ${getAvatarDir()}`);
});

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule && process.env.NO_LISTEN !== '1') {
    startServer();
}

export { app, startServer };
