import { useSyncExternalStore } from "react";
import { pinyin } from "pinyin-pro";
import { hydrateKvDb, kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadRestTools } from "./tool-storage";

export const REAL_WORLD_SENSE_STALE_MS = 15 * 60 * 1000;

const STORAGE_KEY = "ai_phone_real_world_sense_v1";
registerKvMigration(STORAGE_KEY);

export type RealWorldSenseStatus = "idle" | "loading" | "ok" | "denied" | "error";
export type RealWorldLocationMode = "auto" | "manual";

export type RealWorldWeatherSnapshot = {
    locationLabel: string;
    latitude: number;
    longitude: number;
    temperatureC: number;
    feelsLikeC: number;
    conditionText: string;
    conditionCode: number | null;
    isDay: boolean;
    humidity: number;
    windKph: number;
    source: "open-meteo" | "weatherapi";
    approximate?: boolean;
    updatedAt: string;
};

export type RealWorldSenseState = {
    enabled: boolean;
    status: RealWorldSenseStatus;
    locationMode: RealWorldLocationMode;
    manualPlace: string;
    error: string;
    snapshot: RealWorldWeatherSnapshot | null;
};

const EMPTY_STATE: RealWorldSenseState = {
    enabled: false,
    status: "idle",
    locationMode: "auto",
    manualPlace: "",
    error: "",
    snapshot: null,
};

function readState(): RealWorldSenseState {
    if (typeof window === "undefined") return { ...EMPTY_STATE };
    try {
        const raw = kvGet(STORAGE_KEY);
        if (!raw) return { ...EMPTY_STATE };
        const parsed = JSON.parse(raw) as Partial<RealWorldSenseState>;
        return {
            ...EMPTY_STATE,
            ...parsed,
            locationMode: parsed.locationMode === "manual" ? "manual" : "auto",
            manualPlace: typeof parsed.manualPlace === "string" ? parsed.manualPlace : "",
            error: typeof parsed.error === "string" ? parsed.error : "",
            snapshot: parsed.snapshot ? { ...parsed.snapshot } : null,
        };
    } catch {
        return { ...EMPTY_STATE };
    }
}

let currentState: RealWorldSenseState = readState();
const listeners = new Set<() => void>();
let bootstrapStarted = false;

function notify() {
    for (const listener of listeners) listener();
}

function write(next: RealWorldSenseState) {
    currentState = next;
    try {
        kvSet(STORAGE_KEY, JSON.stringify(next));
    } catch {
        // persistence is best-effort
    }
    notify();
}

function patchState(patch: Partial<RealWorldSenseState>) {
    write({ ...currentState, ...patch });
}

export function refreshRealWorldSenseStateFromStorage(): void {
    const next = readState();
    if (JSON.stringify(next) !== JSON.stringify(currentState)) {
        currentState = next;
        notify();
    }
}

export function subscribeRealWorldSense(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useRealWorldSenseState(): RealWorldSenseState {
    return useSyncExternalStore(
        subscribeRealWorldSense,
        getRealWorldSenseState,
        getRealWorldSenseState,
    );
}

export function getRealWorldSenseState(): RealWorldSenseState {
    return currentState;
}

function ensureStorageHydrated() {
    if (typeof window === "undefined" || bootstrapStarted) return;
    bootstrapStarted = true;
    void hydrateKvDb().then(() => refreshRealWorldSenseStateFromStorage());
}

ensureStorageHydrated();

async function fetchJson(url: string): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
        headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
}

function getWeatherApiKey(): string {
    try {
        const weatherTool = loadRestTools().find(tool => tool.id === "builtin_weather");
        return weatherTool?.fixedParams?.key?.trim() || "";
    } catch {
        return "";
    }
}

function compactLabel(parts: Array<string | undefined>): string {
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const part of parts) {
        const value = (part || "").trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        clean.push(value);
    }
    return clean.join(" · ");
}

function coordFallbackLabel(latitude: number, longitude: number): string {
    return `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`;
}

