/**
 * User Auth Middleware
 * 校验 Authorization: Bearer <token> 头，通过则把 req.user 设为 username，
 * 否则 401。与 auth.js（X-API-Key 服务级鉴权）正交：auth.js 保留用于可选的
 * API_KEY 层，本中间件负责浏览器登录态。
 *
 * 失败时同步 res.end()，与既有中间件链的 `if (res.headersSent) return`
 * 短路约定一致。
 */

const logger = require('../utils/logger');

function authUserMiddleware(userStore) {
    return (req, res, next) => {
        const authHeader = req.headers && req.headers.authorization;
        const prefix = 'Bearer ';
        // 严格前缀匹配：避免把 "Bearer" 当成空 token 蒙混过 split 逻辑
        if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith(prefix)) {
            _unauthorized(res, '缺少登录凭证');
            return;
        }

        const token = authHeader.slice(prefix.length).trim();
        const username = userStore.verifyToken(token);
        if (!username) {
            _unauthorized(res, '登录已失效或凭证无效');
            return;
        }

        req.user = username;
        next();
    };
}

function _unauthorized(res, message) {
    logger.warn('User auth rejected:', message);
    if (res.status && typeof res.status === 'function') {
        return res.status(401).json({ error: 'Unauthorized', message });
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized', message }));
}

module.exports = authUserMiddleware;
