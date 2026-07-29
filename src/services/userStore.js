/**
 * User Store
 * 文件系统后端的用户管理：每个用户在 run/users/<username>/ 下拥有专有目录，
 * 存放 profile.json（凭证 + 登录态）与 sessions/<uuid>/history.json（历史会话）。
 *
 * 不引入数据库：单机低频场景下，目录即用户、文件即记录，足够且可直读排查。
 * 安全要点：
 *   - username 走白名单正则（仅字母数字下划线连字符，3-32 位），从结构上杜绝
 *     路径穿越（不含 / .. 等），profilePath/sessionsDir 均由其派生。
 *   - 密码用 scryptSync + 16 字节随机 salt 派生 64 字节 hash，绝不落盘明文。
 *   - token = randomBytes(32).hex；下发给客户端的是 `${username}.${token}`，
 *     profile.json 只存 token 本身。verifyToken 用 timingSafeEqual 做常量时间比较。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

// username 白名单：长度 3-32，仅 ASCII 字母数字 _ -。无 / \ .. 空格等，
// 故 path.join(users.dir, username, ...) 不可能逃出用户根目录。
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;

// 密码最小长度：防御短口令爆破。够用且不干扰正常使用。
const MIN_PASSWORD_LENGTH = 6;

// listSessions 摘要取首轮用户提示词的前 N 个字符。
const SUMMARY_LENGTH = 30;

class UserStore {
    constructor(config) {
        this.dir = config.users.dir;
        // tokenTtlDays <=0 表示永不过期（与 sessionStore.cleanupExpired 的约定一致）
        this.tokenTtlDays = config.auth.tokenTtlDays;
        fs.mkdirSync(this.dir, { recursive: true });
    }

    isValidUsername(username) {
        return typeof username === 'string' && USERNAME_PATTERN.test(username);
    }

    userDir(username) {
        return path.join(this.dir, username);
    }

    profilePath(username) {
        return path.join(this.dir, username, 'profile.json');
    }

    sessionsDir(username) {
        return path.join(this.dir, username, 'sessions');
    }

    /**
     * 读取 profile.json。文件缺失或损坏均返回 null（视为用户不存在/未登录），
     * 不抛异常：调用方按“用户不存在”处理即可，避免一次坏文件中断请求。
     */
    _readProfile(username) {
        try {
            return JSON.parse(fs.readFileSync(this.profilePath(username), 'utf-8'));
        } catch (e) {
            return null;
        }
    }

    _writeProfile(username, profile) {
        fs.mkdirSync(this.userDir(username), { recursive: true });
        fs.writeFileSync(this.profilePath(username), JSON.stringify(profile, null, 2));
    }

    /**
     * 注册：创建用户、写 profile、预建 sessions 目录、签发 token。
     * 返回 {token, username} 或 {error}。token 下发格式 `${username}.${randomHex}`。
     */
    register(username, password) {
        if (!this.isValidUsername(username)) {
            return { error: 'invalid_username' };
        }
        if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
            return { error: 'invalid_password' };
        }
        if (this._readProfile(username)) {
            return { error: 'user_exists' };
        }

        const salt = crypto.randomBytes(16);
        const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
        const token = crypto.randomBytes(32).toString('hex');
        const now = Date.now();

        const profile = {
            username,
            salt: salt.toString('hex'),
            passwordHash,
            token,
            tokenIssuedAt: now,
            createdAt: now,
            lastLoginAt: now
        };
        this._writeProfile(username, profile);
        // 预建 sessions 目录，让 listSessions 始终有一个稳定的扫描入口
        fs.mkdirSync(this.sessionsDir(username), { recursive: true });

        logger.info('User registered:', username);
        return { token: `${username}.${token}`, username };
    }

    /**
     * 登录：校验密码后轮换 token（旧 token 立即失效），更新 lastLoginAt。
     * 用户名/密码错误统一返回 invalid_credentials，不区分“用户不存在”与
     * “密码错误”，避免用户名枚举。
     */
    login(username, password) {
        if (!this.isValidUsername(username)) {
            return { error: 'invalid_credentials' };
        }
        const profile = this._readProfile(username);
        if (!profile || typeof profile.salt !== 'string' || !profile.passwordHash) {
            return { error: 'invalid_credentials' };
        }

        // 与 register 的守卫对称：非字符串密码在到达 scryptSync 前就拒绝。
        // 位置在 _readProfile 之后，保持“用户不存在也先返回 invalid_credentials”
        // 的防枚举语义；在 scryptSync 之前，避免 TypeError -> 500。
        if (typeof password !== 'string') {
            return { error: 'invalid_credentials' };
        }

        const salt = Buffer.from(profile.salt, 'hex');
        const hash = crypto.scryptSync(password, salt, 64).toString('hex');
        if (!this._constTimeEqual(hash, profile.passwordHash)) {
            return { error: 'invalid_credentials' };
        }

        const token = crypto.randomBytes(32).toString('hex');
        const now = Date.now();
        profile.token = token;
        profile.tokenIssuedAt = now;
        profile.lastLoginAt = now;
        this._writeProfile(username, profile);

        logger.info('User logged in:', username);
        return { token: `${username}.${token}`, username };
    }

    /**
     * 登出：清空 profile.token，使该用户已下发的 token 立即失效。
     * 返回是否确实清掉了一个已登录态（用于幂等性提示，不阻断流程）。
     */
    logout(username) {
        if (!this.isValidUsername(username)) return false;
        const profile = this._readProfile(username);
        if (!profile) return false;
        if (!profile.token) return false;
        profile.token = null;
        profile.tokenIssuedAt = null;
        this._writeProfile(username, profile);
        logger.info('User logged out:', username);
        return true;
    }

    /**
     * 校验客户端 token，成功返回 username，否则 null。
     * token 形如 `${username}.${randomHex}`：
     *   1. 拆出 username（username 不含 '.'，故首个 '.' 之前即用户名）；
     *   2. 读 profile，确认 profile.token 仍存在且与 randomHex 常量时间相等；
     *   3. tokenIssuedAt + tokenTtlDays 未过期（<=0 表示永不过期）。
     */
    verifyToken(token) {
        if (typeof token !== 'string') return null;
        const dotIdx = token.indexOf('.');
        if (dotIdx < 0) return null;
        const username = token.slice(0, dotIdx);
        const randomHex = token.slice(dotIdx + 1);
        if (!this.isValidUsername(username)) return null;

        const profile = this._readProfile(username);
        if (!profile || typeof profile.token !== 'string') return null;

        if (!this._constTimeEqual(randomHex, profile.token)) return null;

        if (this.tokenTtlDays > 0 && typeof profile.tokenIssuedAt === 'number') {
            const ttlMs = this.tokenTtlDays * 86400000;
            if (Date.now() - profile.tokenIssuedAt > ttlMs) return null;
        }
        return username;
    }

    /**
     * 列出用户所有历史会话：扫描 sessions/<uuid>/history.json，取首轮 user
     * content 前 30 字符作 summary，按 history.json mtime 倒序（最新在前）。
     * 单个坏会话不阻断列表，跳过即可。
     */
    listSessions(username) {
        if (!this.isValidUsername(username)) return [];
        const dir = this.sessionsDir(username);
        if (!fs.existsSync(dir)) return [];

        const sessions = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const historyPath = path.join(dir, entry.name, 'history.json');
            if (!fs.existsSync(historyPath)) continue;
            try {
                const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
                if (!Array.isArray(history)) continue;
                let summary = '';
                const firstUser = history.find(h => h && h.role === 'user' && typeof h.content === 'string');
                if (firstUser) {
                    summary = firstUser.content.slice(0, SUMMARY_LENGTH);
                }
                const stat = fs.statSync(historyPath);
                sessions.push({ sessionId: entry.name, summary, updatedAt: stat.mtimeMs });
            } catch (e) {
                // 损坏的 history.json 不阻断列表：跳过该会话
                logger.warn('Skipped unreadable session while listing:', historyPath, e.message);
            }
        }
        sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        return sessions;
    }

    /**
     * 两个十六进制字符串的常量时间比较。先比长度（不等直接 false，
     * timingSafeEqual 对长度不等的 Buffer 会抛异常），再逐字节比较，
     * 抵御对 token/密码 hash 的时序侧信道。
     */
    _constTimeEqual(a, b) {
        if (typeof a !== 'string' || typeof b !== 'string') return false;
        if (a.length !== b.length) return false;
        try {
            return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
        } catch (e) {
            return false;
        }
    }
}

module.exports = { UserStore, USERNAME_PATTERN };