async function reverseGeocode(latitude: number, longitude: number): Promise<string> {
    try {
        const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=zh`;
        const data = (await fetchJson(url)) as {
            city?: string;
            locality?: string;
            principalSubdivision?: string;
            countryName?: string;
        };
        const city = data.city || data.principalSubdivision;
        const label = compactLabel([
            city,
            data.locality && data.locality !== city ? data.locality : "",
            data.countryName && data.countryName !== city ? data.countryName : "",
        ]);
        return label || coordFallbackLabel(latitude, longitude);
    } catch {
        return coordFallbackLabel(latitude, longitude);
    }
}

function weatherCodeText(code: number): string {
    if (code === 0) return "晴";
    if (code === 1) return "大部晴朗";
    if (code === 2) return "多云";
    if (code === 3) return "阴";
    if (code === 45 || code === 48) return "雾";
    if (code >= 51 && code <= 57) return "毛毛雨";
    if (code >= 61 && code <= 65) return "雨";
    if (code >= 66 && code <= 67) return "冻雨";
    if (code >= 71 && code <= 77) return "雪";
    if (code >= 80 && code <= 82) return "阵雨";
    if (code >= 85 && code <= 86) return "阵雪";
    if (code >= 95) return "雷暴";
    return "多云";
}

function weatherApiSnapshot(data: Record<string, unknown>): {
    snapshot: Omit<RealWorldWeatherSnapshot, "locationLabel" | "latitude" | "longitude" | "updatedAt">;
    locationLabel: string;
} {
    const current = data.current as Record<string, unknown> | undefined;
    if (!current || typeof current.temp_c !== "number") {
        throw new Error("天气服务返回了无法识别的数据。");
    }
    const location = data.location as Record<string, unknown> | undefined;
    const condition = current.condition as Record<string, unknown> | undefined;
    const locationLabel = compactLabel([
        typeof location?.name === "string" ? location.name : "",
        typeof location?.region === "string" ? location.region : "",
        typeof location?.country === "string" ? location.country : "",
    ]);
    return {
        snapshot: {
            temperatureC: current.temp_c as number,
            feelsLikeC: typeof current.feelslike_c === "number" ? current.feelslike_c : current.temp_c as number,
            conditionText: typeof condition?.text === "string" && condition.text ? String(condition.text) : "未知",
            conditionCode: null,
            isDay: current.is_day === 1,
            humidity: typeof current.humidity === "number" ? current.humidity : 0,
            windKph: typeof current.wind_kph === "number" ? current.wind_kph : 0,
            source: "weatherapi",
        },
        locationLabel,
    };
}

async function fetchWeatherApi(q: string): Promise<{
    snapshot: Omit<RealWorldWeatherSnapshot, "locationLabel" | "latitude" | "longitude" | "updatedAt">;
    locationLabel: string;
}> {
    const key = getWeatherApiKey();
    const url = `https://api.weatherapi.com/v1/current.json?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&aqi=no&lang=zh`;
    const data = await fetchJson(url);
    return weatherApiSnapshot(data);
}

async function fetchOpenMeteo(latitude: number, longitude: number): Promise<{
    snapshot: Omit<RealWorldWeatherSnapshot, "locationLabel" | "latitude" | "longitude" | "updatedAt">;
    locationLabel: string;
}> {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m&temperature_unit=celsius&wind_speed_unit=kmh&timezone=auto&forecast_days=1`;
    const [data, locationLabel] = await Promise.all([
        fetchJson(url),
        reverseGeocode(latitude, longitude),
    ]);
    const current = data.current as Record<string, unknown> | undefined;
    if (!current || typeof current.temperature_2m !== "number") {
        throw new Error("天气服务返回了无法识别的数据。");
    }
    const code = typeof current.weather_code === "number" ? current.weather_code : null;
    return {
        snapshot: {
            temperatureC: current.temperature_2m as number,
            feelsLikeC: typeof current.apparent_temperature === "number" ? current.apparent_temperature : current.temperature_2m as number,
            conditionText: code === null ? "未知" : weatherCodeText(code),
            conditionCode: code,
            isDay: current.is_day === 1,
            humidity: typeof current.relative_humidity_2m === "number" ? current.relative_humidity_2m : 0,
            windKph: typeof current.wind_speed_10m === "number" ? current.wind_speed_10m : 0,
            source: "open-meteo",
        },
        locationLabel,
    };
}

async function fetchWeatherSnapshot(
    latitude: number,
    longitude: number,
): Promise<{
    snapshot: Omit<RealWorldWeatherSnapshot, "locationLabel" | "latitude" | "longitude" | "updatedAt">;
    locationLabel: string;
}> {
    if (getWeatherApiKey()) {
        try {
            const result = await fetchWeatherApi(`${latitude},${longitude}`);
            if (result.locationLabel) return result;
        } catch {
            // fall through to keyless provider
        }
    }
    return fetchOpenMeteo(latitude, longitude);
}

function getBrowserPosition(): Promise<{ latitude: number; longitude: number }> {
    return new Promise((resolve, reject) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            const err = new Error("当前设备或浏览器不支持定位。");
            (err as Error & { permissionDenied?: boolean }).permissionDenied = false;
            reject(err);
            return;
        }
        navigator.geolocation.getCurrentPosition(
            position => resolve({
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
            }),
            error => {
                const err = new Error(error?.message ? `定位失败：${error.message}` : "定位失败。");
                (err as Error & { permissionDenied?: boolean }).permissionDenied = error?.code === 1;
                reject(err);
            },
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 },
        );
    });
}

async function fetchIpLocation(): Promise<{ latitude: number; longitude: number; label: string }> {
    const data = await fetchJson("https://ipwho.is/");
    const latitude = typeof data.latitude === "number" ? data.latitude : Number(data.latitude);
    const longitude = typeof data.longitude === "number" ? data.longitude : Number(data.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error("网络定位失败。");
    }
    const label = await reverseGeocode(latitude, longitude);
    return { latitude, longitude, label };
}

function isAdministrativeGeocodeHit(hit: Record<string, unknown>): boolean {
    const featureCode = typeof hit.feature_code === "string" ? hit.feature_code : "";
    if (featureCode === "PPLC" || featureCode === "PPLA" || featureCode === "PPLA2"
        || featureCode === "PPLA3" || featureCode === "PPLA4" || featureCode === "PPLA5"
        || featureCode === "PPLX" || featureCode === "PPL") return true;
    if (featureCode.startsWith("ADM")) return true;
    return false;
}

function geocodeHitScore(hit: Record<string, unknown>, query: string, baseQuery: string): number {
    const name = typeof hit.name === "string" ? hit.name : "";
    const admin1 = typeof hit.admin1 === "string" ? hit.admin1 : "";
    const admin2 = typeof hit.admin2 === "string" ? hit.admin2 : "";
    const featureCode = typeof hit.feature_code === "string" ? hit.feature_code : "";
    const countryCode = typeof hit.country_code === "string" ? hit.country_code : "";
    let score = 0;

    if (countryCode === "CN") score += 6;
    if (isAdministrativeGeocodeHit(hit)) score += 18;
    if (featureCode === "PPLC" || featureCode === "PPLA") score += 18;
    if (featureCode === "PPLA2" || featureCode === "PPLA3") score += 10;
    if (featureCode === "PRK" || featureCode === "AIRP") score -= 30;

    if (query === name) score += 22;
    if (name === `${baseQuery}市` || name === `${baseQuery}州` || name === `${baseQuery}地区`) score += 30;
    if (name.startsWith(baseQuery) && name.length > baseQuery.length) score += 12;
    if (admin1 === baseQuery || admin2 === baseQuery || admin2 === `${baseQuery}市`) score += 14;
    if (admin1 && admin2) score += 4;

    return score;
}

async function geocodeOpenMeteo(place: string): Promise<{ latitude: number; longitude: number; label: string }> {
    const baseQuery = place.trim();
    const isChinese = /[\u4e00-\u9fff]/.test(baseQuery);
    const queries = [baseQuery];
    if (!/(市|州|县|区|镇|乡|盟|旗|地区|自治)$/.test(baseQuery)) {
        queries.push(`${baseQuery}市`);
    }

    let romanQuery = "";
    if (isChinese) {
        try {
            const cityCore = baseQuery.replace(/(?:省|市)$/g, "");
            romanQuery = pinyin(cityCore, { toneType: "none" }).replace(/\s+/g, "").toLowerCase();
            if (romanQuery && romanQuery !== cityCore.toLowerCase()) {
                queries.unshift(romanQuery);
            }
        } catch {
            // keep original Chinese queries
        }
    }

    const settled = await Promise.allSettled(
        queries.map(async (query) => {
            const language = /^[a-z0-9]+$/i.test(query) ? "en" : "zh";
            const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=10&language=${language}&format=json`;
            const data = await fetchJson(url);
            return { query, results: (data.results as Array<Record<string, unknown>> | undefined) || [] };
        }),
    );

    const candidates: Array<{ hit: Record<string, unknown>; score: number }> = [];
    for (const item of settled) {
        if (item.status !== "fulfilled") continue;
        for (const hit of item.value.results) {
            candidates.push({
                hit,
                score: geocodeHitScore(hit, item.value.query, baseQuery),
            });
        }
    }

    const romanCandidates = romanQuery
        ? candidates.filter(item => item.hit.name && typeof item.hit.name === "string"
            && String(item.hit.name).toLowerCase() === romanQuery)
        : [];
    const best = (romanCandidates.length > 0 ? romanCandidates : candidates)
        .sort((a, b) => b.score - a.score)[0];
    const hit = best?.hit;
    if (!hit || typeof hit.latitude !== "number" || typeof hit.longitude !== "number") {
        throw new Error("找不到这个地点，试试更具体的城市名。");
    }
    const name = typeof hit.name === "string" ? hit.name : "";
    const admin1 = typeof hit.admin1 === "string" ? hit.admin1 : "";
    const admin2 = typeof hit.admin2 === "string" ? hit.admin2 : "";
    const country = typeof hit.country === "string" ? hit.country : "";
    return {
        latitude: hit.latitude,
        longitude: hit.longitude,
        label: isChinese
            ? baseQuery
            : compactLabel([
                name,
                admin2 !== name ? admin2 : "",
                admin1 !== name && admin1 !== admin2 ? admin1 : "",
                country !== name && country !== admin1 && country !== admin2 ? country : "",
            ]) || place,
    };
}

