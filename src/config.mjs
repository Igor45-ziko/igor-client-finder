// Approximate search centres, NOT administrative borders or a company list.
export const CITIES = [
  { name: 'Тверь', lat: 56.8587, lon: 35.9176, radius: 12000 },
  { name: 'Тула', lat: 54.1931, lon: 37.6173, radius: 15000 },
  { name: 'Рязань', lat: 54.6292, lon: 39.7364, radius: 12000 },
];
export const ENDPOINT = 'https://overpass-api.de/api/interpreter';
export const ATTRIBUTION = '© OpenStreetMap contributors; ODbL 1.0; https://www.openstreetmap.org/copyright';
export const CACHE_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_INTERVAL_MS = 15000;
export const USER_AGENT = 'IgorClientFinder/0.1 (small local OSM research; no messaging)';

export function queryFor(city) {
  return `[out:json][timeout:25][maxsize:16777216];\nnwr["shop"="car_repair"](around:${city.radius},${city.lat},${city.lon});\nout body center;`;
}

export function parseArgs(args) {
  const options = { cities: CITIES, target: 20, refresh: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--target') {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 20)
        throw new Error('--target: укажите целое число от 1 до 20.');
      options.target = Number(value);
    } else if (arg === '--cities') {
      const names = (args[++i] || '').split(',').map(x => x.trim()).filter(Boolean);
      if (!names.length || names.some(x => !CITIES.some(c => c.name === x)))
        throw new Error('--cities: допустимы Тверь,Тула,Рязань (через запятую).');
      options.cities = [...new Set(names)].map(name => CITIES.find(c => c.name === name));
    } else throw new Error(`Неизвестный аргумент: ${arg}. Используйте --help.`);
  }
  return options;
}
