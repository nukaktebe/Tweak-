// ============================================================
//   Локальный сервер для разработки TWEAK (без Vercel-логина).
//
//   Отдаёт статику (index.html и т.д.) и обрабатывает POST /api/route
//   и POST /api/weather. Ключ берётся из окружения: npm start
// ============================================================

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, relative, sep, basename } from 'node:path';
import handlerМаршрута from './api/route.js';
import handlerПогоды from './api/weather.js';

const ПОРТ = process.env.PORT || 3000;
const КОРЕНЬ = resolve(process.cwd());
const ЛИМИТ_ТЕЛА = 150000; // ~150 КБ — защита от раздувания памяти

const ТИПЫ = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp'
};

const ЗАПРЕЩЁННЫЕ_ИМЕНА = new Set([
    'config.js',
    '.env',
    '.env.local',
    '.env.example',
    '.gitignore',
    '.cursorignore',
    'package-lock.json'
]);

function путьЗапрещён(полныйПуть) {
    const имя = basename(полныйПуть);
    if (ЗАПРЕЩЁННЫЕ_ИМЕНА.has(имя) || имя.startsWith('.env')) {
        return true;
    }
    const отн = relative(КОРЕНЬ, полныйПуть).split(sep);
    return отн.some(function (часть) {
        return часть === 'node_modules' || часть === '.git' || часть === '.cursor' || часть === '.vercel';
    });
}

function безопасныйПуть(запрошенныйПуть) {
    let декодированный;
    try {
        декодированный = decodeURIComponent(запрошенныйПуть);
    } catch (e) {
        return null;
    }
    if (декодированный.indexOf('\0') !== -1) {
        return null;
    }
    const относительный = декодированный === '/' ? 'index.html' : декодированный.replace(/^\/+/, '');
    const полный = resolve(КОРЕНЬ, относительный);
    const отн = relative(КОРЕНЬ, полный);
    if (отн.startsWith('..') || отн === '' || resolve(полный) !== полный) {
        return null;
    }
    if (путьЗапрещён(полный)) {
        return null;
    }
    return полный;
}

function прочитатьТело(req) {
    return new Promise(function (разрешить, отклонить) {
        let данные = '';
        req.on('data', function (кусок) {
            данные += кусок;
            if (данные.length > ЛИМИТ_ТЕЛА) {
                отклонить(new Error('too_large'));
            }
        });
        req.on('end', function () { разрешить(данные); });
        req.on('error', отклонить);
    });
}

function обёрткаОтвета(res) {
    return {
        status(код) {
            res.statusCode = код;
            return this;
        },
        json(объект) {
            if (res.writableEnded) {
                return this;
            }
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(объект));
            return this;
        }
    };
}

const сервер = http.createServer(async function (req, res) {
    try {
        const url = new URL(req.url, 'http://localhost:' + ПОРТ);

        if (url.pathname === '/api/route' || url.pathname === '/api/weather') {
            let сыроеТело;
            try {
                сыроеТело = await прочитатьТело(req);
            } catch (ошибкаТела) {
                res.statusCode = ошибкаТела && ошибкаТела.message === 'too_large' ? 413 : 400;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ ошибка: 'Слишком большой или повреждённый запрос' }));
                return;
            }
            const псевдоReq = { method: req.method, body: сыроеТело };
            const обработчик = url.pathname === '/api/route' ? handlerМаршрута : handlerПогоды;
            await обработчик(псевдоReq, обёрткаОтвета(res));
            return;
        }

        const путь = безопасныйПуть(url.pathname);
        if (!путь) {
            res.statusCode = 403;
            res.end('Доступ запрещён');
            return;
        }

        try {
            const содержимое = await readFile(путь);
            res.setHeader('Content-Type', ТИПЫ[extname(путь)] || 'application/octet-stream');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.end(содержимое);
        } catch (ошибка) {
            res.statusCode = 404;
            res.end('Не найдено');
        }
    } catch (ошибкаСервера) {
        if (!res.writableEnded) {
            res.statusCode = 500;
            res.end('Ошибка сервера');
        }
    }
});

сервер.listen(ПОРТ, function () {
    const естьКлюч = !!process.env.OPENROUTER_API_KEY &&
        process.env.OPENROUTER_API_KEY !== 'ВСТАВЬТЕ_СВОЙ_КЛЮЧ_OPENROUTER';
    console.log('TWEAK dev-сервер запущен: http://localhost:' + ПОРТ);
    console.log('Модель ИИ:', process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash (по умолчанию)');
    console.log('Реальный ИИ:', естьКлюч ? 'включён (ключ найден)' : 'ВЫКЛ — работает демо-режим (нет ключа)');
});
