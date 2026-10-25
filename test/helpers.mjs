import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CITIES } from '../src/config.mjs';

// Synthetic fixtures only. These are NOT real companies or harvested leads.
export const timestamp = Date.parse('2026-10-25T10:00:00Z');
export function element(id = 1, tags = {}, extra = {}) {
  return { type: 'node', id, lat: CITIES[0].lat, lon: CITIES[0].lon,
    tags: { shop: 'car_repair', name: 'Тестовая организация (вымышленная)', phone: '+7 000 000-00-01', ...tags }, ...extra };
}
export function payload(elements = [element()]) {
  return { version: 0.6, osm3s: { timestamp_osm_base: '2026-10-25T09:00:00Z' }, elements };
}
export const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
export async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'igor-client-finder-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
