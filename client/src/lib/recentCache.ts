/** A bounded revisit cache. Eviction never touches the state of mounted views. */
export class RecentCache<K, V> {
  private entries = new Map<K, V>();
  constructor(private capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid cache capacity');
  }
  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (this.entries.has(key)) {
      this.entries.delete(key);
      this.entries.set(key, value!);
    }
    return value;
  }
  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity)
      this.entries.delete(this.entries.keys().next().value!);
  }
}
