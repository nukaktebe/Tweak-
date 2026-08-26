// Общие ограничения для публичных API: размер тела и rate limit по IP.

export const ЛИМИТ_ТЕЛА_БАЙТ = 150000;

const корзины = new Map();

function почиститьКорзины(сейчас) {
    корзины.forEach(function (запись, ключ) {
        if (!запись || запись.до < сейчас) {
            корзины.delete(ключ);
        }
    });
}

export function ipКлиента(req) {
    const заголовки = (req && req.headers) || {};
    const forwarded = заголовки['x-forwarded-for'] || заголовки['X-Forwarded-For'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim().slice(0, 64);
    }
    const real = заголовки['x-real-ip'] || заголовки['X-Real-Ip'];
    if (typeof real === 'string' && real.trim()) {
        return real.trim().slice(0, 64);
    }
    if (req && req.socket && req.socket.remoteAddress) {
        return String(req.socket.remoteAddress).slice(0, 64);
    }
    return 'unknown';
}

/**
 * @returns {{ ok: true } | { ok: false, статус: number, ошибка: string }}
 */
export function проверитьRateLimit(имя, ip, максимум, окноМс) {
    const сейчас = Date.now();
    if (корзины.size > 5000) {
        почиститьКорзины(сейчас);
    }
    const ключ = имя + ':' + (ip || 'unknown');
    let запись = корзины.get(ключ);
    if (!запись || запись.до < сейчас) {
        запись = { счётчик: 0, до: сейчас + окноМс };
        корзины.set(ключ, запись);
    }
    запись.счётчик += 1;
    if (запись.счётчик > максимум) {
        return {
            ok: false,
            статус: 429,
            ошибка: 'Слишком много запросов. Подождите несколько минут и попробуйте снова.'
        };
    }
    return { ok: true };
}

/**
 * Разбор тела + лимит размера. На Vercel body уже объект — меряем JSON.stringify.
 * @returns {{ ok: true, тело: object } | { ok: false, статус: number, ошибка: string }}
 */
export function разобратьТело(req) {
    let сырое = req && req.body;
    if (сырое == null || сырое === '') {
        return { ok: true, тело: {} };
    }
    if (typeof сырое === 'string') {
        if (сырое.length > ЛИМИТ_ТЕЛА_БАЙТ) {
            return { ok: false, статус: 413, ошибка: 'Слишком большой запрос' };
        }
        try {
            return { ok: true, тело: JSON.parse(сырое || '{}') || {} };
        } catch (e) {
            return { ok: false, статус: 400, ошибка: 'Некорректный JSON в теле запроса' };
        }
    }
    if (typeof сырое === 'object') {
        let размер = 0;
        try {
            размер = JSON.stringify(сырое).length;
        } catch (e) {
            return { ok: false, статус: 400, ошибка: 'Некорректное тело запроса' };
        }
        if (размер > ЛИМИТ_ТЕЛА_БАЙТ) {
            return { ok: false, статус: 413, ошибка: 'Слишком большой запрос' };
        }
        return { ok: true, тело: сырое };
    }
    return { ok: false, статус: 400, ошибка: 'Некорректное тело запроса' };
}

export function отклонить(res, статус, ошибка) {
    res.status(статус).json({ ошибка: ошибка });
}