async function geocodePlace(place: string): Promise<{ latitude: number; longitude: number; label: string }> {
    if (getWeatherApiKey()) {
        try {
            const key = getWeatherApiKey();
            const url = `https://api.weatherapi.com/v1/current.json?key=${encodeURIComponent(key)}&q=${encodeURIComponent(place)}&aqi=no&lang=zh`;
            const data = await fetchJson(url);
            const location = data.location as Record<string, unknown> | undefined;
            const result = weatherApiSnapshot(data);
            const latitude = typeof location?.lat === "number" ? location.lat : 0;
            const longitude = typeof location?.lon === "number" ? location.lon : 0;
            if (latitude && longitude) {
                return {
                    latitude,
                    longitude,
                    label: result.locationLabel || place,
                };
            }
            return {
                latitude: 0,
                longitude: 0,
                label: result.locationLabel || place,
            };
        } catch {
            // fall through to keyless geocoder
        }
    }
    return geocodeOpenMeteo(place);
}

export function setRealWorldSenseEnabled(enabled: boolean): void {
    patchState({ enabled });
    if (enabled && (!currentState.snapshot || !isRealWorldSnapshotFresh(currentState.snapshot))) {
        void refreshRealWorldSense({ force: true });
    }
}

export async function refreshRealWorldSense(options?: { force?: boolean }): Promise<void> {
    const state = currentState;
    if (!options?.force && state.status === "loading") return;
    patchState({ status: "loading", error: "" });
    try {
        const manual = currentState.manualPlace.trim();
        let latitude: number;
        let longitude: number;
        let locationLabel = "";
        let locationMode: RealWorldLocationMode = "auto";
        let approximate = false;

        if (currentState.locationMode === "manual" && manual) {
            const geo = await geocodePlace(manual);
            latitude = geo.latitude;
            longitude = geo.longitude;
            locationLabel = geo.label;
            locationMode = "manual";
        } else {
            try {
                const pos = await getBrowserPosition();
                latitude = pos.latitude;
                longitude = pos.longitude;
                locationMode = "auto";
            } catch (err) {
                try {
                    const ip = await fetchIpLocation();
                    latitude = ip.latitude;
                    longitude = ip.longitude;
                    locationLabel = ip.label;
                    locationMode = "auto";
                    approximate = true;
                } catch {
                    const denied = Boolean((err as Error & { permissionDenied?: boolean }).permissionDenied);
                    if (!manual || denied) {
                        patchState({
                            status: denied ? "denied" : "error",
                            error: denied ? "浏览器未授权定位。" : "定位失败，请稍后重试。",
                            locationMode: denied ? "auto" : currentState.locationMode,
                        });
                        return;
                    }
                    const geo = await geocodePlace(manual);
                    latitude = geo.latitude;
                    longitude = geo.longitude;
                    locationLabel = geo.label;
                    locationMode = "manual";
                }
            }
        }

        if (!latitude || !longitude) {
            throw new Error("未能取得定位坐标。");
        }

        const fetched = await fetchWeatherSnapshot(latitude, longitude);
        const snapshot: RealWorldWeatherSnapshot = {
            ...fetched.snapshot,
            locationLabel: fetched.locationLabel || locationLabel || coordFallbackLabel(latitude, longitude),
            latitude,
            longitude,
            approximate: approximate || undefined,
            updatedAt: new Date().toISOString(),
        };
        patchState({ status: "ok", snapshot, locationMode, error: "" });
    } catch (err) {
        const message = err instanceof Error ? err.message : "获取实时环境失败，请稍后重试。";
        patchState({ status: "error", error: message });
    }
}

