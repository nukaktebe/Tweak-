// ============================================================
//   Архив погоды через Open-Meteo (CC BY 4.0).
//   Браузер шлёт POST { этапы: [{ место, датаОтISO, датаДоISO }] }.
//   Функция геокодирует город и усредняет температуру/осадки
//   за те же календарные даты последние 5 лет.
// ============================================================

import { ipКлиента, проверитьRateLimit, разобратьТело, отклонить } from './guard.js';

const ГЕОКОД = 'https://geocoding-api.open-meteo.com/v1/search';
const АРХИВ = 'https://archive-api.open-meteo.com/v1/archive';
const ЛИМИТ_WEATHER = 30;
const ОКНО_WEATHER_МС = 10 * 60 * 1000;
const МАКС_ЭТАПОВ = 12;
const МАКС_УНИКАЛЬНЫХ = 8;

const кэшГео = new Map();
const кэшПогоды = new Map();

function ограничитьКэш(карта, максимум) {
    while (карта.size > максимум) {
        const первый = карта.keys().next().value;
        карта.delete(первый);
    }
}

function валиднаяISO(строка) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(строка || '')) {
        return false;
    }
    const дата = Date.parse(строка + 'T00:00:00Z');
    return !Number.isNaN(дата);
}

function дваЗнака(число) {
    return String(число).padStart(2, '0');
}

function датаISO(год, месяц, день) {
    const дата = new Date(Date.UTC(год, месяц - 1, день));
    return дата.getUTCFullYear() + '-' + дваЗнака(дата.getUTCMonth() + 1) + '-' + дваЗнака(дата.getUTCDate());
}

function разобратьISO(строка) {
    const части = String(строка || '').slice(0, 10).split('-');
    if (части.length !== 3) {
        return null;
    }
    const год = Number(части[0]);
    const месяц = Number(части[1]);
    const день = Number(части[2]);
    if (!год || !месяц || !день) {
        return null;
    }
    return { год, месяц, день };
}

function среднее(числа) {
    const валидные = числа.filter(function (н) { return typeof н === 'number' && !Number.isNaN(н); });
    if (валидные.length === 0) {
        return null;
    }
    return валидные.reduce(function (с, н) { return с + н; }, 0) / валидные.length;
}

function описатьОсадки(ммВДень) {
    if (ммВДень == null) {
        return { осадки: 'нет данных', значок: '🌤' };
    }
    if (ммВДень < 0.5) {
        return { осадки: 'без осадков', значок: '☀️' };
    }
    if (ммВДень < 2) {
        return { осадки: 'редкие дожди', значок: '🌤' };
    }
    if (ммВДень < 5) {
        return { осадки: 'возможны дожди', значок: '🌧' };
    }
    return { осадки: 'часто идут дожди', значок: '🌧' };
}

function периодСловами(датаОт, датаДо) {
    const месяца = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const а = разобратьISO(датаОт);
    const б = разобратьISO(датаДо);
    if (!а || !б) {
        return 'в выбранные даты';
    }
    if (а.месяц === б.месяц) {
        return 'с ' + а.день + ' по ' + б.день + ' ' + месяца[б.месяц - 1];
    }
    return 'с ' + а.день + ' ' + месяца[а.месяц - 1] + ' по ' + б.день + ' ' + месяца[б.месяц - 1];
}

function окнаПятиЛет(датаОтISO, датаДоISO) {
    const начало = разобратьISO(датаОтISO);
    const конец = разобратьISO(датаДоISO);
    if (!начало || !конец) {
        return [];
    }
    const переходГода = (конец.месяц < начало.месяц) ||
        (конец.месяц === начало.месяц && конец.день < начало.день);
    const текущийГод = new Date().getUTCFullYear();
    const последнийПолныйГод = текущийГод - 1;
    const окна = [];
    for (let i = 0; i < 5; i++) {
        const годСтарта = последнийПолныйГод - i;
        const годКонца = переходГода ? годСтарта + 1 : годСтарта;
        окна.push({
            start: датаISO(годСтарта, начало.месяц, начало.день),
            end: датаISO(годКонца, конец.месяц, конец.день)
        });
    }
    return окна;
}

async function геокодировать(место) {
    const город = String(место || '').split(',')[0].trim();
    if (!город) {
        return null;
    }
    if (кэшГео.has(город)) {
        return кэшГео.get(город);
    }
    const url = ГЕОКОД + '?name=' + encodeURIComponent(город) + '&count=1&language=ru&format=json';
    const ответ = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!ответ.ok) {
        кэшГео.set(город, null);
        return null;
    }
    const данные = await ответ.json();
    const точка = данные && данные.results && данные.results[0];
    const координаты = точка
        ? { lat: точка.latitude, lon: точка.longitude, имя: точка.name || город }
        : null;
    кэшГео.set(город, координаты);
    ограничитьКэш(кэшГео, 200);
    return координаты;
}

async function архивЗаОкно(lat, lon, start, end) {
    const url = АРХИВ +
        '?latitude=' + lat +
        '&longitude=' + lon +
        '&start_date=' + start +
        '&end_date=' + end +
        '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum' +
        '&timezone=auto';
    const ответ = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!ответ.ok) {
        return null;
    }
    const данные = await ответ.json();
    return данные && данные.daily ? данные.daily : null;
}

