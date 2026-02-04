// ============================================
// MÓDULO DE AUTENTICACIÓN
// ============================================
// Maneja sesiones, login/logout y middleware de auth
// Se configura desde server.js con configure(app)

var crypto = require('crypto');

// Credenciales de usuario desde variables de entorno
var AUTH_USER = process.env.AUTH_USER || 'admin';
var AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'admin123';

// Almacén de sesiones en memoria
var sessions = {};

// Generar token de sesión
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Middleware de autenticación (exportado para uso en otros módulos)
function requireAuth(req, res, next) {
  var token = req.cookies.session_token || req.headers['x-session-token'];

  if (!token || !sessions[token]) {
    return res.status(401).json({ error: 'No autorizado', requireLogin: true });
  }

  // Verificar que la sesión no haya expirado (24 horas)
  var session = sessions[token];
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    delete sessions[token];
    return res.status(401).json({ error: 'Sesión expirada', requireLogin: true });
  }

  req.user = session.user;
  next();
}

// ============================================
// CONFIGURACIÓN - Se llama desde server.js
// ============================================

function configure(app) {
  // Middleware para parsear cookies
  app.use(function(req, res, next) {
    var cookies = {};
    var cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      cookieHeader.split(';').forEach(function(cookie) {
        var parts = cookie.split('=');
        var key = parts[0].trim();
        var value = parts.slice(1).join('=').trim();
        cookies[key] = value;
      });
    }
    req.cookies = cookies;
    next();
  });

  // Endpoint de login
  app.post('/api/auth/login', function(req, res) {
    var username = req.body.username;
    var password = req.body.password;

    if (username === AUTH_USER && password === AUTH_PASSWORD) {
      var token = generateSessionToken();
      sessions[token] = {
        user: username,
        createdAt: Date.now()
      };

      res.cookie('session_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000 // 24 horas
      });

      console.log('Login exitoso para usuario: ' + username);
      res.json({ success: true, user: username });
    } else {
      console.log('Intento de login fallido para usuario: ' + username);
      res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
  });

  // Endpoint de logout
  app.post('/api/auth/logout', function(req, res) {
    var token = req.cookies.session_token || req.headers['x-session-token'];

    if (token && sessions[token]) {
      delete sessions[token];
    }

    res.clearCookie('session_token');
    res.json({ success: true });
  });

  // Endpoint para verificar sesión
  app.get('/api/auth/check', function(req, res) {
    var token = req.cookies.session_token || req.headers['x-session-token'];

    if (!token || !sessions[token]) {
      return res.json({ authenticated: false });
    }

    var session = sessions[token];
    if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
      delete sessions[token];
      return res.json({ authenticated: false });
    }

    res.json({ authenticated: true, user: session.user });
  });

  // Middleware global de autenticación para todas las rutas /api/ (excepto auth)
  app.use('/api', function(req, res, next) {
    // Rutas de autenticación no requieren estar logueado
    if (req.path.startsWith('/auth/')) {
      return next();
    }
    // Todas las demás rutas requieren autenticación
    requireAuth(req, res, next);
  });
}

module.exports = { configure: configure, requireAuth: requireAuth };
