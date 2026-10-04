/** Bounded rendered-data retention. This module never stores component keys or raw tool state. */
export interface CacheStats {
  retainedBytes: number;
  limitBytes: number;
  entries: number;
  hits: number;
  misses: number;
  builds: number;
  evictions: number;
  skips: number;
}
export interface CacheEntry<T> { value?: T; bytes: number }
export class RenderCache {
  private entries = new Map<CacheEntry<unknown>, undefined>();
  private retainedBytes = 0;
  private hits = 0;
  private misses = 0;
  private builds = 0;
  private evictions = 0;
  private skips = 0;
  private limitBytes: number;
  private maxEntries: number;
  constructor(limitBytes = 8 * 1024 * 1024, maxEntries = 2048) {
    this.limitBytes = limitBytes; this.maxEntries = maxEntries;
    this.setLimit(limitBytes);
  }
  get<T>(entry: CacheEntry<T> | undefined): T | undefined {
    if (entry?.value !== undefined && this.entries.has(entry)) {
      this.hits++;
      this.entries.delete(entry); this.entries.set(entry, undefined);
      return entry.value;
    }
    this.misses++; return undefined;
  }
  put<T>(value: T, rows: readonly string[]): CacheEntry<T> {
    this.builds++;
    const bytes = 512 + rows.reduce((size, row) => size + 64 + row.length * 2, 0);
    const entry: CacheEntry<T> = { bytes };
    if (bytes > this.limitBytes || !this.maxEntries) { this.skips++; return entry; }
    while (this.entries.size >= this.maxEntries || this.retainedBytes + bytes > this.limitBytes) this.evict();
    entry.value = value; this.entries.set(entry, undefined); this.retainedBytes += bytes;
    return entry;
  }
  drop(entry: CacheEntry<unknown> | undefined) {
    if (!entry) return;
    if (this.entries.delete(entry)) this.retainedBytes -= entry.bytes;
    entry.value = undefined;
  }
  private evict() {
    const entry = this.entries.keys().next().value;
    if (entry) { this.drop(entry); this.evictions++; }
  }
  setLimit(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > 64 * 1024 * 1024) throw new RangeError("Cache limit must be 0–64 MiB");
    this.limitBytes = Math.floor(bytes);
    while (this.retainedBytes > this.limitBytes) this.evict();
  }
  clear() {
    for (const entry of this.entries.keys()) entry.value = undefined;
    this.entries.clear(); this.retainedBytes = 0;
  }
  stats(): CacheStats {
    return { retainedBytes: this.retainedBytes, limitBytes: this.limitBytes, entries: this.entries.size,
      hits: this.hits, misses: this.misses, builds: this.builds, evictions: this.evictions, skips: this.skips };
  }
}