export async function setManualRealWorldLocation(place: string): Promise<void> {
    const manualPlace = place.trim();
    if (!manualPlace) return;
    patchState({
        status: "loading",
        locationMode: "manual",
        manualPlace,
        error: "",
    });
    await refreshRealWorldSense({ force: true });
}

export function requestAutoRealWorldLocation(): void {
    patchState({
        status: "loading",
        locationMode: "auto",
        error: "",
    });
    void refreshRealWorldSense({ force: true });
}

export function isRealWorldSnapshotFresh(snapshot: RealWorldWeatherSnapshot | null | undefined): boolean {
    if (!snapshot) return false;
    const age = Date.now() - new Date(snapshot.updatedAt).getTime();
    return Number.isFinite(age) && age >= 0 && age < REAL_WORLD_SENSE_STALE_MS;
}

export function formatRealWorldUpdateTime(value: string | null | undefined): string {
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

const WEATHER_TOPIC_RE = /天气|气温|温度|冷不冷|热不热|下雨|下雪|下雹|台风|刮风|风大|雾|霾|晴|阴|雪|雷|位置|定位|地点|所在|城市|哪里|在哪/;

export function buildRealWorldSensePrompt(recentText: string, userName = "用户"): string {
    const state = currentState;
    if (!state.enabled) {
        return WEATHER_TOPIC_RE.test(recentText)
            ? `\n<现实环境感知> 环境感知当前关闭，${userName}没有允许系统读取定位与天气。若话题涉及${userName}的位置或实时天气，不要编造这些事实；可以自然承认不知道，或把话题转向不依赖实时环境的内容。`
            : "";
    }
    if (state.status !== "ok" || !state.snapshot) {
        return `\n<现实环境感知> ${userName}已开启环境感知，但系统暂时没有取得定位或实时天气。不要编造${userName}所在地点、当前天气或温度；如果聊到这些内容，请如实表示还看不到。`;
    }
    const s = state.snapshot;
    const temperature = Math.round(s.temperatureC);
    const feelsLike = Math.round(s.feelsLikeC);
    const humidity = Math.round(s.humidity);
    const wind = Math.round(s.windKph);
    return [
        "",
        `<现实环境感知> ${userName}已开启环境感知，以下是你当前可以确知的事实，未列出的请勿编造：`,
        `- ${userName}所在地：${s.locationLabel}`,
        ...(s.approximate ? ["- 定位说明：当前为网络定位，可能与实际位置有偏差"] : []),
        `- 实时天气：${s.conditionText}`,
        `- 当前温度：${temperature}°C，体感${feelsLike}°C`,
        `- 湿度：${humidity}%，风速：${wind} km/h`,
        `- 数据更新于：${formatRealWorldUpdateTime(s.updatedAt)}`,
        "聊天中涉及天气、出行或穿衣时可自然使用这些数据，但不要自行补充城市、温度或天气细节。",
    ].join("\n");
}