async function погодаПоГороду(место, датаОтISO, датаДоISO) {
    const ключКэша = место + '|' + датаОтISO + '|' + датаДоISO;
    if (кэшПогоды.has(ключКэша)) {
        return кэшПогоды.get(ключКэша);
    }

    const координаты = await геокодировать(место);
    if (!координаты) {
        кэшПогоды.set(ключКэша, null);
        return null;
    }

    const окна = окнаПятиЛет(датаОтISO, датаДоISO);
    const ряды = await Promise.all(окна.map(function (окно) {
        return архивЗаОкно(координаты.lat, координаты.lon, окно.start, окно.end)
            .catch(function () { return null; });
    }));

    const максимумы = [];
    const минимумы = [];
    const осадки = [];
    ряды.forEach(function (день) {
        if (!день) {
            return;
        }
        (день.temperature_2m_max || []).forEach(function (т) { максимумы.push(т); });
        (день.temperature_2m_min || []).forEach(function (т) { минимумы.push(т); });
        (день.precipitation_sum || []).forEach(function (о) { осадки.push(о); });
    });

    const день = среднее(максимумы);
    const ночь = среднее(минимумы);
    const мм = среднее(осадки);
    if (день == null) {
        кэшПогоды.set(ключКэша, null);
        return null;
    }

    const осадкиТекст = описатьОсадки(мм);
    const городКратко = String(место).split(',')[0].trim();
    const днёмОкр = Math.round(день);
    const ночьюОкр = ночь == null ? null : Math.round(ночь);
    const знакДень = днёмОкр > 0 ? '+' : '';
    const знакНочь = ночьюОкр == null ? '' : (ночьюОкр > 0 ? '+' : '');
    const ночьТекст = ночьюОкр == null ? '' : ', ночью около ' + знакНочь + ночьюОкр + '°C';

    const результат = {
        температура: знакДень + днёмОкр + '°C',
        осадки: осадкиТекст.осадки,
        значок: осадкиТекст.значок,
        архив: 'Согласно архиву погоды Open-Meteo за последние 5 лет, в городе ' +
            городКратко + ' ' + периодСловами(датаОтISO, датаДоISO) +
            ' обычно днём около ' + знакДень + днёмОкр + '°C' + ночьТекст +
            ', ' + осадкиТекст.осадки +
            '. Данные усреднённые и носят справочный характер.'
    };
    кэшПогоды.set(ключКэша, результат);
    ограничитьКэш(кэшПогоды, 300);
    return результат;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ ошибка: 'Поддерживается только POST' });
        return;
    }

    const лимит = проверитьRateLimit('weather', ipКлиента(req), ЛИМИТ_WEATHER, ОКНО_WEATHER_МС);
    if (!лимит.ok) {
        отклонить(res, лимит.статус, лимит.ошибка);
        return;
    }

    const разобрано = разобратьТело(req);
    if (!разобрано.ok) {
        отклонить(res, разобрано.статус, разобрано.ошибка);
        return;
    }
    const тело = разобрано.тело || {};
    const сырыеЭтапы = Array.isArray(тело.этапы) ? тело.этапы.slice(0, МАКС_ЭТАПОВ) : [];
    const этапы = сырыеЭтапы.map(function (этап) {
        const место = String((этап && этап.место) || '').slice(0, 80);
        const датаОтISO = этап && этап.датаОтISO;
        const датаДоISO = этап && этап.датаДоISO;
        if (!место || !валиднаяISO(датаОтISO) || !валиднаяISO(датаДоISO)) {
            return null;
        }
        const дней = (Date.parse(датаДоISO + 'T00:00:00Z') - Date.parse(датаОтISO + 'T00:00:00Z')) / 86400000;
        if (дней < 0 || дней > 31) {
            return null;
        }
        return { место: место, датаОтISO: датаОтISO, датаДоISO: датаДоISO };
    }).filter(Boolean);
    if (этапы.length === 0) {
        res.status(400).json({ ошибка: 'Нет корректных этапов для расчёта погоды' });
        return;
    }

    try {
        const уникальные = [];
        const индекс = new Map();
        этапы.forEach(function (этап) {
            const ключ = этап.место + '|' + этап.датаОтISO + '|' + этап.датаДоISO;
            if (!индекс.has(ключ)) {
                if (уникальные.length >= МАКС_УНИКАЛЬНЫХ) {
                    return;
                }
                индекс.set(ключ, уникальные.length);
                уникальные.push({
                    место: этап.место,
                    датаОтISO: этап.датаОтISO,
                    датаДоISO: этап.датаДоISO
                });
            }
        });

        const погоды = await Promise.all(уникальные.map(function (запрос) {
            return погодаПоГороду(запрос.место, запрос.датаОтISO, запрос.датаДоISO)
                .catch(function () { return null; });
        }));

        const результат = этапы.map(function (этап) {
            const ключ = этап.место + '|' + этап.датаОтISO + '|' + этап.датаДоISO;
            if (!индекс.has(ключ)) {
                return null;
            }
            return погоды[индекс.get(ключ)] || null;
        });

        res.status(200).json({ погода: результат, источник: 'Open-Meteo' });
    } catch (ошибка) {
        res.status(502).json({ ошибка: 'Не удалось получить архив погоды: ' + String(ошибка && ошибка.message) });
    }
}
